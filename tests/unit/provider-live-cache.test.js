import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateLiveCache, withLiveCache } from "@/lib/providerModels/liveCache.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  invalidateLiveCache();
});

describe("withLiveCache", () => {
  it("serves a fresh entry without calling the loader again", async () => {
    const loader = vi.fn(async () => ({ body: { models: [{ id: "a" }] }, status: 200 }));

    const first = await withLiveCache("k", loader, { ttlMs: 1000 });
    const second = await withLiveCache("k", loader, { ttlMs: 1000 });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second.body.models).toHaveLength(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it("shares one upstream call between concurrent misses", async () => {
    let resolveLoader;
    const loader = vi.fn(() => new Promise((resolve) => {
      resolveLoader = () => resolve({ body: { models: [] }, status: 200 });
    }));

    const first = withLiveCache("k", loader, { ttlMs: 1000 });
    const second = withLiveCache("k", loader, { ttlMs: 1000 });
    await Promise.resolve();
    resolveLoader();

    await Promise.all([first, second]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("refetches when the entry expired", async () => {
    const loader = vi.fn(async () => ({ body: { models: [] }, status: 200 }));

    await withLiveCache("k", loader, { ttlMs: 10 });
    await sleep(20);
    await withLiveCache("k", loader, { ttlMs: 10 });

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when refresh is requested", async () => {
    const loader = vi.fn(async () => ({ body: { models: [] }, status: 200 }));

    await withLiveCache("k", loader, { ttlMs: 10_000 });
    await withLiveCache("k", loader, { ttlMs: 10_000, refresh: true });

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure", async () => {
    const loader = vi.fn(async () => ({ body: { error: "nope" }, status: 502 }));

    await withLiveCache("k", loader, { ttlMs: 10_000 });
    const second = await withLiveCache("k", loader, { ttlMs: 10_000 });

    expect(loader).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(502);
  });

  it("serves the last good listing when the refresh throws", async () => {
    const ok = vi.fn(async () => ({ body: { models: [{ id: "a" }] }, status: 200 }));
    await withLiveCache("k", ok, { ttlMs: 5 });
    await sleep(10);

    const failing = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const result = await withLiveCache("k", failing, { ttlMs: 1000 });

    expect(result.status).toBe(200);
    expect(result.stale).toBe(true);
    expect(result.warning).toBe("upstream down");
    expect(result.body.models).toHaveLength(1);
  });

  it("rethrows when there is nothing to serve", async () => {
    const failing = vi.fn(async () => {
      throw new Error("upstream down");
    });

    await expect(withLiveCache("empty", failing, { ttlMs: 10 })).rejects.toThrow("upstream down");
  });
});