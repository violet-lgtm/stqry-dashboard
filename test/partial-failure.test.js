/**
 * What survives when Google returns an error.
 *
 * The panels are independent reports, so a failure in one must cost the reader
 * that panel and nothing else. These tests pin down which parts still arrive,
 * what the reader is told about the missing ones, and that a failure is never
 * held against the cache window.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, countingSource, THIRTY_MINUTES } from './helpers.js';

describe('partial failure', () => {
  test('one failing report does not blank the others', async (t) => {
    const server = await startTestServer({ source: countingSource({ failKinds: ['pages'] }) });
    t.after(() => server.close());

    const response = await server.get('/api/overview?range=monthly');
    const body = await response.json();

    assert.equal(response.status, 200, 'a usable page is not an error response');
    assert.ok(body.summary, 'summary still arrived');
    assert.ok(body.trend, 'trend still arrived');
    assert.equal(body.topPages, null, 'the failed report is explicitly absent');
    assert.match(body.errors.topPages.message, /pages:monthly failed/, 'and says what went wrong');
    assert.ok(!body.errors.trend, 'nothing is reported against a report that worked');
  });

  test('a partial response still reports its freshness', async (t) => {
    const server = await startTestServer({ source: countingSource({ failKinds: ['trend'] }) });
    t.after(() => server.close());

    const body = await (await server.get('/api/overview?range=weekly')).json();
    assert.ok(body.meta.generatedAt, 'freshness comes from the parts that loaded');
    assert.ok(body.meta.nextRefreshAt);
  });

  test('only a total failure is an error response', async (t) => {
    const boom = Object.assign(new Error('everything is down'), { code: 8 });
    const server = await startTestServer({ source: countingSource({ failWith: boom }) });
    t.after(() => server.close());

    const response = await server.get('/api/overview?range=monthly');
    assert.equal(response.status, 429, 'the mapped status for a quota failure');
    assert.match((await response.json()).error, /Data API quota/);
  });

  test('the reports that succeeded are cached, so a retry only refetches the failure', async (t) => {
    const source = countingSource({ failKinds: ['pages'] });
    const server = await startTestServer({ source });
    t.after(() => server.close());

    await server.get('/api/overview?range=weekly');
    assert.deepEqual([...source.calls].sort(), ['pages:weekly', 'totals:weekly', 'trend:weekly']);

    await server.get('/api/overview?range=weekly');
    assert.equal(source.countOf('totals:weekly'), 1, 'a good report stays cached');
    assert.equal(source.countOf('trend:weekly'), 1, 'a good report stays cached');
    assert.equal(source.countOf('pages:weekly'), 2, 'only the failed report is retried');
  });

  test('a failure does not consume the cache window for the reports that worked', async (t) => {
    const source = countingSource({ failKinds: ['pages'] });
    const server = await startTestServer({ source });
    t.after(() => server.close());

    await server.get('/api/overview?range=weekly');
    // Hammer it: the failing report retries every time, the others never do.
    for (let i = 0; i < 20; i += 1) await server.get('/api/overview?range=weekly');

    assert.equal(source.countOf('totals:weekly'), 1);
    assert.equal(source.countOf('trend:weekly'), 1);
    assert.equal(source.countOf('pages:weekly'), 21);
  });

  test('one failing period does not blank the other headline tiles', async (t) => {
    const server = await startTestServer();
    t.after(() => server.close());

    // Warm every period, then make only the weekly window fail on refetch.
    await server.get('/api/headline');
    server.advance(THIRTY_MINUTES + 1);
    server.source.failRanges = ['weekly'];

    const body = await (await server.get('/api/headline')).json();
    assert.equal(body.headline.weekly, null, 'the failed period is absent');
    assert.ok(body.headline.monthly, 'the others still arrive');
    assert.ok(body.headline.yearly);
    assert.ok(body.errors.weekly.message, 'and the reader is told why');
  });

  test('the whole headline failing is still an error response', async (t) => {
    const boom = Object.assign(new Error('nope'), { code: 7 });
    const server = await startTestServer({ source: countingSource({ failWith: boom }) });
    t.after(() => server.close());

    const response = await server.get('/api/headline');
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /Viewer/);
  });
});
