import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { createCache } from './cache.js';
import { RANGES, formatDate, resolveRange } from './ranges.js';
import * as mock from './mock.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The live GA client is imported lazily: without credentials the module would
 * still load fine, but keeping it out of the mock path means the sample-data
 * mode never depends on the Google libraries being usable at all.
 */
async function defaultSource() {
  if (config.useMockData) return mock;
  return import('./ga.js');
}

/**
 * Build the app.
 *
 * `source` and `cache` are injectable so tests can count the queries that
 * actually reach Google and drive the clock by hand; production passes
 * neither.
 */
export function createApp({ source, cache = createCache({ ttlMs: config.cacheTtlMs }) } = {}) {
  const app = express();
  app.disable('x-powered-by');

  const backend = source ? async () => source : defaultSource;
  // Report the cadence of the cache actually in use. Reading it from `config`
  // instead would let the two disagree whenever a cache is passed in.
  const { ttlMs: cacheTtlMs } = cache.stats();

  function parseRange(value) {
    const range = String(value || 'monthly').toLowerCase();
    return RANGES.includes(range) ? range : 'monthly';
  }

  /**
   * Cache keys carry the resolved window, not just the range name.
   *
   * "weekly" means a different seven days after midnight, so keying on the name
   * alone would serve yesterday's numbers under today's date labels until the
   * TTL happened to lapse. Including the dates makes the rollover produce a new
   * key, and the old one is pruned on the next write.
   */
  function windowKey(kind, resolved) {
    return `${kind}:${resolved.range}:${formatDate(resolved.current.start)}:${formatDate(resolved.current.end)}`;
  }

  /**
   * The three cached slices. Keying each separately rather than caching whole
   * responses lets /api/headline and /api/overview share the totals they have in
   * common, so a first page load costs five GA queries instead of six.
   */
  async function cachedTotals(resolved) {
    const source = await backend();
    return cache.read(windowKey('totals', resolved), () => source.fetchTotals(resolved));
  }

  async function cachedTrend(resolved) {
    const source = await backend();
    return cache.read(windowKey('trend', resolved), () => source.fetchTrend(resolved));
  }

  async function cachedTopPages(resolved) {
    const source = await backend();
    return cache.read(`${windowKey('pages', resolved)}:${config.topPagesLimit}`, () =>
      source.fetchTopPages(resolved, config.topPagesLimit),
    );
  }

  /**
   * Freshness for a response built from several cached slices: it is only as
   * current as its oldest part, and needs revisiting when its first part expires.
   */
  function freshness(parts) {
    const cachedAt = Math.min(...parts.map((part) => part.cachedAt));
    const expiresAt = Math.min(...parts.map((part) => part.expiresAt));
    return {
      generatedAt: new Date(cachedAt).toISOString(),
      nextRefreshAt: cacheTtlMs > 0 ? new Date(expiresAt).toISOString() : null,
      cacheTtlMinutes: cacheTtlMs / 60000,
    };
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
   * Classify an upstream failure into an HTTP status and a message someone can
   * act on.
   *
   * The raw errors are gRPC status codes and OpenSSL strings — "2 UNKNOWN:
   * ... DECODER routines::unsupported" is what a malformed private key looks
   * like, which tells the reader nothing about what to fix.
   */
  function describeError(error) {
    const raw = error?.message || '';

    if (/DECODER routines|error:1E08010C|asn1 encoding/i.test(raw)) {
      return {
        status: 500,
        message:
          'The service-account private key could not be read. If GA_PRIVATE_KEY is on a single line, its newlines must be written as \\n, and the value must include the BEGIN/END PRIVATE KEY lines.',
      };
    }

    switch (error?.code) {
      case 7: // PERMISSION_DENIED
        return {
          status: 403,
          message:
            'Google Analytics denied access to this property. Add the service-account email as a Viewer on the GA4 property under Admin → Property access management.',
        };
      case 16: // UNAUTHENTICATED
        return {
          status: 403,
          message:
            'Google Analytics rejected the credentials. Check GA_CLIENT_EMAIL and GA_PRIVATE_KEY, and that the Google Analytics Data API is enabled for the project.',
        };
      case 5: // NOT_FOUND
        return {
          status: 404,
          message: `No GA4 property with ID ${config.propertyId}. Use the numeric property ID from Admin → Property details, not the "G-" measurement ID.`,
        };
      case 3: // INVALID_ARGUMENT
        return { status: 400, message: `Google Analytics rejected the query: ${raw}` };
      case 8: // RESOURCE_EXHAUSTED
        return {
          status: 429,
          message: 'This GA4 property has hit its Data API quota. Try again shortly.',
        };
      default:
        return { status: 502, message: raw || 'The Google Analytics API request failed.' };
    }
  }

  function fail(res, error) {
    console.error('[ga]', error);
    const { status, message } = describeError(error);
    res.status(status).json({ error: message });
  }

  /**
   * Run named parts and report each one's fate separately.
   *
   * The panels of this dashboard are independent reports, so one failing query
   * should cost the reader that panel — not the whole page. Promise.all would
   * throw away two good results to report one bad one.
   */
  async function settleParts(entries) {
    const settled = await Promise.all(
      entries.map(async ([name, promise]) => {
        try {
          return [name, { ok: true, entry: await promise }];
        } catch (error) {
          console.error(`[ga] ${name}:`, error);
          return [name, { ok: false, error }];
        }
      }),
    );
    return Object.fromEntries(settled);
  }

  /** The `errors` block a partial response carries, or null when all is well. */
  function errorsFor(parts) {
    const failed = Object.entries(parts).filter(([, part]) => !part.ok);
    if (failed.length === 0) return null;
    return Object.fromEntries(
      failed.map(([name, part]) => [name, { message: describeError(part.error).message }]),
    );
  }

  /**
   * Everything the dashboard needs for one range, in one round trip — the three
   * panels always have to agree with each other, so they are fetched together
   * rather than racing as separate requests.
   */
  /**
   * The server-side cache is the only cache. Letting browsers or proxies keep
   * their own copies would mean viewers ageing out at different times and no way
   * to tell how old a number on screen actually is.
   */
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/overview', async (req, res) => {
    const resolved = resolveRange(parseRange(req.query.range), config.timeZone);

    const parts = await settleParts([
      ['summary', cachedTotals(resolved)],
      ['trend', cachedTrend(resolved)],
      ['topPages', cachedTopPages(resolved)],
    ]);

    const loaded = Object.values(parts).filter((part) => part.ok);

    // Only when there is nothing at all to show does this become an error
    // response; a partial one is still a useful page.
    if (loaded.length === 0) {
      return fail(res, Object.values(parts).find((part) => !part.ok).error);
    }

    const errors = errorsFor(parts);
    res.json({
      meta: {
        ...describe(resolved),
        timeZone: config.timeZone,
        usingMockData: config.useMockData,
        ...(config.useMockData ? { mockReason: config.mockReason } : {}),
        ...freshness(loaded.map((part) => part.entry)),
      },
      summary: parts.summary.ok ? summarise(parts.summary.entry.value) : null,
      trend: parts.trend.ok ? parts.trend.entry.value : null,
      topPages: parts.topPages.ok ? parts.topPages.entry.value : null,
      ...(errors ? { errors } : {}),
    });
  });

  /**
   * The three headline totals are each their own window, so they come from three
   * range resolutions rather than the one the charts are scoped to.
   */
  app.get('/api/headline', async (_req, res) => {
    const windows = Object.fromEntries(
      RANGES.map((range) => [range, resolveRange(range, config.timeZone)]),
    );

    const parts = await settleParts(
      RANGES.map((range) => [range, cachedTotals(windows[range])]),
    );

    const loaded = Object.values(parts).filter((part) => part.ok);
    if (loaded.length === 0) {
      return fail(res, Object.values(parts).find((part) => !part.ok).error);
    }

    const errors = errorsFor(parts);
    res.json({
      meta: {
        timeZone: config.timeZone,
        usingMockData: config.useMockData,
        ...(config.useMockData ? { mockReason: config.mockReason } : {}),
        ...freshness(loaded.map((part) => part.entry)),
      },
      headline: Object.fromEntries(
        RANGES.map((range) => [
          range,
          parts[range].ok
            ? { ...summarise(parts[range].entry.value), window: describe(windows[range]) }
            : null,
        ]),
      ),
      ...(errors ? { errors } : {}),
    });
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      usingMockData: config.useMockData,
      propertyId: config.propertyId || null,
      timeZone: config.timeZone,
      cache: cache.stats(),
    });
  });

  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

  return { app, cache };
}
