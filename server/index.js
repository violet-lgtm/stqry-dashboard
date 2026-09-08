import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { RANGES, formatDate, resolveRange } from './ranges.js';
import * as mock from './mock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');

/**
 * The live GA client is imported lazily: without credentials the module would
 * still load fine, but keeping it out of the mock path means the sample-data
 * mode never depends on the Google libraries being usable at all.
 */
async function backend() {
  if (config.useMockData) return mock;
  return import('./ga.js');
}

function parseRange(value) {
  const range = String(value || 'monthly').toLowerCase();
  return RANGES.includes(range) ? range : 'monthly';
}

function percentChange(current, previous) {
  if (!previous) return null; // No baseline — "+100%" from zero is meaningless.
  return ((current - previous) / previous) * 100;
}

function summarise(totals) {
  return {
    ...totals.current,
    previous: totals.previous,
    change: {
      visitors: percentChange(totals.current.visitors, totals.previous.visitors),
      sessions: percentChange(totals.current.sessions, totals.previous.sessions),
      pageViews: percentChange(totals.current.pageViews, totals.previous.pageViews),
    },
  };
}

const describe = (resolved) => ({
  range: resolved.range,
  granularity: resolved.granularity,
  current: { start: formatDate(resolved.current.start), end: formatDate(resolved.current.end) },
  previous: { start: formatDate(resolved.previous.start), end: formatDate(resolved.previous.end) },
});

/**
 * Turn the API's failures into something a person can act on.
 *
 * The raw errors are gRPC status codes and OpenSSL strings — "2 UNKNOWN:
 * ... DECODER routines::unsupported" is what a malformed private key looks
 * like, which tells the reader nothing about what to fix.
 */
function fail(res, error) {
  console.error('[ga]', error);

  const raw = error?.message || '';

  if (/DECODER routines|error:1E08010C|asn1 encoding/i.test(raw)) {
    return res.status(500).json({
      error:
        'The service-account private key could not be read. If GA_PRIVATE_KEY is on a single line, its newlines must be written as \\n, and the value must include the BEGIN/END PRIVATE KEY lines.',
    });
  }

  switch (error?.code) {
    case 7: // PERMISSION_DENIED
      return res.status(403).json({
        error:
          'Google Analytics denied access to this property. Add the service-account email as a Viewer on the GA4 property under Admin → Property access management.',
      });
    case 16: // UNAUTHENTICATED
      return res.status(403).json({
        error:
          'Google Analytics rejected the credentials. Check GA_CLIENT_EMAIL and GA_PRIVATE_KEY, and that the Google Analytics Data API is enabled for the project.',
      });
    case 5: // NOT_FOUND
      return res.status(404).json({
        error: `No GA4 property with ID ${config.propertyId}. Use the numeric property ID from Admin → Property details, not the "G-" measurement ID.`,
      });
    case 3: // INVALID_ARGUMENT
      return res.status(400).json({ error: `Google Analytics rejected the query: ${raw}` });
    case 8: // RESOURCE_EXHAUSTED
      return res.status(429).json({
        error: 'This GA4 property has hit its Data API quota. Try again shortly.',
      });
    default:
      return res.status(502).json({ error: raw || 'The Google Analytics API request failed.' });
  }
}

/**
 * Everything the dashboard needs for one range, in one round trip — the three
 * panels always have to agree with each other, so they are fetched together
 * rather than racing as separate requests.
 */
app.get('/api/overview', async (req, res) => {
  const resolved = resolveRange(parseRange(req.query.range), config.timeZone);
  try {
    const source = await backend();
    const [totals, trend, topPages] = await Promise.all([
      source.fetchTotals(resolved),
      source.fetchTrend(resolved),
      source.fetchTopPages(resolved, config.topPagesLimit),
    ]);

    res.json({
      meta: {
        ...describe(resolved),
        timeZone: config.timeZone,
        usingMockData: config.useMockData,
        ...(config.useMockData ? { mockReason: config.mockReason } : {}),
        generatedAt: new Date().toISOString(),
      },
      summary: summarise(totals),
      trend,
      topPages,
    });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * The three headline totals are each their own window, so they come from three
 * range resolutions rather than the one the charts are scoped to.
 */
app.get('/api/headline', async (_req, res) => {
  try {
    const source = await backend();
    const entries = await Promise.all(
      RANGES.map(async (range) => {
        const resolved = resolveRange(range, config.timeZone);
        const totals = await source.fetchTotals(resolved);
        return [range, { ...summarise(totals), window: describe(resolved) }];
      }),
    );

    res.json({
      meta: {
        timeZone: config.timeZone,
        usingMockData: config.useMockData,
        ...(config.useMockData ? { mockReason: config.mockReason } : {}),
      },
      headline: Object.fromEntries(entries),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    usingMockData: config.useMockData,
    propertyId: config.propertyId || null,
    timeZone: config.timeZone,
  });
});

app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

app.listen(config.port, () => {
  console.log(`stqry-dashboard listening on http://localhost:${config.port}`);
  if (config.useMockData) console.log(`[mock] ${config.mockReason}`);
  else console.log(`[ga] querying GA4 property ${config.propertyId} (${config.timeZone})`);
});
