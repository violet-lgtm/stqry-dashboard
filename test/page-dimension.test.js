/**
 * Choosing the dimension that identifies a "page".
 *
 * `pagePath` does not exist for app/screen data, or for events that arrive
 * without `page_location`; GA answers with the literal string "(not set)" for
 * every row rather than with an error. These tests drive a fake GA client to
 * check the query moves on to a dimension that actually names something.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { namesAnything, queryTopPages } from '../server/ga.js';

/** Build the row shape the GA client returns. */
const row = (...dimensions) => ({
  dimensionValues: dimensions.map((value) => ({ value })),
  metricValues: [{ value: '100' }, { value: '40' }, { value: '900' }],
});

describe('namesAnything', () => {
  test('rejects an all-"(not set)" result — GA has views but not under this dimension', () => {
    assert.equal(namesAnything([row('(not set)'), row('(not set)')]), false);
  });

  test('rejects an empty result', () => {
    assert.equal(namesAnything([]), false);
    assert.equal(namesAnything(undefined), false);
  });

  test('rejects rows whose dimension value is blank', () => {
    assert.equal(namesAnything([row('')]), false);
  });

  test('accepts a result where anything at all is named', () => {
    assert.equal(namesAnything([row('/'), row('/about')]), true);
  });

  test('accepts a partly-"(not set)" result — real names are still worth showing', () => {
    assert.equal(namesAnything([row('(not set)'), row('/pricing')]), true);
  });
});

/** A fake GA that answers per dimension, and records what it was asked. */
function fakeGa(answers) {
  const asked = [];
  const runReport = async (request) => {
    const dimension = request.dimensions[0].name;
    asked.push(dimension);
    const answer = answers[dimension];
    if (answer instanceof Error) throw answer;
    return [{ rows: answer ?? [] }];
  };
  return { runReport, asked };
}

const options = { dateRange: { startDate: '2026-09-01', endDate: '2026-09-08' }, limit: 10 };

describe('queryTopPages', () => {
  test('uses pagePath and stops there when it names real pages', async () => {
    const ga = fakeGa({ pagePath: [row('/', 'Home'), row('/about', 'About')] });

    const { rows, used } = await queryTopPages(ga.runReport, options);

    assert.deepEqual(ga.asked, ['pagePath'], 'no reason to look further');
    assert.equal(used.name, 'pagePath');
    assert.equal(rows.length, 2);
  });

  test('falls through to the screen dimension when pagePath is all "(not set)"', async () => {
    const ga = fakeGa({
      pagePath: [row('(not set)'), row('(not set)')],
      unifiedScreenName: [row('Home screen'), row('Collection detail')],
    });

    const { rows, used } = await queryTopPages(ga.runReport, options);

    assert.deepEqual(ga.asked, ['pagePath', 'unifiedScreenName']);
    assert.equal(used.name, 'unifiedScreenName');
    assert.equal(rows[0].dimensionValues[0].value, 'Home screen');
  });

  test('keeps going to the last candidate if the middle one is also empty', async () => {
    const ga = fakeGa({
      pagePath: [row('(not set)')],
      unifiedScreenName: [],
      unifiedScreenClass: [row('MainActivity')],
    });

    const { used } = await queryTopPages(ga.runReport, options);

    assert.deepEqual(ga.asked, ['pagePath', 'unifiedScreenName', 'unifiedScreenClass']);
    assert.equal(used.name, 'unifiedScreenClass');
  });

  test('a dimension the property rejects is skipped, not fatal', async () => {
    const unsupported = Object.assign(new Error('unsupported dimension'), { code: 3 });
    const ga = fakeGa({ pagePath: unsupported, unifiedScreenName: [row('Home screen')] });

    const { used, rows } = await queryTopPages(ga.runReport, options);

    assert.equal(used.name, 'unifiedScreenName');
    assert.equal(rows.length, 1);
  });

  test('but a rejection with nothing left to try still surfaces', async () => {
    const unsupported = Object.assign(new Error('unsupported dimension'), { code: 3 });
    const ga = fakeGa({
      pagePath: unsupported,
      unifiedScreenName: unsupported,
      unifiedScreenClass: unsupported,
    });

    await assert.rejects(() => queryTopPages(ga.runReport, options), /unsupported dimension/);
  });

  test('a real error is never swallowed by the fallback', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 7 });
    const ga = fakeGa({ pagePath: denied });

    await assert.rejects(() => queryTopPages(ga.runReport, options), /permission denied/);
    assert.deepEqual(ga.asked, ['pagePath'], 'a 403 is not a reason to try other dimensions');
  });

  test('genuinely empty results do not loop forever, and report the last tried', async () => {
    const ga = fakeGa({ pagePath: [], unifiedScreenName: [], unifiedScreenClass: [] });

    const { rows, used } = await queryTopPages(ga.runReport, options);

    assert.equal(rows.length, 0);
    assert.equal(used.name, 'unifiedScreenClass');
  });

  test('a pinned dimension is used alone, with no fallback', async () => {
    const ga = fakeGa({ pagePath: [row('/')], unifiedScreenName: [row('Home')] });

    const { used } = await queryTopPages(ga.runReport, { ...options, pinned: 'unifiedScreenName' });

    assert.deepEqual(ga.asked, ['unifiedScreenName'], 'the pin is respected exactly');
    assert.equal(used.name, 'unifiedScreenName');
  });
});
