import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the public handler, chatCore, stream controller, combo loop, and
// BaseExecutor real. Only persistence, account lookup, and transport are replaced.
const mocks = vi.hoisted(() => ({
  transport: vi.fn(),
  getCredentials: vi.fn(),
  lockAccount: vi.fn(),
  clearAccountError: vi.fn(),
  updateCredentials: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  pending: vi.fn(),
  requestLog: vi.fn(),
  requestDetail: vi.fn(),
  saveUsage: vi.fn(),
  getComboHealth: vi.fn(),
  freezeComboModel: vi.fn(),
  executor: null,
  logger: Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine", "tagForSession", "nextTag", "maskKey", "fmtThink"].map((name) => [name, vi.fn()])),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.transport }));
vi.mock("../../open-sse/utils/debugLog.js", () => ({ dbg: vi.fn(), isDebugEnabled: () => false }));
vi.mock("../../open-sse/services/comboHealth.js", () => ({
  getComboHealth: mocks.getComboHealth,
  freezeComboModel: mocks.freezeComboModel,
}));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => mocks.executor }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getCredentials,
  markAccountUnavailable: mocks.lockAccount,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_, credentials) => credentials,
  updateProviderCredentials: mocks.updateCredentials,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("../../src/sse/utils/logger.js", () => mocks.logger);
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: async () => null }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: mocks.pending,
  appendRequestLog: mocks.requestLog,
  saveRequestDetail: mocks.requestDetail,
  saveRequestUsage: mocks.saveUsage,
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => Object.fromEntries([
    "logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse",
    "logConvertedResponse", "logError",
  ].map((name) => [name, vi.fn()])),
}));

import { BaseExecutor } from "../../open-sse/executors/base.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { handleChat } from "../../src/sse/handlers/chat.js";

const completion = {
  id: "chatcmpl-test",
  model: "zai-org/GLM-5.1",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};
let cleanup;

function request(signal, model = "commandcode/zai-org/GLM-5.1", stream = false) {
  return new Request("http://router.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "Calculate 17 plus 25." }] }),
    signal,
  });
}

function successResponse() {
  return new Response(JSON.stringify(completion), { headers: { "content-type": "application/json" } });
}

async function pumpUntil(predicate) {
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(0);
    if (predicate()) return;
  }
  throw new Error("Expected request stage was not reached");
}

async function settlePromptly(task) {
  let settled = false;
  let response;
  let failure;
  task.then((value) => { response = value; settled = true; }, (error) => { failure = error; settled = true; });
  await vi.advanceTimersByTimeAsync(25);
  expect(settled, "caller cancellation must settle within 25ms, without waiting for retry/connect timeout").toBe(true);
  if (failure) throw failure;
  return response;
}

function holdHeaders() {
  mocks.transport.mockImplementation((_, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    cleanup.push(() => {
      signal.removeEventListener("abort", abort);
      resolve(successResponse());
    });
  }));
}

function assertNoFallback() {
  expect(mocks.lockAccount).not.toHaveBeenCalled();
  expect(mocks.getCredentials).toHaveBeenCalledTimes(1);
  expect(mocks.getModelInfo).toHaveBeenCalledTimes(1);
  expect(mocks.transport).toHaveBeenCalledTimes(1);
}

function assertPendingSettledOnce() {
  expect(mocks.pending.mock.calls.map((args) => args[3])).toEqual([true, false]);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  cleanup = [];
  mocks.executor = new BaseExecutor("commandcode", {
    baseUrl: "https://upstream.test/v1/chat/completions",
    noAuth: true,
    retry: { 502: { attempts: 2, delayMs: 1000 }, 503: { attempts: 0 } },
    timeoutMs: 60_000,
  });
  mocks.getCredentials.mockImplementation(async (_, excluded) => excluded.size ? null : ({
    connectionId: "account-one", connectionName: "Test account", apiKey: "test-key", providerSpecificData: {},
  }));
  mocks.lockAccount.mockResolvedValue({ shouldFallback: true });
  mocks.getModelInfo.mockImplementation(async (model) => ({ provider: "commandcode", model: model.split("/").slice(1).join("/") }));
  mocks.getComboModels.mockImplementation(async (model) => model === "combo-test" ? ["commandcode/zai-org/GLM-5.1", "commandcode/deepseek/deepseek-v4-flash"] : null);
  mocks.requestLog.mockResolvedValue();
  mocks.requestDetail.mockResolvedValue();
  mocks.saveUsage.mockResolvedValue();
  mocks.updateCredentials.mockResolvedValue();
  mocks.getComboHealth.mockResolvedValue(null);
  mocks.freezeComboModel.mockResolvedValue();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected real fetch"); }));
});

