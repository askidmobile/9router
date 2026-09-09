import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFusionChat } from "open-sse/services/combo.js";
import { runComboModelExecution } from "open-sse/services/comboExecution.js";
import { createComboDeadlineError, isComboDeadlineError } from "open-sse/utils/abort.js";

const encoder = new TextEncoder();
const log = { info: vi.fn(), warn: vi.fn() };
const tuning = { minPanel: 2, stragglerGraceMs: 10, panelHardTimeoutMs: 100 };
const body = { messages: [{ role: "user", content: "Question" }], stream: true };

function jsonResponse(content) {
  return Response.json({ choices: [{ message: { role: "assistant", content } }] });
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function pendingBody() {
  let controller;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({
    start(value) { controller = value; },
    cancel,
  }), { headers: { "Content-Type": "application/json" } });
  return {
    response,
    cancel,
    complete(content) {
      if (cancel.mock.calls.length) return;
      controller.enqueue(encoder.encode(JSON.stringify({ choices: [{ message: { content } }] })));
      controller.close();
    },
  };
}

function run(handleSingleModel, options = {}) {
  return handleFusionChat({
    body,
    models: ["p/a", "p/b"],
    judgeModel: "p/judge",
    comboName: "cancel-test",
    tuning,
    log,
    handleSingleModel,
    ...options,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Fusion cancellation and deadlines", () => {
  it("distinguishes an internal deadline from ordinary client cancellation across module copies", () => {
    const error = createComboDeadlineError("Panel timeout");
    expect(error).toBeInstanceOf(Error);
    expect(isComboDeadlineError(error)).toBe(true);
    expect(isComboDeadlineError({ name: error.name, code: error.code })).toBe(true);
    expect(isComboDeadlineError(new DOMException("Timed out", "TimeoutError"))).toBe(false);
    expect(isComboDeadlineError(new DOMException("Aborted", "AbortError"))).toBe(false);
    expect(isComboDeadlineError({ code: error.code })).toBe(false);
  });

  it("does not start a panel when the caller is already aborted", async () => {
    const caller = new AbortController();
    caller.abort();
    const handle = vi.fn();
    expect((await run(handle, { signal: caller.signal })).status).toBe(499);
    expect(handle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caller cancellation aborts every pending header request, without a judge or leftover timers", async () => {
    const caller = new AbortController();
    const signals = [];
    const handle = vi.fn((_body, _model, _panel, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const response = run(handle, { signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort(new Error("User disconnected"));
    expect((await response).status).toBe(499);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted && !isComboDeadlineError(signal.reason))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caller cancellation cancels panel body readers and removes abort listeners", async () => {
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const bodies = [pendingBody(), pendingBody()];
    const handle = vi.fn((_body, model) => bodies[model === "p/a" ? 0 : 1].response);
    const response = run(handle, { signal: caller.signal });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    expect((await response).status).toBe(499);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(bodies.every((entry) => entry.cancel.mock.calls.length === 1)).toBe(true);
    for (const [event, callback] of add.mock.calls) {
      if (event === "abort") expect(remove).toHaveBeenCalledWith(event, callback);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks panel hard deadlines as provider failures, including stalled bodies", async () => {
    const partial = pendingBody();
    const signals = [];
    const handle = vi.fn((_body, model, _panel, { signal }) => {
      signals.push(signal);
      return model === "p/a" ? new Promise(() => {}) : partial.response;
    });
    const response = run(handle);
    await vi.advanceTimersByTimeAsync(100);
    expect((await response).status).toBe(503);
    expect(signals.every((signal) => signal.aborted && isComboDeadlineError(signal.reason))).toBe(true);
    expect(partial.cancel).toHaveBeenCalledOnce();
    expect(isComboDeadlineError(partial.cancel.mock.calls[0][0])).toBe(true);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops quorum stragglers neutrally and ignores their late completions", async () => {
    const late = deferred();
    const lateBody = pendingBody();
    let slowSignal;
    const handle = vi.fn((_body, model, _panel, options) => {
      if (model === "p/slow") { slowSignal = options.signal; return late.promise; }
      return jsonResponse(model === "p/judge" ? "FINAL" : model);
    });
    const response = run(handle, { models: ["p/a", "p/b", "p/slow"] });
    await vi.advanceTimersByTimeAsync(10);
    expect((await response).status).toBe(200);
    expect(slowSignal.aborted).toBe(true);
    expect(isComboDeadlineError(slowSignal.reason)).toBe(false);
    expect(handle).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    late.resolve(lateBody.response);
    await vi.advanceTimersByTimeAsync(200);
    expect(lateBody.cancel).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count successful headers toward quorum before a complete usable answer arrives", async () => {
    const delayed = pendingBody();
    const straggler = pendingBody();
    const handle = vi.fn((_body, model) => {
      if (model === "p/b") return delayed.response;
      if (model === "p/c") return straggler.response;
      return jsonResponse(model === "p/judge" ? "FINAL" : "A");
    });
    let finished = false;
    const response = run(handle, { models: ["p/a", "p/b", "p/c"] }).then((value) => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(20);
    expect(finished).toBe(false);
    expect(straggler.cancel).not.toHaveBeenCalled();
    delayed.complete("B");
    await vi.advanceTimersByTimeAsync(10);
    expect((await response).status).toBe(200);
    const judgeBody = handle.mock.calls.find(([, model]) => model === "p/judge")[0];
    expect(judgeBody.messages.at(-1).content).toContain("[Source 1]\nA");
    expect(judgeBody.messages.at(-1).content).toContain("[Source 2]\nB");
    expect(straggler.cancel).toHaveBeenCalledOnce();
    expect(isComboDeadlineError(straggler.cancel.mock.calls[0][0])).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count empty or malformed JSON as successful quorum members", async () => {
    const delayed = pendingBody();
    const handle = vi.fn((_body, model) => {
      if (model === "p/empty") return jsonResponse("  ");
      if (model === "p/malformed") return new Response("invalid json");
      if (model === "p/slow") return delayed.response;
      return jsonResponse(model === "p/judge" ? "FINAL" : "Valid A");
    });
    let finished = false;
    const response = run(handle, { models: ["p/empty", "p/malformed", "p/a", "p/slow"] })
      .then((value) => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(20);
    expect(finished).toBe(false);
    delayed.complete("Valid B");
    await vi.advanceTimersByTimeAsync(0);
    expect((await response).status).toBe(200);
    const judgeBody = handle.mock.calls.find(([, model]) => model === "p/judge")[0];
    expect(judgeBody.messages.at(-1).content).toContain("Valid A");
    expect(judgeBody.messages.at(-1).content).toContain("Valid B");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["Judging", "Only"])("does not start a new request after cancellation at the %s transition", async (transition) => {
    const caller = new AbortController();
    const localLog = {
      warn: vi.fn(),
      info: vi.fn((_tag, message) => { if (message.startsWith(transition)) caller.abort(); }),
    };
    const handle = vi.fn((_body, model) => transition === "Only" && model === "p/b"
      ? new Response("failed", { status: 502 }) : jsonResponse(model));
    const response = await run(handle, { signal: caller.signal, log: localLog });
    expect(response.status).toBe(499);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the caller signal into the final judge request", async () => {
    const caller = new AbortController();
    const handle = vi.fn(() => jsonResponse("OK"));
    await run(handle, { signal: caller.signal });
    const judge = handle.mock.calls.find(([, model]) => model === "p/judge");
    expect(judge[3].signal).toBe(caller.signal);
  });
});

describe("Fusion with the production Combo execution guard", () => {
  const executionConfig = {
    firstResponseTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    streamIdleTimeoutMs: 1_000,
    probeTimeoutMs: 1_000,
    probeIntervalMs: 5,
    maxBufferedBytes: 4_096,
  };

  it.each([false, true])("hardTimeout=%s freezes only actual deadline failures", async (hardTimeout) => {
    const health = { get: vi.fn(async () => null), freeze: vi.fn(async () => {}) };
    const handle = vi.fn((requestBody, model, isPanel, { signal } = {}) => {
      if (!isPanel) return jsonResponse("FINAL");
      return runComboModelExecution({
        provider: "p", model: model.slice(2), body: requestBody, signal, health, config: executionConfig,
        execute: async () => hardTimeout || model === "p/slow" ? new Promise(() => {}) : jsonResponse(model),
      });
    });
    const response = run(handle, { models: hardTimeout ? ["p/a", "p/b"] : ["p/a", "p/b", "p/slow"] });
    await vi.advanceTimersByTimeAsync(hardTimeout ? 100 : 10);
    expect((await response).status).toBe(hardTimeout ? 503 : 200);
    await vi.advanceTimersByTimeAsync(0);
    if (hardTimeout) {
      expect(health.freeze).toHaveBeenCalledTimes(2);
      expect(health.freeze).toHaveBeenCalledWith(expect.objectContaining({ provider: "p", model: "a", status: 504 }));
      expect(health.freeze).toHaveBeenCalledWith(expect.objectContaining({ provider: "p", model: "b", status: 504 }));
    } else {
      expect(health.freeze).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
