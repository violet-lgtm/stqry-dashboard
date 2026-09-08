/**
 * The cache's own contract, tested directly rather than through HTTP.
 *
 * These are the properties the quota guarantee rests on; `quota.test.js`
 * checks that the API actually gets them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createCache } from '../server/cache.js';

/** A producer that counts its calls and can be made to fail. */
function counter({ delayMs = 0 } = {}) {
  let calls = 0;
  let fail = null;
  const produce = async () => {
    calls += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail) throw fail;
    return `value-${calls}`;
  };
  return {
    produce,
    get calls() {
      return calls;
    },
    failWith(error) {
      fail = error;
    },
  };
}

describe('createCache', () => {
  test('produces once, then serves the stored value', async () => {
    const cache = createCache({ ttlMs: 60_000 });
    const c = counter();

    const first = await cache.read('k', c.produce);
    const second = await cache.read('k', c.produce);

    assert.equal(c.calls, 1);
    assert.equal(second.value, first.value);
    assert.equal(second.cachedAt, first.cachedAt);
  });

  test('concurrent misses share one in-flight production', async () => {
    const cache = createCache({ ttlMs: 60_000 });
    const c = counter({ delayMs: 20 });

    const results = await Promise.all(Array.from({ length: 25 }, () => cache.read('k', c.produce)));

    assert.equal(c.calls, 1, 'a stampede must not multiply upstream calls');
    assert.equal(new Set(results.map((r) => r.value)).size, 1, 'everyone gets the same value');
  });

  test('reproduces once the entry expires, and not before', async () => {
    let now = 0;
    const cache = createCache({ ttlMs: 1000, now: () => now });
    const c = counter();

    await cache.read('k', c.produce);
    now = 999;
    await cache.read('k', c.produce);
    assert.equal(c.calls, 1, 'still fresh');

    now = 1001;
    await cache.read('k', c.produce);
    assert.equal(c.calls, 2, 'expired, so produced again');
  });

  test('does not cache failures', async () => {
    const cache = createCache({ ttlMs: 60_000 });
    const c = counter();
    c.failWith(new Error('upstream down'));

    await assert.rejects(() => cache.read('k', c.produce), /upstream down/);

    c.failWith(null);
    const recovered = await cache.read('k', c.produce);
    assert.equal(recovered.value, 'value-2', 'the retry produced a real value');
    assert.equal(c.calls, 2);
  });

  test('a failed production rejects every concurrent caller, then clears', async () => {
    const cache = createCache({ ttlMs: 60_000 });
    const c = counter({ delayMs: 10 });
    c.failWith(new Error('boom'));

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => cache.read('k', c.produce)),
    );
    assert.ok(settled.every((s) => s.status === 'rejected'));
    assert.equal(c.calls, 1);

    c.failWith(null);
    await cache.read('k', c.produce);
    assert.equal(c.calls, 2, 'the slot was freed for a retry');
  });

  test('prunes expired entries instead of growing without bound', async () => {
    let now = 0;
    const cache = createCache({ ttlMs: 100, now: () => now });
    const c = counter();

    for (let i = 0; i < 20; i += 1) {
      now = i * 500; // each key is long expired by the time the next is written
      await cache.read(`key-${i}`, c.produce);
    }

    assert.equal(cache.stats().entries, 1, 'only the newest entry survives');
  });

  test('ttlMs of 0 disables caching', async () => {
    const cache = createCache({ ttlMs: 0 });
    const c = counter();

    await cache.read('k', c.produce);
    await cache.read('k', c.produce);

    assert.equal(c.calls, 2);
    assert.equal(cache.stats().entries, 0, 'nothing is stored at all');
  });

  test('keys are independent', async () => {
    const cache = createCache({ ttlMs: 60_000 });
    const c = counter();

    await cache.read('a', c.produce);
    await cache.read('b', c.produce);
    await cache.read('a', c.produce);

    assert.equal(c.calls, 2);
  });
});
