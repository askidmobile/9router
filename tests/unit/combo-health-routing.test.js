import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Public route -> real model resolver -> Combo -> guard -> ChatCore -> real
// executor. Only transport, credentials, persistence, and logs are replaced.
const mocks = vi.hoisted(() => ({
  transport: vi.fn(), credentials: vi.fn(), lockAccount: vi.fn(), clearAccount: vi.fn(),
  updateCredentials: vi.fn(), pending: vi.fn(), freeze: vi.fn(), getHealth: vi.fn(),
  combos: new Map(), circuits: new Map(), executors: new Map(), settings: {},
  logger: Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine", "tagForSession", "nextTag", "maskKey", "fmtThink"].map((name) => [name, vi.fn()])),
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.transport }));
vi.mock("../../open-sse/utils/debugLog.js", () => ({ dbg: vi.fn(), isDebugEnabled: () => false }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: (provider) => mocks.executors.get(provider) }));
vi.mock("../../open-sse/services/comboHealth.js", () => ({ getComboHealth: mocks.getHealth, freezeComboModel: mocks.freeze }));
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
    ? [{ id: "openai-compatible-chat-test", prefix: "cheaper", type: "openai-compatible" }] : [],
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
import { handleChat, runComboModelProbe } from "../../src/sse/handlers/chat.js";

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
      providerSpecificData: provider.startsWith("openai-compatible-") ? { baseUrl: "https://custom.test/v1", prefix: "cheaper" } : {} } : null;
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

  it.each([
    ["commandcode", `cmc/${MODEL}`, `commandcode/${MODEL}`],
    [CUSTOM, "cheaper/glm-5.3-flash", `${CUSTOM}/glm-5.3-flash`],
  ])("shares a canonical circuit across builtin/custom aliases for %s", async (provider, alias, canonical) => {
    const model = canonical.slice(canonical.indexOf("/") + 1);
    mocks.circuits.set(key(provider, model), { state: "open", nextProbeAt: NOW - 1000 });
    for (const member of [alias, canonical]) {
      mocks.combos.set("alias-test", [member, "openai/gpt-4o-mini"]);
      expect((await handleChat(request("alias-test"))).status).toBe(200);
    }
    expect(mocks.credentials.mock.calls.map(([id]) => id)).toEqual(["openai", "openai"]);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.freeze).not.toHaveBeenCalled();
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
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 504 }));
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
    expect(mocks.freeze).toHaveBeenCalledTimes(1);
    expect(mocks.lockAccount).not.toHaveBeenCalled();
  });

  it("bounds a stalled successful JSON body to 120 seconds and settles each pending request once", async () => {
    mocks.transport.mockImplementationOnce(async (_, options) => stalledResponse(options.signal));
    const task = handleChat(request());
    await pumpUntil(() => mocks.transport.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await task).status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 504 }));
    expect(mocks.pending.mock.calls.map((args) => args[3])).toEqual([true, false, true, false]);
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

  it.each([200, 502])("runs an isolated recovery probe through a frozen pair without another provider or changing state: HTTP %s", async (status) => {
    const frozen = { state: "open", nextProbeAt: NOW + 60_000 };
    mocks.circuits.set(key("commandcode", MODEL), frozen);
    if (status !== 200) mocks.transport.mockResolvedValue(new Response("Unavailable", { status }));
    const result = await runComboModelProbe({ provider: "commandcode", model: MODEL, signal: new AbortController().signal });
    expect(result.ok).toBe(status === 200);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(mocks.credentials.mock.calls.map(([provider]) => provider)).toEqual(["commandcode"]);
    expect(mocks.circuits.get(key("commandcode", MODEL))).toBe(frozen);
    expect(mocks.freeze).not.toHaveBeenCalled();
    const sent = JSON.parse(mocks.transport.mock.calls[0][1].body);
    expect(sent.messages.at(-1).content).toBe("Reply with exactly OK.");
  });

  it("keeps Gemini Flex body tiers and suffixes on the same key while Standard remains separate", async () => {
    mocks.combos.set("gemini-body", ["gemini/gemini-3.8-flash(high)"]);
    mocks.combos.set("gemini-suffix", ["gemini/gemini-3.8-flash:flex(high)"]);
    mocks.transport.mockResolvedValueOnce(Response.json({ error: { message: "Capacity unavailable" } }, { status: 503 }));
    expect((await handleChat(request("gemini-body", { service_tier: "flex" }))).status).toBe(503);
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "gemini", model: "gemini-3.8-flash:flex(high)" }));
    const flexBody = JSON.parse(mocks.transport.mock.calls[0][1].body);
    expect(flexBody.serviceTier).toBe("flex");
    expect(flexBody.service_tier).toBeUndefined();
    expect(flexBody.generationConfig.thinkingConfig).toBeDefined();
    expect((await handleChat(request("gemini-suffix"))).status).toBe(503);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    mocks.transport.mockResolvedValueOnce(Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] }));
    expect((await handleChat(request("gemini-body"))).status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.transport.mock.calls[1][1].body).serviceTier).toBeUndefined();
    expect(mocks.circuits.has(key("gemini", "gemini-3.8-flash:flex(high)"))).toBe(true);
  });

  it.each([
    ["partial EOF", 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'],
    ["native failure with text", 'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop","native_finish_reason":"network_error"}]}\n\ndata: [DONE]\n\n'],
  ])("rejects force-stream OpenAI %s before JSON translation can turn it into a successful fallback or probe", async (_, partial) => {
    mocks.combos.set("force-stream-failure", ["openai/gpt-4o-mini", `cmc/${MODEL}`]);
    const upstream = () => new Response(partial, { headers: { "content-type": "text/event-stream" } });
    mocks.transport.mockResolvedValueOnce(upstream());
    const response = await handleChat(request("force-stream-failure"));
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("OK");
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "openai", status: 502 }));
    const frozen = mocks.circuits.get(key("openai", "gpt-4o-mini"));
    mocks.transport.mockResolvedValueOnce(upstream());
    const probe = await runComboModelProbe({ provider: "openai", model: "gpt-4o-mini", signal: new AbortController().signal });
    expect(probe.ok).toBe(false);
    expect(mocks.transport).toHaveBeenCalledTimes(3);
    expect(mocks.freeze).toHaveBeenCalledTimes(1);
    expect(mocks.circuits.get(key("openai", "gpt-4o-mini"))).toBe(frozen);
  });

  it("cannot count Responses failed-with-text as a successful recovery probe", async () => {
    const partial = { id: "resp-failed", status: "failed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial answer" }] }] };
    const data = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: partial })}\n\n`;
    mocks.circuits.set(key(RESPONSES, "response-model"), { state: "open", nextProbeAt: NOW + 60_000 });
    mocks.transport.mockResolvedValueOnce(new Response(data, { headers: { "content-type": "text/event-stream" } }));
    const probe = await runComboModelProbe({ provider: RESPONSES, model: "response-model", signal: new AbortController().signal });
    expect(probe.ok).toBe(false);
    expect(probe.status).toBeGreaterThanOrEqual(500);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect(mocks.freeze).not.toHaveBeenCalled();
    expect(mocks.circuits.has(key(RESPONSES, "response-model"))).toBe(true);
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
