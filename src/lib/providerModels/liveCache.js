// Short-lived cache for live provider model listings.
//
// GET /api/providers/[id]/models goes straight to the vendor on every call: no
// cache, no in-flight sharing, no timeout on the direct compatible-provider
// fetches. Opening a provider page twice meant two upstream round trips, and a
// slow vendor turned the page into a hang.
//
// Rules:
//   - only successful (200) bodies are cached;
//   - concurrent misses share one upstream call;
//   - an expired entry is still served when the refresh fails ("stale on error"),
//     because yesterday's model list beats a blank page;
//   - ?refresh=1 bypasses everything.

export const DEFAULT_TTL_MS = 60_000;

const entries = new Map(); // key -> { body, status, cachedAt, expiresAt, inFlight }

export async function withLiveCache(key, loader, { ttlMs = DEFAULT_TTL_MS, refresh = false } = {}) {
  const now = Date.now();
  const entry = entries.get(key);

  if (!refresh && entry?.body !== undefined && entry.expiresAt > now) {
    return { body: entry.body, status: 200, cachedAt: entry.cachedAt, stale: false, cached: true };
  }

  if (!refresh && entry?.inFlight) {
    const shared = await entry.inFlight;
    return { ...shared, cached: true };
  }

  const startedAt = new Date().toISOString();
  const promise = (async () => {
    const result = await loader();
    if (result?.status === 200 && result.body !== undefined) {
      entries.set(key, {
        body: result.body,
        status: 200,
        cachedAt: startedAt,
        expiresAt: Date.now() + ttlMs,
      });
      return { body: result.body, status: 200, cachedAt: startedAt, stale: false, cached: false };
    }
    return { body: result?.body ?? {}, status: result?.status ?? 500, cachedAt: startedAt, stale: false, cached: false };
  })();

  entries.set(key, { ...(entry || {}), inFlight: promise });
  try {
    return await promise;
  } catch (error) {
    // Keep serving the last good listing; an upstream hiccup must not empty
    // the provider page. The flag lets the UI say the data is stale.
    if (entry?.body !== undefined) {
      entries.set(key, { ...entry, inFlight: null, expiresAt: 0 });
      return {
        body: entry.body, status: 200, cachedAt: entry.cachedAt,
        stale: true, cached: true, warning: error?.message || String(error),
      };
    }
    entries.delete(key);
    throw error;
  } finally {
    const stored = entries.get(key);
    if (stored?.inFlight === promise) entries.set(key, { ...stored, inFlight: null });
  }
}

export function invalidateLiveCache(keyPrefix) {
  if (!keyPrefix) {
    entries.clear();
    return;
  }
  for (const key of [...entries.keys()]) {
    if (key.startsWith(keyPrefix)) entries.delete(key);
  }
}

export const __test__ = { entries };