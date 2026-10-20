import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Integration through the real chat route (handleChat → handleSingleModelChat)
// with per-account concurrent slots + session affinity. Real modules: model
// resolution (as a provider-node), auth selection, connectionConcurrency,
// sessionAffinity, the chat handler's account loop, chatCore translation to
// the wire request. Replaced: transport (records connectionId per call),
// token refresh, account lock/unlock, key access, persistence, logs.
const mocks = vi.hoisted(() => ({
  transport: vi.fn(), lockAccount: vi.fn(), clearAccount: vi.fn(),
  updateCredentials: vi.fn(), pending: vi.fn(),
  logger: Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine", "tagForSession", "nextTag", "maskKey", "fmtThink"].map((name) => [name, vi.fn()])),
  connections: [],
  settings: { fallbackStrategy: "fill-first", providerStrategies: {} },
}));

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: () => { throw new Error("Unexpected real database access"); } }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.transport }));
vi.mock("../../open-sse/utils/debugLog.js", () => ({ dbg: vi.fn(), isDebugEnabled: () => false }));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => mocks.logger);
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_, creds) => creds, updateProviderCredentials: mocks.updateCredentials,
}));
vi.mock("open-sse/utils/proxyContext.js", () => ({
  withProxyContext: async (_, cb) => cb(),
  getProxyContext: () => null,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_, models) => models,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    connectionProxyPoolId: null,
    vercelRelayUrl: "",
    strictProxy: false,
  }),
  resolveProviderProxyConfig: async () => null,
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mocks.settings,
  getProviderConnections: async () => [...mocks.connections],
  updateProviderConnection: vi.fn(async () => {}),
  getProviderConnectionById: async (id) => ({ ...mocks.connections.find((c) => c.id === id), lastRefreshAt: null }) || null,
  getModelAliases: async () => ({}),
  getProviderNodes: async ({ type } = {}) => !type || type === "openai-compatible"
    ? [{ id: "openai-compatible-chat-test", prefix: "chat-test", type: "openai-compatible" }] : [],
  getComboByName: async () => null,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/modelReasoning.js", () => ({ getModelReasoningCaps: async () => ({}) }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: async () => null }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => Object.fromEntries(["logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse", "logConvertedResponse", "logError"].map((name) => [name, vi.fn()])),
}));

import { handleChat } from "../../src/sse/handlers/chat.js";
import { _resetConcurrency, getInflightCount } from "../../src/sse/services/connectionConcurrency.js";
import { clearSessionAffinity } from "../../src/sse/services/sessionAffinity.js";

const PROVIDER = "openai-compatible-chat-test";
const MODEL = "chat-test/llama3";
const completion = JSON.stringify({ id: "t", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });

function request(model = MODEL, extra = {}, signal) {
  return new Request("http://router.test/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "Calculate seventeen plus twenty five." }], ...extra }),
  });
}

const a = (id, priority, cap) => ({
  id, provider: PROVIDER, authType: "apikey", name: `acct-${id}`, priority, isActive: true,
  createdAt: "2024-01-01", updatedAt: "2024-01-01", apiKey: `test-key-${id}`,
  providerSpecificData: { baseUrl: `https://upstream.test/${id}/v1` },
  ...(cap != null ? { maxConcurrentRequests: cap } : {}),
});

// The executor sends each account's own upstream baseUrl — that identifies the account.
function callsFor(id) {
  return mocks.transport.mock.calls.filter(([url]) => String(url).includes(`/${id}/`)).length;
}

beforeEach(() => {
  _resetConcurrency();
  clearSessionAffinity();
  vi.resetAllMocks();
  mocks.settings = { fallbackStrategy: "fill-first", providerStrategies: {} };
  mocks.connections = [a("acct-a-111", 1, 2), a("acct-b-222", 2, 2)];
  mocks.transport.mockImplementation(async (url, options = {}) =>
    new Response(completion, { status: 200, headers: { "content-type": "application/json" } }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  _resetConcurrency();
  clearSessionAffinity();
  vi.restoreAllMocks();
});

describe("chat path — per-account concurrency + session affinity", () => {
  it("two parallel requests fill account 1, the third spills to account 2", async () => {
    // Account A's first slot gets a deliberately slow upstream so both A slots
    // stay occupied while the third request selects; it must land on B.
    mocks.transport.mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 50));
      return new Response(completion, { status: 200, headers: { "content-type": "application/json" } });
    });
    const p1 = handleChat(request(MODEL));
    const p2 = handleChat(request(MODEL));
    const p3 = handleChat(request(MODEL));
    const responses = await Promise.all([p1, p2, p3]);
    for (const r of responses) expect(r.status).toBe(200);
    await Promise.all(responses.map((r) => r.text()));
    expect(getInflightCount("acct-a-111")).toBe(0);
    expect(getInflightCount("acct-b-222")).toBe(0);
    expect(callsFor("acct-a-111")).toBe(2);
    expect(callsFor("acct-b-222")).toBe(1);
  });

  it("affinity keeps one conversation on the same account across turns", async () => {
    const turn1 = await handleChat(request(MODEL));
    expect(turn1.status).toBe(200);
    await turn1.text();
    expect(mocks.transport).toHaveBeenCalledTimes(1);

    const turn2 = await handleChat(request(MODEL, {
      messages: [
        { role: "user", content: "Calculate seventeen plus twenty five." },
        { role: "assistant", content: "Forty two." },
        { role: "user", content: "Now multiply by two" },
      ],
    }));
    expect(turn2.status).toBe(200);
    await turn2.text();

    const turn3 = await handleChat(request(MODEL, {
      messages: [
        { role: "user", content: "Calculate seventeen plus twenty five." },
        { role: "assistant", content: "Forty two." },
        { role: "user", content: "Now multiply by two" },
        { role: "assistant", content: "Eighty four." },
        { role: "user", content: "Now divide by seven" },
      ],
    }));
    expect(turn3.status).toBe(200);
    await turn3.text();
    expect(callsFor("acct-a-111")).toBe(3);
    expect(callsFor("acct-b-222")).toBe(0);
  });

  it("busy pinned account spills to a free alternative, and the conversation pins to the spill target", async () => {
    mocks.connections = [a("acct-a-111", 1, 1), a("acct-b-222", 2, 2)];

    const [respA, respB] = await Promise.all([
      handleChat(request(MODEL)),
      handleChat(request(MODEL, { messages: [{ role: "user", content: "A completely different topic about database indexes." }] })),
    ]);
    for (const r of [respA, respB]) expect(r.status).toBe(200);
    await Promise.all([respA.text(), respB.text()]);
    expect(callsFor("acct-a-111")).toBe(1);
    expect(callsFor("acct-b-222")).toBe(1);

    const followUp = await handleChat(request(MODEL, {
      messages: [
        { role: "user", content: "A completely different topic about database indexes." },
        { role: "assistant", content: "Sure, database indexes are about B-trees." },
        { role: "user", content: "Why?" },
      ],
    }));
    expect(followUp.status).toBe(200);
    await followUp.text();
    expect(callsFor("acct-b-222")).toBe(2);
    expect(callsFor("acct-a-111")).toBe(1);
  });
});
