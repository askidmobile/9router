import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pools: [], settings: {}, fetch: vi.fn(), destroy: vi.fn(), create: vi.fn(), update: vi.fn(), save: vi.fn() }));
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  ProxyAgent: class { constructor(options) { this.options = options; } destroy() { mocks.destroy(); return Promise.resolve(); } },
}));
vi.mock("@/lib/db/repos/proxyPoolsRepo.js", () => ({
  getProxyPools: async () => mocks.pools, createProxyPool: mocks.create, updateProxyPool: mocks.update, pruneUnusedFreeProxies: vi.fn(),
}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: async () => mocks.settings, updateSettings: mocks.save }));

const { isPublicProxyIp, parseFreeProxies, syncFreeProxies, testFreeProxy, getFreeProxySyncState, startFreeProxySync, FREE_PROXY_INTERVAL_MS } = await import("@/lib/network/freeProxies.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pools = [];
  mocks.settings = {};
  mocks.fetch.mockImplementation(async (url, options = {}) => {
    if (String(url).includes("proxifly.dev")) return Response.json({ ip: "1.1.1.1", port: 8080, protocol: "http" });
    if (String(url).includes("githubusercontent.com")) return new Response("1.0.0.1:3128\n127.0.0.1:80\n1.0.0.1:3128\n");
    return Response.json({ ip: options.dispatcher ? "9.9.9.9" : "8.8.4.4" });
  });
  mocks.create.mockImplementation(async pool => { const next = { ...pool, id: String(mocks.pools.length), isActive: true }; mocks.pools.push(next); return next; });
  mocks.update.mockResolvedValue({});
  mocks.save.mockResolvedValue({});
});
afterEach(() => {
  clearTimeout(globalThis.__nineRouterFreeProxySync.timer);
  globalThis.__nineRouterFreeProxySync.timer = null;
  vi.useRealTimers();
});

describe("free proxy discovery and validation", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.20.1.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.2.1", "203.0.113.1", "::1", "::ffff:127.0.0.1", "localhost", "8.8.8.8.attacker.test"])("rejects non-public literal endpoint %s", host => {
    expect(isPublicProxyIp(host)).toBe(false);
  });

  it("normalizes source shapes, deduplicates, and rejects unsupported protocols and ports", () => {
    const good = { ip: "1.1.1.1", port: "8080", protocol: "http" };
    expect(parseFreeProxies("proxifly", { proxies: [good, good, { ...good, port: 65536 }, { ...good, protocol: "socks5" }] })).toEqual([{ source: "proxifly", proxyUrl: "http://1.1.1.1:8080" }]);
    expect(parseFreeProxies("proxifly", good)).toHaveLength(1);
    expect(parseFreeProxies("iplocate", "#comment\n1.0.0.1:80\n1.0.0.1:80\n10.1.1.1:80")).toHaveLength(1);
  });

  it("imports only tested endpoints without assigning any provider or global proxy settings", async () => {
    const result = await syncFreeProxies();
    expect(result).toMatchObject({ added: 2, checked: 2, working: 2, errors: [] });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ managedBy: "free-proxy-sync", strictProxy: true, testStatus: "active", exitIp: "9.9.9.9" }));
    expect(mocks.save).toHaveBeenCalledWith({ freeProxyLastSync: result });
    const calls = mocks.fetch.mock.calls.filter(([, options]) => options?.dispatcher);
    expect(calls).toHaveLength(2);
    expect(calls[0][1].dispatcher.options.requestTls.rejectUnauthorized).toBe(true);
    expect(calls[0][1].redirect).toBe("error");
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });

  it("does not import failed probes or probes returning the direct IP", async () => {
    mocks.fetch.mockImplementation(async (url, options = {}) => {
      if (String(url).includes("proxifly.dev")) return Response.json({ ip: "1.1.1.1", port: 80, protocol: "http" });
      if (String(url).includes("githubusercontent.com")) return new Response("1.0.0.1:80");
      if (options.dispatcher?.options.uri.includes("1.0.0.1")) throw new Error("ECONNREFUSED");
      return Response.json({ ip: "8.8.4.4" });
    });
    expect(await syncFreeProxies()).toMatchObject({ added: 0, checked: 2, working: 0 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("isolates a broken source and never overwrites a manually added duplicate", async () => {
    mocks.pools = [{ id: "manual", proxyUrl: "http://1.0.0.1:3128", isActive: true }];
    mocks.fetch.mockImplementation(async (url) => String(url).includes("proxifly.dev") ? new Response("fail", { status: 503 }) : String(url).includes("githubusercontent.com") ? new Response("1.0.0.1:3128") : Response.json({ ip: "8.8.4.4" }));
    expect(await syncFreeProxies()).toMatchObject({ added: 0, sources: { proxifly: { error: "HTTP 503" }, iplocate: { fetched: 1 } } });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rechecks existing managed endpoints even if neither source lists them", async () => {
    mocks.pools = [{ id: "old", source: "proxifly", proxyUrl: "http://1.1.1.2:80", managedBy: "free-proxy-sync", isActive: true }];
    mocks.fetch.mockImplementation(async (url, options = {}) => {
      if (String(url).includes("proxifly.dev")) return Response.json([]);
      if (String(url).includes("githubusercontent.com")) return new Response("");
      if (options.dispatcher) throw new Error("dead");
      return Response.json({ ip: "8.8.4.4" });
    });
    await syncFreeProxies();
    expect(mocks.update).toHaveBeenCalledWith("old", expect.objectContaining({ isActive: false, autoDisabled: true, testStatus: "error" }));
  });

  it("does not reactivate a proxy disabled by the user", async () => {
    mocks.pools = [{ id: "off", source: "proxifly", proxyUrl: "http://1.1.1.1:8080", managedBy: "free-proxy-sync", isActive: false }];
    await syncFreeProxies();
    expect(mocks.update).toHaveBeenCalledWith("off", expect.objectContaining({ isActive: false, testStatus: "active" }));
  });

  it("rejects unsafe probe URLs before any network call", async () => {
    expect(await testFreeProxy("http://169.254.169.254:80", "8.8.4.4")).toMatchObject({ ok: false });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not overlap two sync cycles", async () => {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    mocks.fetch.mockImplementation(async () => { await wait; return Response.json([]); });
    const first = syncFreeProxies();
    expect(getFreeProxySyncState().running).toBe(true);
    expect(await syncFreeProxies()).toBeUndefined();
    release();
    await first;
    expect(getFreeProxySyncState().running).toBe(false);
  });

  it("refreshes on the startup timer and honors disabling subsequent automatic cycles", async () => {
    vi.useFakeTimers();
    startFreeProxySync();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.fetch).toHaveBeenCalled();
    const count = mocks.fetch.mock.calls.length;
    mocks.settings.freeProxyAutoSync = false;
    await vi.advanceTimersByTimeAsync(FREE_PROXY_INTERVAL_MS);
    expect(mocks.fetch).toHaveBeenCalledTimes(count);
  });
});
