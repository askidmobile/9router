import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadRuntimeDep, tlsFetch, createSession } = vi.hoisted(() => ({ loadRuntimeDep: vi.fn(), tlsFetch: vi.fn(), createSession: vi.fn() }));
vi.mock("../../open-sse/services/lazyRuntime.js", () => ({ loadRuntimeDep }));
vi.mock("undici", () => ({
  fetch: (...args) => nativeFetch(...args),
  Agent: class { constructor(options) { this.options = options; } },
  ProxyAgent: class { constructor(options) { this.options = options; } },
}));
let nativeFetch;
beforeEach(() => {
  vi.resetModules();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(key, "");
  nativeFetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", nativeFetch);
  tlsFetch.mockReset().mockImplementation(async () => new Response("{}"));
  createSession.mockReset().mockResolvedValue({ fetch: tlsFetch });
  loadRuntimeDep.mockReset().mockResolvedValue({ createSession });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function execute(proxyOptions = {}) {
  const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
  return new OpenCodeExecutor().execute({
    model: "deepseek-v4.1-flash-free", body: { messages: [{ role: "user", content: "hi" }] },
    credentials: {}, stream: false, requestPolicy: { maxRetries: 0 }, proxyOptions: { useEnvProxy: false, ...proxyOptions },
  });
}

describe("OpenCode transport through the real executor and proxy policy", () => {
  it("uses the TLS adapter on a direct request", async () => {
    expect((await execute()).response.status).toBe(200);
    expect(tlsFetch).toHaveBeenCalledOnce();
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it("uses the selected proxy inside the TLS adapter", async () => {
    expect((await execute({ enabled: true, url: "http://127.0.0.1:3128", strictProxy: true })).response.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ proxy: "http://127.0.0.1:3128" }));
    expect(tlsFetch).toHaveBeenCalledOnce();
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it("refuses an unavailable required proxy before loading TLS", async () => {
    await expect(execute({ proxyRequired: true })).rejects.toThrow("direct connection is disabled");
    expect(loadRuntimeDep).not.toHaveBeenCalled();
    expect(nativeFetch).not.toHaveBeenCalled();
  });
  it("falls back to native fetch only when the optional TLS runtime is absent", async () => {
    loadRuntimeDep.mockRejectedValue(new Error("MODULE_NOT_FOUND"));
    expect((await execute()).response.status).toBe(200);
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(tlsFetch).not.toHaveBeenCalled();
  });
  it("does not replay a failed TLS request through native fetch", async () => {
    tlsFetch.mockRejectedValue(new Error("fixture TLS transport failure"));
    await expect(execute()).rejects.toThrow("fixture TLS transport failure");
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});
