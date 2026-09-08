import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { config } from './config.js';
import { bucketKeys, formatDate } from './ranges.js';

let client;
function getClient() {
  if (!client) {
    client = new BetaAnalyticsDataClient(
      config.credentials ? { credentials: config.credentials } : {},
    );
  }
  return client;
}

const property = () => `properties/${config.propertyId}`;

const asDateRange = ({ start, end }, name) => ({
  startDate: formatDate(start),
  endDate: formatDate(end),
  ...(name ? { name } : {}),
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Headline totals for a window and the equivalent window before it.
 *
 * Both windows go in one request as two named date ranges; GA then appends a
 * `dateRange` dimension to every row telling us which window the row belongs
 * to, which is why we read the range name off the last dimension value.
 */
export async function fetchTotals(resolved) {
  const [response] = await getClient().runReport({
    property: property(),
    dateRanges: [
      asDateRange(resolved.current, 'current'),
      asDateRange(resolved.previous, 'previous'),
    ],
    metrics: [
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'sessions' },
      { name: 'screenPageViews' },
    ],
  });

  const empty = { visitors: 0, newVisitors: 0, sessions: 0, pageViews: 0 };
  const totals = { current: { ...empty }, previous: { ...empty } };

  for (const row of response.rows || []) {
    const which = row.dimensionValues?.at(-1)?.value;
    if (which !== 'current' && which !== 'previous') continue;
    totals[which] = {
      visitors: num(row.metricValues?.[0]?.value),
      newVisitors: num(row.metricValues?.[1]?.value),
      sessions: num(row.metricValues?.[2]?.value),
      pageViews: num(row.metricValues?.[3]?.value),
    };
  }

  return totals;
}

/**
 * The visitor trend, bucketed by day or by month depending on the range.
 *
 * We ask GA for both windows at once and then re-project each onto the
 * complete list of buckets, so a day with no traffic reads as 0 instead of
 * vanishing and pulling the line across the gap.
 */
export async function fetchTrend(resolved) {
  const dimension = resolved.granularity === 'month' ? 'yearMonth' : 'date';

  const [response] = await getClient().runReport({
    property: property(),
    dateRanges: [
      asDateRange(resolved.current, 'current'),
      asDateRange(resolved.previous, 'previous'),
    ],
    dimensions: [{ name: dimension }],
    metrics: [{ name: 'totalUsers' }, { name: 'screenPageViews' }],
    orderBys: [{ dimension: { dimensionName: dimension } }],
    limit: 100000,
  });

  const byWindow = { current: new Map(), previous: new Map() };
  for (const row of response.rows || []) {
    const key = row.dimensionValues?.[0]?.value;
    const which = row.dimensionValues?.at(-1)?.value;
    if (!key || (which !== 'current' && which !== 'previous')) continue;
    byWindow[which].set(normaliseKey(key, resolved.granularity), {
      visitors: num(row.metricValues?.[0]?.value),
      pageViews: num(row.metricValues?.[1]?.value),
    });
  }

  const keys = bucketKeys(resolved);
  // The previous window has its own bucket keys but the same count, so we line
  // the two up by position — that is what makes them comparable on one axis.
  const previousKeys = bucketKeys({ ...resolved, current: resolved.previous });

  return keys.map((key, i) => {
    const cur = byWindow.current.get(key) || { visitors: 0, pageViews: 0 };
    const prev = byWindow.previous.get(previousKeys[i]) || { visitors: 0, pageViews: 0 };
    return {
      bucket: key,
      visitors: cur.visitors,
      pageViews: cur.pageViews,
      previousVisitors: previousKeys[i] === undefined ? null : prev.visitors,
      // The final bucket is always still running — today, or the current
      // month. The UI marks it so nobody reads the short bar as a drop.
      partial: i === keys.length - 1,
    };
  });
}

/** GA returns `date` as YYYYMMDD; our day buckets are YYYY-MM-DD. */
function normaliseKey(key, granularity) {
  if (granularity === 'month') return key;
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
}

/** The most-visited pages in a window, ordered by views. */
export async function fetchTopPages(resolved, limit = config.topPagesLimit) {
  const [response] = await getClient().runReport({
    property: property(),
    dateRanges: [asDateRange(resolved.current)],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'totalUsers' },
      { name: 'userEngagementDuration' },
    ],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit,
  });

  return (response.rows || []).map((row) => {
    const views = num(row.metricValues?.[0]?.value);
    const engagementSeconds = num(row.metricValues?.[2]?.value);
    return {
      path: row.dimensionValues?.[0]?.value || '(not set)',
      title: row.dimensionValues?.[1]?.value || '',
      views,
      visitors: num(row.metricValues?.[1]?.value),
      // GA reports engagement as a total across the window; per-view is the
      // number people actually mean by "time on page".
      avgEngagementSeconds: views > 0 ? engagementSeconds / views : 0,
    };
  });
}
