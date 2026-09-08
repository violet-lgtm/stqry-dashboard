/**
 * A demand-driven cache with a fixed TTL.
 *
 * Nothing in here runs on a timer. An entry is only ever produced or refreshed
 * because a request asked for it, so an idle dashboard makes no upstream calls
 * at all — there is no point keeping data warm for nobody.
 *
 * Two properties matter beyond the plain hit/miss:
 *
 *  - Concurrent misses on one key share a single in-flight promise, so ten
 *    people opening the dashboard at the same moment cost one GA query rather
 *    than ten.
 *  - Failures are never cached. A rejected producer clears its slot so the next
 *    request retries, instead of serving an error for the rest of the TTL.
 */
export function createCache({ ttlMs, now = Date.now }) {
  /** key -> { value, cachedAt, expiresAt } */
  const entries = new Map();
  /** key -> Promise of the entry currently being produced */
  const inFlight = new Map();

  /** Drop anything already expired. The key space is small, so this is cheap. */
  function prune(at) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  }

  /**
   * Read `key`, producing it if absent or stale.
   * Resolves to `{ value, cachedAt, expiresAt }` — callers need the timestamps
   * to tell the client how old the data is and when to come back.
   */
  async function read(key, produce) {
    if (ttlMs <= 0) {
      const value = await produce();
      const at = now();
      return { value, cachedAt: at, expiresAt: at };
    }

    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) return hit;

    let pending = inFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const value = await produce();
        const at = now();
        prune(at);
        const entry = { value, cachedAt: at, expiresAt: at + ttlMs };
        entries.set(key, entry);
        return entry;
      })();

      // Free the slot however it settles: on success the value now lives in
      // `entries`, and on failure the next caller should get a fresh attempt.
      pending
        .catch(() => {})
        .finally(() => {
          if (inFlight.get(key) === pending) inFlight.delete(key);
        });

      inFlight.set(key, pending);
    }

    return pending;
  }

  return {
    read,
    stats: () => ({ ttlMs, entries: entries.size, inFlight: inFlight.size }),
    clear: () => {
      entries.clear();
      inFlight.clear();
    },
  };
}
