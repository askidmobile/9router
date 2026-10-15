import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => []);
vi.mock("undici", () => ({
  Agent: class { constructor(options) { this.options = options; } },
  ProxyAgent: class { constructor(options) { this.options = options; pools.push(this); } },
}));
let fetchMock;
beforeEach(() => {
  vi.resetModules();
  pools.length = 0;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "STRICT_SSL"]) vi.stubEnv(key, "");
  fetchMock = vi.fn(async () => new Response("OK"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("provider proxy transport isolation", () => {
  const config = { connectionProxyEnabled: true, connectionProxyUrl: "http://1.1.1.1:80", strictProxy: true, proxyRequired: true, useEnvProxy: false };

  it("does not replay a failed provider request directly", async () => {
    const { withProxyContext } = await import("../../open-sse/utils/proxyFetch.js");
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(withProxyContext(config, () => fetch("https://fixture.invalid"))).rejects.toThrow("strictProxy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher.options.uri).toBe(config.connectionProxyUrl);
  });

  it("refuses a missing selected proxy before attempting any network or env fallback", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://8.8.8.8:80");
    const { withProxyContext } = await import("../../open-sse/utils/proxyFetch.js");
    await expect(withProxyContext({ ...config, connectionProxyEnabled: false, connectionProxyUrl: "" }, () => fetch("https://fixture.invalid"))).rejects.toThrow("direct connection is disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates simultaneous direct paid-account and proxied free-provider requests", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://8.8.8.8:80");
    const { withProxyContext, proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await Promise.all([
      withProxyContext(config, async () => { await Promise.resolve(); return proxyAwareFetch("https://free.fixture.invalid"); }),
      withProxyContext({ useEnvProxy: false }, async () => { await Promise.resolve(); return fetch("https://paid.fixture.invalid"); }),
    ]);
    const free = fetchMock.mock.calls.find(([url]) => url.includes("free."));
    const paid = fetchMock.mock.calls.find(([url]) => url.includes("paid."));
    expect(free[1].dispatcher.options.uri).toBe(config.connectionProxyUrl);
    expect(paid[1].dispatcher.options?.uri).toBeUndefined();
    expect(pools).toHaveLength(1);
  });

  it("does not accept a NO_PROXY bypass for a required provider proxy", async () => {
    const { withProxyContext } = await import("../../open-sse/utils/proxyFetch.js");
    await expect(withProxyContext({ ...config, connectionNoProxy: "*" }, () => fetch("https://fixture.invalid"))).rejects.toThrow("direct connection is disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps TLS verification mandatory for a required proxy even with STRICT_SSL=false", async () => {
    vi.stubEnv("STRICT_SSL", "false");
    const { withProxyContext } = await import("../../open-sse/utils/proxyFetch.js");
    fetchMock.mockRejectedValue(Object.assign(new Error("certificate failure"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }));
    await expect(withProxyContext(config, () => fetch("https://fixture.invalid"))).rejects.toThrow("strictProxy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let executor legacy URL aliases replace the provider policy", async () => {
    const { withProxyContext, proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const legacy = { enabled: true, url: "http://9.9.9.9:80" };
    await withProxyContext(config, () => proxyAwareFetch("https://fixture.invalid", {}, legacy));
    expect(fetchMock.mock.calls[0][1].dispatcher.options.uri).toBe(config.connectionProxyUrl);
    await withProxyContext({ connectionProxyEnabled: false, useEnvProxy: false }, () => proxyAwareFetch("https://fixture.invalid", {}, legacy));
    expect(fetchMock.mock.calls[1][1].dispatcher.options?.uri).toBeUndefined();
    expect(pools).toHaveLength(1);
  });
});
