import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Public route -> real model resolver -> Combo -> guard -> ChatCore -> real
// executor. Only transport, credentials, persistence, and logs are replaced.
const mocks = vi.hoisted(() => ({
  transport: vi.fn(), credentials: vi.fn(), lockAccount: vi.fn(), clearAccount: vi.fn(),
  updateCredentials: vi.fn(), pending: vi.fn(), freeze: vi.fn(), getHealth: vi.fn(), clear: vi.fn(),
  combos: new Map(), circuits: new Map(), executors: new Map(), settings: {},
  logger: Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine", "tagForSession", "nextTag", "maskKey", "fmtThink"].map((name) => [name, vi.fn()])),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.transport }));
vi.mock("../../open-sse/utils/debugLog.js", () => ({ dbg: vi.fn(), isDebugEnabled: () => false }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: (provider) => mocks.executors.get(provider) }));
vi.mock("../../open-sse/services/comboHealth.js", () => ({ getComboHealth: mocks.getHealth, freezeComboModel: mocks.freeze, clearComboModel: mocks.clear }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.lockAccount,
  clearAccountError: mocks.clearAccount, extractApiKey: () => null, isValidApiKey: async () => true,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_, credentials) => credentials, updateProviderCredentials: mocks.updateCredentials,
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => mocks.logger);
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mocks.settings, getModelAliases: async () => ({}),
  getComboByName: async (name) => mocks.combos.has(name) ? { name, models: mocks.combos.get(name) } : null,
  getProviderConnections: async () => [],
  getProviderNodes: async ({ type } = {}) => !type || type === "openai-compatible"
    ? [{ id: "openai-compatible-chat-test", prefix: "cheaper-test", type: "openai-compatible" }] : [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: async () => null }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: mocks.pending, appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => Object.fromEntries(["logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse", "logConvertedResponse", "logError"].map((name) => [name, vi.fn()])),
}));

import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { handleChat } from "../../src/sse/handlers/chat.js";

const NOW = 1_800_000_000_000;
const MODEL = "z-ai/glm-5.3-flash";
const CUSTOM = "openai-compatible-chat-test";
const RESPONSES = "openai-compatible-responses-test";
const key = (provider, model) => JSON.stringify([provider, model]);
const completion = { id: "test-completion", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] };
const frame = 'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
let cleanup;

