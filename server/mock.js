/**
 * Sample data, so the dashboard is usable before any Google credentials exist.
 *
 * Every number is derived deterministically from the date it belongs to, which
 * means the same day always reports the same figure — reloading the page does
 * not reshuffle the "traffic", and week-over-week deltas stay believable.
 */
import { addDays, bucketKeys, daysBetween, formatDate, parseDate, today } from './ranges.js';
import { config } from './config.js';

/** Small integer hash → the PRNG seed for a given string key. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic [0, 1) for a key. */
function rand(key) {
  const x = Math.sin(hash(key)) * 10000;
  return x - Math.floor(x);
}

const BASELINE = 1450;
const WEEKDAY_SHAPE = [0.62, 1.12, 1.18, 1.15, 1.08, 0.95, 0.6]; // Sun … Sat

/** How much of the current day has elapsed, in the configured timezone. */
function fractionOfDayElapsed() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Never quite zero: a dashboard opened at 00:05 should still show a bar.
  return Math.max(0.02, (get('hour') * 60 + get('minute')) / 1440);
}

/** Visitors on a single civil date. */
function visitorsOn(date) {
  const key = formatDate(date);
  const weekday = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();

  // A slow upward trend so year-over-year comparisons have a direction.
  const daysSinceEpoch = daysBetween({ y: 2023, m: 1, d: 1 }, date);
  const growth = 1 + daysSinceEpoch * 0.00042;

  // A gentle annual season on top of the weekly one.
  const season = 1 + 0.16 * Math.sin((2 * Math.PI * daysSinceEpoch) / 365.25);

  const noise = 0.86 + rand(key) * 0.28;

  // Today is only part-done, so it reports part of a day's traffic — the same
  // shape live GA data has. Scaling here rather than in the trend keeps the
  // headline totals and the chart in agreement, since both sum this function.
  const now = today(config.timeZone);
  const inProgress = date.y === now.y && date.m === now.m && date.d === now.d;
  const elapsed = inProgress ? fractionOfDayElapsed() : 1;

  return Math.max(
    0,
    Math.round(BASELINE * WEEKDAY_SHAPE[weekday] * growth * season * noise * elapsed),
  );
}

function windowStats({ start, end }) {
  let visitors = 0;
  const total = daysBetween(start, end);
  for (let i = 0; i <= total; i += 1) {
    visitors += visitorsOn(addDays(start, i));
  }
  return {
    visitors,
    newVisitors: Math.round(visitors * 0.58),
    sessions: Math.round(visitors * 1.34),
    pageViews: Math.round(visitors * 2.71),
  };
}

export function fetchTotals(resolved) {
  return {
    current: windowStats(resolved.current),
    previous: windowStats(resolved.previous),
  };
}

/** Sum a bucket key (a YYYY-MM-DD day, or a YYYYMM month) into one data point. */
function bucketVisitors(key, granularity, windowEnd) {
  if (granularity === 'day') return visitorsOn(parseDate(key));

  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(4, 6));
  const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // The final month of a window is usually partial; counting the whole month
  // would show a phantom spike at the right-hand end of the chart.
  const lastDay = y === windowEnd.y && m === windowEnd.m ? windowEnd.d : lastDayOfMonth;

  let total = 0;
  for (let d = 1; d <= lastDay; d += 1) total += visitorsOn({ y, m, d });
  return total;
}

export function fetchTrend(resolved) {
  const keys = bucketKeys(resolved);
  const previousKeys = bucketKeys({ ...resolved, current: resolved.previous });

  return keys.map((key, i) => {
    const visitors = bucketVisitors(key, resolved.granularity, resolved.current.end);
    const prevKey = previousKeys[i];
    return {
      bucket: key,
      visitors,
      pageViews: Math.round(visitors * 2.71),
      previousVisitors:
        prevKey === undefined
          ? null
          : bucketVisitors(prevKey, resolved.granularity, resolved.previous.end),
      // The final bucket is always still running — today, or the current
      // month. The UI marks it so nobody reads the short bar as a drop.
      partial: i === keys.length - 1,
    };
  });
}

const SAMPLE_PAGES = [
  { path: '/', title: 'Home', weight: 1 },
  { path: '/collections/highlights', title: 'Collection highlights', weight: 0.52 },
  { path: '/tours/city-walk', title: 'City walk audio tour', weight: 0.41 },
  { path: '/exhibitions/current', title: 'Current exhibitions', weight: 0.34 },
  { path: '/visit/opening-hours', title: 'Opening hours & tickets', weight: 0.29 },
  { path: '/stories/behind-the-scenes', title: 'Behind the scenes', weight: 0.21 },
  { path: '/collections/search', title: 'Search the collection', weight: 0.18 },
  { path: '/tours/family-trail', title: 'Family trail', weight: 0.14 },
  { path: '/about', title: 'About us', weight: 0.11 },
  { path: '/contact', title: 'Contact', weight: 0.08 },
  { path: '/support/faq', title: 'Frequently asked questions', weight: 0.06 },
  { path: '/newsletter', title: 'Newsletter signup', weight: 0.04 },
];

export function fetchTopPages(resolved, limit = 10) {
  const { pageViews } = windowStats(resolved.current);
  const weightSum = SAMPLE_PAGES.reduce((sum, p) => sum + p.weight, 0);
  const seed = formatDate(resolved.current.start);

  return SAMPLE_PAGES.map((page) => {
    const share = (page.weight / weightSum) * (0.9 + rand(seed + page.path) * 0.2);
    const views = Math.round(pageViews * share);
    return {
      path: page.path,
      title: page.title,
      views,
      visitors: Math.round(views * (0.42 + rand(page.path) * 0.2)),
      avgEngagementSeconds: 25 + rand(`t${page.path}`) * 145,
    };
  })
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}