afterEach(async () => {
  for (const release of cleanup) release();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat caller cancellation across the public production path", () => {
  it("does not select an account or dispatch a pre-aborted Request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller already disconnected"));
    mocks.transport.mockResolvedValue(successResponse());

    const result = await handleChat(request(controller.signal));

    expect(result.status).toBe(499);
    expect(mocks.getCredentials).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.lockAccount).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
  });

  it.each([
    ["AbortError", () => new DOMException("caller disconnected", "AbortError")],
    ["Error", () => new Error("caller disconnected")],
    ["TimeoutError", () => new DOMException("caller deadline", "TimeoutError")],
    ["string", () => "caller cancelled"],
  ])("cancels before headers for a %s reason and does not fall through combo/accounts", async (_, makeReason) => {
    const controller = new AbortController();
    holdHeaders();
    const task = handleChat(request(controller.signal, "combo-test"));
    await pumpUntil(() => mocks.transport.mock.calls.length === 1);
    const upstreamSignal = mocks.transport.mock.calls[0][1].signal;

    controller.abort(makeReason());
    const result = await settlePromptly(task);

    expect(result.status).toBe(499);
    expect(upstreamSignal.aborted).toBe(true);
    assertNoFallback();
    assertPendingSettledOnce();
  });

  it("interrupts BaseExecutor retry delay without another upstream call", async () => {
    const controller = new AbortController();
    mocks.transport.mockResolvedValue(new Response("temporary failure", { status: 502 }));
    const task = handleChat(request(controller.signal));
    await pumpUntil(() => mocks.logger.debug.mock.calls.some(([scope]) => scope === "RETRY"));

    controller.abort(new Error("stop while waiting"));
    const result = await settlePromptly(task);

    expect(result.status).toBe(499);
    await vi.advanceTimersByTimeAsync(10_000);
    assertNoFallback();
    assertPendingSettledOnce();
  });

  it("still retries an upstream network failure when the caller remains connected", async () => {
    const controller = new AbortController();
    mocks.transport
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(successResponse());
    const task = handleChat(request(controller.signal));
    await pumpUntil(() => mocks.logger.debug.mock.calls.some(([scope]) => scope === "RETRY"));

    await vi.advanceTimersByTimeAsync(1000);
    const result = await task;

    expect(result.status).toBe(200);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.lockAccount).not.toHaveBeenCalled();
    assertPendingSettledOnce();
  });

  it("keeps the executor's own connect timeout retryable while the caller remains connected", async () => {
    const controller = new AbortController();
    mocks.executor.config.timeoutMs = 50;
    mocks.transport
      .mockImplementationOnce((_, { signal }) => new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        cleanup.push(() => {
          signal.removeEventListener("abort", abort);
          resolve(successResponse());
        });
      }))
      .mockResolvedValueOnce(successResponse());
    const task = handleChat(request(controller.signal));
    await pumpUntil(() => mocks.transport.mock.calls.length === 1);

    await vi.advanceTimersByTimeAsync(50);
    await pumpUntil(() => mocks.logger.debug.mock.calls.some(([scope]) => scope === "RETRY"));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await task;

    expect(result.status).toBe(200);
    expect(controller.signal.aborted).toBe(false);
    expect(mocks.transport).toHaveBeenCalledTimes(2);
    expect(mocks.lockAccount).not.toHaveBeenCalled();
    assertPendingSettledOnce();
  });

  it("persists rotated refresh credentials received after caller cancellation without retrying inference", async () => {
    const controller = new AbortController();
    let finishRefresh;
    const refreshResult = new Promise((resolve) => { finishRefresh = resolve; });
    cleanup.push(() => finishRefresh(null));
    mocks.executor.noAuth = false;
    mocks.executor.refreshCredentials = vi.fn(() => refreshResult);
    mocks.getCredentials.mockResolvedValueOnce({
      connectionId: "account-one", connectionName: "Test account",
      accessToken: "old-access", refreshToken: "old-refresh", providerSpecificData: {},
    });
    mocks.transport.mockResolvedValueOnce(new Response("Token expired", { status: 401 }));
    const task = handleChat(request(controller.signal, "combo-test"));
    await pumpUntil(() => mocks.executor.refreshCredentials.mock.calls.length === 1);

    controller.abort(new Error("caller left during token rotation"));
    const rotated = { accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 3600 };
    finishRefresh(rotated);
    const result = await settlePromptly(task);

    expect(result.status).toBe(499);
    expect(mocks.updateCredentials).toHaveBeenCalledExactlyOnceWith("account-one", {
      ...rotated, existingProviderSpecificData: {}, testStatus: "active",
    });
    expect(mocks.executor.refreshCredentials).toHaveBeenCalledTimes(1);
    assertNoFallback();
    assertPendingSettledOnce();
  });

  it.each([
    ["JSON", "application/json", 200],
    ["SSE returned to a JSON client", "text/event-stream", 200],
    ["upstream error body", "application/json", 503],
  ])("cancels during reading %s and preserves 499", async (_, contentType, status) => {
    const controller = new AbortController();
    let readStarted = false;
    mocks.transport.mockImplementation(async (url, { signal }) => {
      const body = new ReadableStream({
        start(stream) {
          const abort = () => stream.error(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          cleanup.push(() => {
            signal.removeEventListener("abort", abort);
            try { stream.close(); } catch { /* cancellation already closed it */ }
          });
        },
        pull() { readStarted = true; },
      }, { highWaterMark: 0 });
      const response = new Response(body, { status, headers: { "content-type": contentType } });
      return response;
    });
    const task = handleChat(request(controller.signal, "combo-test"));
    await pumpUntil(() => readStarted);
    if (status === 200) {
      expect(mocks.pending.mock.calls.map((args) => args[3])).toEqual([true]);
    }

    controller.abort(new Error("stop reading body"));
    const result = await settlePromptly(task);

    expect(result.status).toBe(499);
    assertNoFallback();
    assertPendingSettledOnce();
  });

  it("detaches caller cancellation after JSON success without aborting a retained upstream signal", async () => {
    const controller = new AbortController();
    mocks.transport.mockResolvedValueOnce(successResponse());
    const result = await handleChat(request(controller.signal));
    const upstreamSignal = mocks.transport.mock.calls[0][1].signal;

    expect(result.status).toBe(200);
    expect((await result.json()).choices[0].message.content).toBe("ok");
    assertPendingSettledOnce();
    controller.abort(new Error("closed after completion"));
    await vi.advanceTimersByTimeAsync(1000);

    expect(upstreamSignal.aborted).toBe(false);
    assertPendingSettledOnce();
    expect(mocks.lockAccount).not.toHaveBeenCalled();
  });

  it("detaches caller cancellation after streaming EOF with exactly one pending decrement", async () => {
    const controller = new AbortController();
    const chunk = { id: "chatcmpl-stream", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] };
    const terminal = { id: "chatcmpl-stream", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    mocks.transport.mockResolvedValueOnce(new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ));
    const result = await handleChat(request(controller.signal, undefined, true));
    const upstreamSignal = mocks.transport.mock.calls[0][1].signal;
    const text = await result.text();

    expect(result.status).toBe(200);
    expect(text).toContain("ok");
    assertPendingSettledOnce();
    controller.abort(new Error("closed after streaming EOF"));
    await vi.advanceTimersByTimeAsync(1000);

    expect(upstreamSignal.aborted).toBe(false);
    assertPendingSettledOnce();
    expect(mocks.lockAccount).not.toHaveBeenCalled();
  });

  it("cancels an active streaming body and settles pending once without account/model fallback", async () => {
    const controller = new AbortController();
    mocks.transport.mockImplementation(async (_, { signal }) => new Response(new ReadableStream({
      start(stream) {
        const chunk = { id: "chatcmpl-stream", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] };
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
        const abort = () => stream.error(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        cleanup.push(() => {
          signal.removeEventListener("abort", abort);
          try { stream.close(); } catch { /* already cancelled */ }
        });
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const result = await handleChat(request(controller.signal, "combo-test", true));
    const upstreamSignal = mocks.transport.mock.calls[0][1].signal;
    const bodyTask = result.text().then(() => null, (error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.pending.mock.calls.map((args) => args[3])).toEqual([true]);

    controller.abort(new Error("stop active stream"));
    expect(await settlePromptly(bodyTask)).toBeInstanceOf(Error);

    expect(upstreamSignal.aborted).toBe(true);
    assertNoFallback();
    assertPendingSettledOnce();
    expect(mocks.freezeComboModel).not.toHaveBeenCalled();
  });

  it("never classifies 499 as retryable even when its message contains transient-error keywords", () => {
    expect(checkFallbackError(499, "fetch connect timeout; overloaded; rate limit").shouldFallback).toBe(false);
  });
});