function request(model = "combo-health-test", extra = {}, signal) {
  return new Request("http://router.test/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "Calculate seventeen plus twenty five." }], ...extra }),
  });
}
function success(options = {}) {
  const body = typeof options.body === "string" ? JSON.parse(options.body) : {};
  const stream = body.stream || options.headers?.Accept === "text/event-stream";
  return stream ? new Response(frame, { headers: { "content-type": "text/event-stream" } }) : Response.json(completion);
}
async function pumpUntil(predicate) {
  for (let i = 0; i < 30; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (predicate()) return;
  }
  throw new Error("Expected production stage was not reached");
}
function stalledResponse(signal, headersOnly = false, heartbeat = false) {
  if (headersOnly) return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    cleanup.push(() => { signal.removeEventListener("abort", abort); resolve(success()); });
  });
  return new Response(new ReadableStream({
    start(out) {
      if (heartbeat) out.enqueue(new TextEncoder().encode(': keepalive\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
      const abort = () => { try { out.error(signal.reason); } catch { /* already closed */ } };
      signal.addEventListener("abort", abort, { once: true });
      cleanup.push(() => { signal.removeEventListener("abort", abort); try { out.close(); } catch { /* aborted */ } });
    },
  }), { headers: { "content-type": heartbeat ? "text/event-stream" : "application/json" } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  cleanup = [];
  mocks.settings = {};
  mocks.combos.clear(); mocks.circuits.clear(); mocks.executors.clear();
  mocks.combos.set("combo-health-test", [`cmc/${MODEL}`, "openai/gpt-4o-mini"]);
  for (const provider of ["commandcode", "openai", CUSTOM, RESPONSES, "gemini"]) {
    const executor = new DefaultExecutor(provider);
    executor.config = { ...executor.config, timeoutMs: 60_000, retry: { 502: { attempts: 2, delayMs: 1000 } } };
    mocks.executors.set(provider, executor);
  }
  mocks.credentials.mockImplementation(async (provider, excluded) => {
    const account = ["one", "two", "three"].find((id) => !excluded.has(`${provider}-${id}`));
    return account ? { connectionId: `${provider}-${account}`, connectionName: "Test account", apiKey: "test-key",
      providerSpecificData: provider.startsWith("openai-compatible-") ? { baseUrl: "https://custom.test/v1", prefix: "cheaper-test" } : {} } : null;
  });
  mocks.lockAccount.mockResolvedValue({ shouldFallback: true });
  mocks.getHealth.mockImplementation(async (provider, model) => mocks.circuits.get(key(provider, model)) || null);
  mocks.freeze.mockImplementation(async (record) => {
    mocks.circuits.set(key(record.provider, record.model), { ...record, state: "open", failureCount: 1, nextProbeAt: NOW + 60_000 });
  });
  mocks.transport.mockImplementation(async (_, options) => success(options));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected real network request"); }));
});

afterEach(async () => {
  for (const release of cleanup) release();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("Combo health through the public chat route", () => {
  it("freezes a failed provider once, immediately tries the next provider, and skips the frozen pair on a later request", async () => {
    mocks.transport.mockImplementation(async (url, options) => url.includes("commandcode") ? new Response("Unavailable", { status: 502 }) : success(options));
    const first = await handleChat(request());
    expect(first.status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "commandcode", model: MODEL, status: 502 }));
    expect(mocks.credentials.mock.calls.map(([provider]) => provider)).toEqual(["commandcode", "openai"]);
    expect(mocks.lockAccount).not.toHaveBeenCalled();
    expect((await handleChat(request())).status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(3);
    expect(mocks.freeze).toHaveBeenCalledTimes(1);
    expect(mocks.credentials.mock.calls.map(([provider]) => provider)).toEqual(["commandcode", "openai", "openai"]);
  });

  it("retries a member after its cooldown expires and clears the circuit on success", async () => {
    mocks.circuits.set(key("commandcode", MODEL), { state: "open", failureCount: 2, nextProbeAt: NOW - 1000 });
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("OK");
    expect(mocks.credentials.mock.calls.map(([provider]) => provider)).toEqual(["commandcode"]);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith({ provider: "commandcode", model: MODEL });
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it.each([
    ["commandcode", `cmc/${MODEL}`, `commandcode/${MODEL}`],
    [CUSTOM, "cheaper-test/glm-5.3-flash", `${CUSTOM}/glm-5.3-flash`],
  ])("shares a canonical circuit across builtin/custom aliases for %s", async (provider, alias, canonical) => {
    const model = canonical.slice(canonical.indexOf("/") + 1);
    mocks.circuits.set(key(provider, model), { state: "open", nextProbeAt: NOW + 60_000 });
    for (const member of [alias, canonical]) {
      mocks.combos.set("alias-test", [member, "openai/gpt-4o-mini"]);
      expect((await handleChat(request("alias-test"))).status).toBe(200);
    }
    expect(mocks.credentials.mock.calls.map(([id]) => id)).toEqual(["openai", "openai"]);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it("applies the per-Combo CTX OUT cap to member requests", async () => {
    mocks.settings = { comboStrategies: { "combo-health-test": { maxOutput: 24 } } };
    const response = await handleChat(request(undefined, { max_tokens: 4096 }));
    expect(response.status).toBe(200);
    expect(JSON.parse(mocks.transport.mock.calls[0][1].body).max_tokens).toBe(24);
  });

  it("summarizes a multi-member failure instead of returning one opaque provider body", async () => {
    mocks.transport.mockImplementation(async (url) => url.includes("commandcode")
      ? new Response("Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\nfra1::abc-1791703234172", { status: 413 })
      : new Response("Invalid request", { status: 400 }));
    const response = await handleChat(request());
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error.message).toContain("All 2 Combo members failed");
    expect(body.error.message).toContain("413 request body exceeds this provider's limit");
    expect(body.error.message).toContain(`cmc/${MODEL}`);
    expect(body.error.message).toContain("openai/gpt-4o-mini");
    expect(body.error.message).not.toContain("FUNCTION_PAYLOAD_TOO_LARGE");
  });

  it.each([400, 413, 422])("does not lock or freeze the provider for caller HTTP %s", async (status) => {
    mocks.transport.mockImplementation(async () => Response.json({ error: { message: "Invalid input" } }, { status }));
    expect((await handleChat(request())).status).toBe(status);
    expect(mocks.credentials.mock.calls.map(([provider]) => provider)).toEqual(["commandcode", "openai"]);
    expect(mocks.lockAccount).not.toHaveBeenCalled();
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it.each([
    { choices: null }, { choices: [] }, { error: { message: "Provider failed despite HTTP 200" } },
  ])("falls back before committing unusable JSON: %j", async (payload) => {
    mocks.transport.mockResolvedValueOnce(Response.json(payload));
    const response = await handleChat(request());
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("OK");
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "commandcode", status: 502 }));
  });

  it("ignores heartbeat-only SSE until the 45-second deadline, then falls back before output", async () => {
    mocks.transport.mockImplementationOnce(async (_, options) => stalledResponse(options.signal, false, true));
    const task = handleChat(request(undefined, { stream: true }));
    await pumpUntil(() => mocks.transport.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(45_001);
    const response = await task;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"content":"OK"');
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.freeze).not.toHaveBeenCalled();
    expect(mocks.transport.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("bounds missing headers to 45 seconds despite three available accounts", async () => {
    mocks.transport.mockImplementationOnce((_, options) => stalledResponse(options.signal, true));
    const task = handleChat(request());
    await pumpUntil(() => mocks.transport.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(45_001);
    expect((await task).status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.credentials.mock.calls.filter(([provider]) => provider === "commandcode")).toHaveLength(1);
    expect(mocks.freeze).not.toHaveBeenCalled();
    expect(mocks.lockAccount).not.toHaveBeenCalled();
  });

  it("bounds a stalled successful JSON body to 120 seconds and settles each pending request once", async () => {
    mocks.transport.mockImplementationOnce(async (_, options) => stalledResponse(options.signal));
    const task = handleChat(request());
    await pumpUntil(() => mocks.transport.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await task).status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.freeze).not.toHaveBeenCalled();
    expect(mocks.pending.mock.calls.map((args) => args[3])).toEqual([true, false, true, false]);
  });

  it("honors the longer Combo deadline supplied by the internal compaction path", async () => {
    mocks.transport.mockImplementationOnce(async (_, options) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 150_000);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        }, { once: true });
      });
      return success(options);
    });
    const task = handleChat(request(), null, { comboRequestTimeoutFloorMs: 180_000 });
    await pumpUntil(() => mocks.transport.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(150_001);
    expect((await task).status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(mocks.transport.mock.calls[0][1].headersTimeout).toBe(180_000);
    expect(mocks.freeze).not.toHaveBeenCalled();

    expect((await handleChat(request())).status).toBe(200);
    expect(mocks.transport.mock.calls[1][1].headersTimeout).toBeUndefined();
  });

  it("keeps manual direct requests and their executor retries working while leaving the Combo circuit frozen", async () => {
    const frozen = { state: "open", nextProbeAt: NOW + 60_000 };
    mocks.circuits.set(key("commandcode", MODEL), frozen);
    mocks.transport.mockResolvedValueOnce(new Response("Unavailable", { status: 502 }));
    const task = handleChat(request(`cmc/${MODEL}`));
    await pumpUntil(() => mocks.logger.debug.mock.calls.some(([scope]) => scope === "RETRY"));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await task).status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.getHealth).not.toHaveBeenCalled();
    expect(mocks.circuits.get(key("commandcode", MODEL))).toBe(frozen);
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it("guards an added vision adapter first but keeps the explicitly requested original model direct", async () => {
    mocks.settings = { capacityAdapter: { vision: { enabled: true, models: ["openai/gpt-4o-mini"] } } };
    mocks.transport.mockImplementation(async (url, options) => url.includes("api.openai.com")
      ? new Response("Adapter unavailable", { status: 502 }) : success(options));
    const response = await handleChat(request("cmc/deepseek-chat", { messages: [{ role: "user", content: [
      { type: "text", text: "Describe this image." }, { type: "image_url", image_url: { url: "data:image/png;base64,dGVzdA==" } },
    ] }] }));
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("OK");
    expect(mocks.credentials.mock.calls.map(([provider]) => provider)).toEqual(["openai", "commandcode"]);
    expect(mocks.transport.mock.calls.map(([, options]) => JSON.parse(options.body).model)).toEqual(["gpt-4o-mini", "deepseek-chat"]);
    expect(mocks.getHealth).toHaveBeenCalledExactlyOnceWith("openai", "gpt-4o-mini");
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "openai", model: "gpt-4o-mini", status: 502 }));
    expect(mocks.circuits.has(key("commandcode", "deepseek-chat"))).toBe(false);
  });

  it.each([false, true])("preserves original direct-model retry policy after an added adapter fails (exhausted=%s)", async (exhausted) => {
    mocks.settings = { capacityAdapter: { vision: { enabled: true, models: ["openai/gpt-4o-mini"] } } };
    const getCredentials = mocks.credentials.getMockImplementation();
    mocks.credentials.mockImplementation((provider, excluded, model) => provider === "commandcode" && excluded.size
      ? null : getCredentials(provider, excluded, model));
    let originalAttempts = 0;
    mocks.transport.mockImplementation(async (url, options) => {
      if (url.includes("api.openai.com")) return new Response("Adapter unavailable", { status: 502 });
      originalAttempts++;
      return exhausted || originalAttempts === 1 ? new Response("Direct provider unavailable", { status: 502 }) : success(options);
    });
    const task = handleChat(request("cmc/deepseek-chat", { messages: [{ role: "user", content: [
      { type: "text", text: "Describe this image." }, { type: "image_url", image_url: { url: "data:image/png;base64,dGVzdA==" } },
    ] }] }));
    await pumpUntil(() => mocks.logger.debug.mock.calls.some(([scope]) => scope === "RETRY"));
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await task).status).toBe(exhausted ? 502 : 200);
    expect(originalAttempts).toBe(exhausted ? 3 : 2);
    expect(mocks.transport).toHaveBeenCalledTimes(originalAttempts + 1);
    expect(mocks.getHealth).toHaveBeenCalledExactlyOnceWith("openai", "gpt-4o-mini");
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "openai", model: "gpt-4o-mini" }));
    expect(mocks.circuits.has(key("commandcode", "deepseek-chat"))).toBe(false);
    if (exhausted) expect(mocks.lockAccount).toHaveBeenCalledExactlyOnceWith(
      "commandcode-one", 502, expect.any(String), "commandcode", "deepseek-chat", null,
    );
    else expect(mocks.lockAccount).not.toHaveBeenCalled();
  });

  it("does not apply the new strict Combo completion contract to a manual direct request", async () => {
    const partial = 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
    mocks.transport.mockResolvedValueOnce(new Response(partial, { headers: { "content-type": "text/event-stream" } }));
    const response = await handleChat(request("openai/gpt-4o-mini"));
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("partial");
    expect(mocks.getHealth).not.toHaveBeenCalled();
    expect(mocks.freeze).not.toHaveBeenCalled();
  });

  it("freezes a stream that ends after real output instead of synthesizing successful DONE", async () => {
    let finish;
    mocks.transport.mockImplementationOnce(async (_, { signal }) => new Response(new ReadableStream({
      start(out) {
        out.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
        finish = () => { try { out.close(); } catch { /* already aborted */ } };
        signal.addEventListener("abort", () => { try { out.error(signal.reason); } catch { /* closed */ } }, { once: true });
        cleanup.push(finish);
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await handleChat(request(undefined, { stream: true }));
    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("partial");
    const remaining = (async () => {
      try { while (!(await reader.read()).done) {} return null; }
      catch (error) { return error; }
    })();
    finish();
    expect(await remaining).toBeInstanceOf(Error);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "commandcode", status: 502 }));
  });
});
