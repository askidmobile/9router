import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: {}, pools: [], fetch: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mocks.settings,
  getProviderConnections: async () => [{ id: "paid", name: "Paid account", isActive: true, apiKey: "fixture-key", providerSpecificData: {} }],
  validateApiKey: vi.fn(), updateProviderConnection: vi.fn(async () => ({})),
}));
vi.mock("@/models", () => ({ getProxyPoolById: async id => mocks.pools.find(pool => pool.id === id) }));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: async () => mocks.settings }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ getAntigravityQuotaCache: () => null, getAntigravityModelQuota: () => null }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({
  noAuth: true,
  execute: async args => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const url = `https://${args.credentials.apiKey ? "paid" : "free"}.fixture.invalid/v1/chat/completions`;
    return { response: await proxyAwareFetch(url, {}, args.proxyOptions), url, headers: {}, transformedBody: null };
  },
}) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({ logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn() }) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(key, "");
  mocks.settings = { providerStrategies: { opencode: { proxyEnabled: true, proxyPoolIds: ["selected"], rotateStrategy: "none" } } };
  mocks.pools = [{ id: "selected", proxyUrl: "http://1.1.1.1:80", isActive: true }];
  mocks.fetch.mockImplementation(async () => Response.json({ id: "fixture", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }] }));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function chat(provider) {
  const { getProviderCredentials } = await import("@/sse/services/auth.js");
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  const credentials = await getProviderCredentials(provider);
  return handleChatCore({ body: { model: "fixture", stream: false, messages: [{ role: "user", content: "hello" }] }, modelInfo: { provider, model: "fixture" }, credentials, rtkEnabled: false, headroomEnabled: false });
}

describe("credentials → chat core → actual proxy transport", () => {
  it("uses the selected proxy for the free provider while the paid provider remains direct", async () => {
    const results = await Promise.all([chat("opencode"), chat("openai")]);
    expect(results.every(result => result.success)).toBe(true);
    const free = mocks.fetch.mock.calls.find(([url]) => String(url).includes("free."));
    const paid = mocks.fetch.mock.calls.find(([url]) => String(url).includes("paid."));
    expect(free[1].dispatcher.constructor.name).toBe("ProxyAgent");
    expect(paid[1].dispatcher.constructor.name).not.toBe("ProxyAgent");
  });

  it("returns an upstream error with exactly one network attempt when the selected proxy fails", async () => {
    mocks.fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await chat("opencode");
    expect(result.success).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not touch the network when the selected proxy is inactive", async () => {
    mocks.pools[0].isActive = false;
    expect((await chat("opencode")).success).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
