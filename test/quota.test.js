/**
 * The quota guarantee.
 *
 * The property under test is NOT "one GA request per half hour" flat — a page
 * asks five distinct questions (totals for each of the three headline periods,
 * plus a trend and a top-pages list for the selected range), and those are
 * five different reports. What holds is stronger and more useful:
 *
 *     each distinct report is fetched at most once per cache window,
 *     no matter how many people load the page or how often.
 *
 * Every assertion below counts calls that reach the backend, which is exactly
 * what would have cost GA quota.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, countingSource, THIRTY_MINUTES } from './helpers.js';

describe('GA request rate', () => {
  test('a cold page load makes exactly five GA queries, one per distinct report', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    await server.pageLoad('monthly');

    assert.equal(server.source.total, 5);
    assert.deepEqual(
      [...server.source.calls].sort(),
      // Three headline totals; the monthly one is shared with the overview
      // rather than fetched twice.
      ['pages:monthly', 'totals:monthly', 'totals:weekly', 'totals:yearly', 'trend:monthly'].sort(),
    );
    assert.equal(server.source.countOf('totals:monthly'), 1, 'monthly totals must not be fetched twice');
  });

  test('100 page loads inside one window still make only those five queries', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    for (let i = 0; i < 100; i += 1) await server.pageLoad('monthly');

    assert.equal(server.source.total, 5);
  });

  test('50 simultaneous cold loads collapse to the same five queries', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    // The stampede case: everyone arrives at once, cache empty, nothing to hit.
    await Promise.all(Array.from({ length: 50 }, () => server.pageLoad('monthly')));

    assert.equal(server.source.total, 5);
  });

  test('each report is fetched exactly once per half hour over a simulated day', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    // A busy dashboard: someone loads it every minute for 24 hours.
    const minutes = 24 * 60;
    for (let minute = 0; minute < minutes; minute += 1) {
      await server.pageLoad('monthly');
      server.advance(60 * 1000);
    }

    // 24 hours / 30 minutes = 48 windows, so 48 fetches of each report.
    const windows = (minutes * 60 * 1000) / THIRTY_MINUTES;
    assert.equal(windows, 48);
    for (const report of ['totals:weekly', 'totals:monthly', 'totals:yearly', 'trend:monthly', 'pages:monthly']) {
      assert.equal(server.source.countOf(report), windows, `${report} should be fetched once per window`);
    }
    assert.equal(server.source.total, 5 * windows);

    // 1,440 page loads cost 240 GA queries rather than 7,200.
    assert.equal(server.source.total, 240);
  });

  test('a report is refetched only after its window lapses, not a moment before', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    await server.get('/api/overview?range=weekly');
    const afterFirst = server.source.total;

    server.advance(THIRTY_MINUTES - 1);
    await server.get('/api/overview?range=weekly');
    assert.equal(server.source.total, afterFirst, 'still inside the window: no new queries');

    server.advance(2);
    await server.get('/api/overview?range=weekly');
    assert.equal(server.source.total, afterFirst * 2, 'window lapsed: each report fetched once more');
  });

  test('an idle dashboard makes no queries at all', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    // A whole day passes with nobody opening the page.
    server.advance(24 * 60 * 60 * 1000);

    assert.equal(server.source.total, 0, 'nothing should refresh a cache nobody is reading');
  });

  test('browsing all three ranges costs nine queries, then nothing', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    for (const range of ['weekly', 'monthly', 'yearly']) {
      await server.pageLoad(range);
    }
    // 3 shared totals + a trend and a top-pages per range.
    assert.equal(server.source.total, 9);

    for (const range of ['weekly', 'monthly', 'yearly', 'weekly']) {
      await server.pageLoad(range);
    }
    assert.equal(server.source.total, 9, 'revisiting a range must not requery it');
  });

  test('a GA failure is not cached, and does not burn the window', async (t) => {
    const boom = Object.assign(new Error('upstream down'), { code: 14 });
    const source = countingSource({ failWith: boom });
    const server = await startTestServer({ source });
    t.after(() => server.close());

    const failed = await server.get('/api/overview?range=weekly');
    assert.equal(failed.status, 502);
    const afterFailure = source.total;
    assert.ok(afterFailure > 0);

    // Recover, then ask again inside the same window: it must retry rather
    // than serve the error for the next half hour.
    source.failWith = null;
    const retried = await server.get('/api/overview?range=weekly');
    assert.equal(retried.status, 502, 'the counting source is still configured to fail');
    assert.ok(source.total > afterFailure, 'a failed report must be retried, not cached');
  });

  test('the served response reports when it was fetched, not when it was served', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    const first = await (await server.get('/api/overview?range=monthly')).json();

    server.advance(10 * 60 * 1000);
    const later = await (await server.get('/api/overview?range=monthly')).json();

    assert.equal(later.meta.generatedAt, first.meta.generatedAt, 'a cache hit keeps the original fetch time');
    assert.equal(later.meta.nextRefreshAt, first.meta.nextRefreshAt);
    // Only /api/overview was called here, which is three reports, not five.
    assert.equal(server.source.total, 3, 'reading the timestamps must not trigger a fetch');
  });

  test('caching can be turned off, and then every request queries GA', async (t) => {
    const server = await startTestServer({ ttlMs: 0 });
    t.after(() => server.close());

    await server.get('/api/overview?range=weekly');
    await server.get('/api/overview?range=weekly');

    assert.equal(server.source.total, 6, 'three reports per request, twice');
    const body = await (await server.get('/api/overview?range=weekly')).json();
    assert.equal(body.meta.nextRefreshAt, null, 'nothing to come back for when caching is off');
  });

  test('API responses forbid a second, uncoordinated browser cache', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    const response = await server.get('/api/overview?range=monthly');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
