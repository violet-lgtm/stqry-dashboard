import { createApp } from '../server/app.js';
import { createCache } from '../server/cache.js';

const THIRTY_MINUTES = 30 * 60 * 1000;

/**
 * A stand-in for the GA backend that records every query reaching it.
 *
 * This is the only place the tests can observe "a request to Google": the
 * cache sits above it, so anything counted here is a real upstream call that
 * would have spent quota.
 */
export function countingSource(initial = {}) {
  const calls = [];

  /**
   * Failure can be aimed three ways, and the fields stay writable so a test can
   * break or repair the backend mid-run:
   *   failKinds  — only these reports fail ('totals' | 'trend' | 'pages')
   *   failRanges — only these ranges fail ('weekly' | 'monthly' | 'yearly')
   *   failWith   — with neither of the above set, everything fails with this
   */
  const source = {
    failWith: initial.failWith ?? null,
    failKinds: initial.failKinds ?? null,
    failRanges: initial.failRanges ?? null,
    calls,
    get total() {
      return calls.length;
    },
    countOf(prefix) {
      return calls.filter((c) => c.startsWith(prefix)).length;
    },
    reset() {
      calls.length = 0;
    },
    async fetchTotals(resolved) {
      record('totals', resolved);
      return {
        current: { visitors: 100, newVisitors: 50, sessions: 120, pageViews: 300 },
        previous: { visitors: 90, newVisitors: 45, sessions: 110, pageViews: 280 },
      };
    },
    async fetchTrend(resolved) {
      record('trend', resolved);
      return [
        { bucket: '2026-09-08', visitors: 100, pageViews: 300, previousVisitors: 90, partial: true },
      ];
    },
    async fetchTopPages(resolved) {
      record('pages', resolved);
      return [{ path: '/', title: 'Home', views: 300, visitors: 100, avgEngagementSeconds: 42 }];
    },
  };

  function record(kind, resolved) {
    calls.push(`${kind}:${resolved.range}`);
    const byKind = source.failKinds?.includes(kind) ?? false;
    const byRange = source.failRanges?.includes(resolved.range) ?? false;
    const blanket = !source.failKinds && !source.failRanges && Boolean(source.failWith);
    if (byKind || byRange || blanket) {
      throw (
        source.failWith || Object.assign(new Error(`${kind}:${resolved.range} failed`), { code: 14 })
      );
    }
  }

  return source;
}

/**
 * Boot the app on an ephemeral port with a hand-driven clock, so a test can
 * jump forward half an hour without waiting for one.
 */
export async function startTestServer({ ttlMs = THIRTY_MINUTES, source = countingSource() } = {}) {
  const clock = { now: Date.now() };
  const cache = createCache({ ttlMs, now: () => clock.now });
  const { app } = createApp({ source, cache });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    source,
    cache,
    base,
    /** Move the clock forward, as if time had passed with no requests made. */
    advance(ms) {
      clock.now += ms;
    },
    get(path) {
      return fetch(`${base}${path}`);
    },
    /** One page load: exactly what the browser requests on open. */
    async pageLoad(range = 'monthly') {
      const [headline, overview] = await Promise.all([
        fetch(`${base}/api/headline`),
        fetch(`${base}/api/overview?range=${range}`),
      ]);
      return { headline, overview };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export { THIRTY_MINUTES };
