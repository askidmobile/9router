import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => []);
vi.mock("undici", () => ({
  Agent: class { constructor(options) { this.options = options; this.dispatch = vi.fn(); pools.push(this); } },
  ProxyAgent: class { constructor(options) { this.options = options; this.dispatch = vi.fn(); pools.push(this); } },
}));
let fetchMock;
beforeEach(() => {
  vi.resetModules(); pools.length = 0;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "STRICT_SSL"]) vi.stubEnv(key, "");
  fetchMock = vi.fn().mockRejectedValueOnce(Object.assign(new Error("certificate failure"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }))
    .mockResolvedValueOnce(new Response("OK"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("release proxy TLS and queued-request timeouts", () => {
  it("preserves certificate verification by default without a silent retry", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await expect(proxyAwareFetch("https://fixture.invalid/v1/responses")).rejects.toThrow("certificate failure");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pools).toHaveLength(1);
    expect(pools[0].options.connect?.rejectUnauthorized).not.toBe(false);
  });

  it("retains pool limits and per-request Flex timeouts on an explicitly allowed TLS retry", async () => {
    vi.stubEnv("STRICT_SSL", "false");
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const response = await proxyAwareFetch("https://fixture.invalid/v1/responses", { headersTimeout: 3600000, bodyTimeout: 3600000 });
    expect(await response.text()).toBe("OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = pools[1];
    expect(retry.options.connect.rejectUnauthorized).toBe(false);
    expect(retry.options.connections).toBeGreaterThan(0);
    const dispatcher = fetchMock.mock.calls[1][1].dispatcher;
    dispatcher.dispatch({}, {});
    expect(retry.dispatch).toHaveBeenCalledWith(expect.objectContaining({ headersTimeout: 3600000, bodyTimeout: 3600000 }), {});
  });
});
