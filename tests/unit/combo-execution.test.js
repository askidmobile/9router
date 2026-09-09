import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/services/comboHealth.js", () => ({
  getComboHealth: vi.fn(() => { throw new Error("Use injected health storage"); }),
  freezeComboModel: vi.fn(() => { throw new Error("Use injected health storage"); }),
}));

import { runComboModelExecution } from "../../open-sse/services/comboExecution.js";
import { createComboDeadlineError } from "../../open-sse/utils/abort.js";

const NOW = 1_800_000_000_000;
const config = {
  firstResponseTimeoutMs: 40,
  requestTimeoutMs: 120,
  streamIdleTimeoutMs: 30,
  probeTimeoutMs: 50,
  probeIntervalMs: 5,
  maxBufferedBytes: 4096,
};
const encoder = new TextEncoder();
const completion = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }] };
const contentFrame = (content = "hello") => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const doneFrame = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

let health;
let execute;
let sources;

function run(options = {}) {
  return runComboModelExecution({
    provider: "commandcode", model: "z-ai/glm-5.3-flash", body: { stream: false },
    execute, health, config, ...options,
  });
}

function controlledResponse(contentType = "text/event-stream", status = 200) {
  let controller;
  let closed = false;
  const cancel = vi.fn(() => { closed = true; });
  const response = new Response(new ReadableStream({
    start(out) { controller = out; }, cancel,
  }), { status, headers: { "content-type": contentType } });
  const source = {
    response, cancel,
    push(text) { if (!closed) controller.enqueue(encoder.encode(text)); },
    close() { if (!closed) { closed = true; controller.close(); } },
    error(error = new Error("fixture cleanup")) { if (!closed) { closed = true; controller.error(error); } },
  };
  sources.push(source);
  return source;
}

const pump = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  health = { get: vi.fn(async () => null), freeze: vi.fn(async () => {}) };
  execute = vi.fn(async () => Response.json(completion));
  sources = [];
});

afterEach(async () => {
  for (const source of sources) source.error();
  await pump();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Combo member execution admission and deadlines", () => {
  it("skips a frozen pair even after its next-probe deadline without executing a request", async () => {
    health.get.mockResolvedValue({ state: "open", nextProbeAt: NOW - 1000 });
    const response = await run();
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("awaiting a successful background check");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(execute).not.toHaveBeenCalled();
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("uses one executor attempt and passes the bounded header policy", async () => {
    const response = await run();
    expect(await response.json()).toEqual(completion);
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), {
      maxRetries: 0, headersTimeoutMs: 40, strictCompletion: true,
    });
    expect(health.freeze).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute.mock.calls[0][0].aborted).toBe(false);
  });

  it("aborts a first-response timeout before headers and freezes once with 504", async () => {
    execute.mockImplementation(() => new Promise(() => {}));
    const task = run({ body: { stream: true } });
    await vi.advanceTimersByTimeAsync(41);
    const response = await task;
    expect(response.status).toBe(504);
    expect(await response.text()).toContain("First response timeout");
    expect(execute.mock.calls[0][0].aborted).toBe(true);
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith({
      provider: "commandcode", model: "z-ai/glm-5.3-flash", status: 504,
      reason: "First response timeout", retryAfterMs: undefined,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(health.freeze).toHaveBeenCalledTimes(1);
  });

  it("covers a stalled JSON body with the full-response deadline after HTTP 200", async () => {
    const upstream = controlledResponse("application/json");
    upstream.push('{"choices":[');
    execute.mockResolvedValue(upstream.response);
    const task = run();
    await vi.advanceTimersByTimeAsync(121);
    const response = await task;
    expect(response.status).toBe(504);
    expect(await response.text()).toContain("Response deadline exceeded");
    expect(execute.mock.calls[0][0].aborted).toBe(true);
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: 504, reason: "Response deadline exceeded",
    }));
  });

  it.each([new Error("client went away"), "custom client reason"])("keeps caller cancellation neutral for %s", async (reason) => {
    const caller = new AbortController();
    execute.mockImplementation(() => new Promise(() => {}));
    const task = run({ signal: caller.signal });
    await pump();
    caller.abort(reason);
    const response = await task;
    expect(response.status).toBe(499);
    expect(execute.mock.calls[0][0].aborted).toBe(true);
    expect(health.freeze).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("does not start work for an already cancelled request", async () => {
    const caller = new AbortController();
    caller.abort();
    expect((await run({ signal: caller.signal })).status).toBe(499);
    expect(health.get).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("distinguishes the overall Combo deadline from a neutral client abort", async () => {
    const budget = new AbortController();
    execute.mockImplementation(() => new Promise(() => {}));
    const task = run({ signal: budget.signal });
    await pump();
    budget.abort(createComboDeadlineError());
    const response = await task;
    expect(response.status).toBe(504);
    expect(await response.text()).toContain("Response deadline exceeded");
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: 504, reason: "Response deadline exceeded",
    }));
    expect(execute.mock.calls[0][0].aborted).toBe(true);
  });

  it("cancels a late response body when an executor ignores the deadline abort", async () => {
    const upstream = controlledResponse("application/json");
    let resolveExecute;
    execute.mockImplementation(() => new Promise((resolve) => { resolveExecute = resolve; }));
    const task = run({ body: { stream: true } });
    await vi.advanceTimersByTimeAsync(41);
    expect((await task).status).toBe(504);
    resolveExecute(upstream.response);
    await pump();
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
    expect(health.freeze).toHaveBeenCalledTimes(1);
  });
});

describe("Combo HTTP failure classification", () => {
  it.each([400, 413, 422])("passes HTTP %s through without freezing the provider/model", async (status) => {
    const payload = { error: { message: "Invalid request" } };
    execute.mockResolvedValue(Response.json(payload, { status }));
    const response = await run();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(payload);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it.each([401, 402, 403, 404, 408, 429, 500, 502, 503, 504])("freezes HTTP %s exactly once", async (status) => {
    execute.mockResolvedValue(new Response("Provider unavailable", { status }));
    const response = await run();
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("Provider unavailable");
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status, reason: `Upstream HTTP ${status}` }));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["60", undefined, NOW + 60_000],
    [new Date(NOW + 90_000).toUTCString(), undefined, NOW + 90_000],
    ["30", new Date(NOW + 120_000).toISOString(), NOW + 120_000],
    ["180", new Date(NOW + 120_000).toISOString(), NOW + 180_000],
  ])("preserves the later absolute Retry-After deadline (%s, %s)", async (header, retryAfter, expected) => {
    execute.mockResolvedValue(Response.json({ error: { message: "Quota exhausted" }, retryAfter }, {
      status: 429, headers: { "retry-after": header },
    }));
    expect((await run()).status).toBe(429);
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: 429, retryAfterMs: expected,
    }));
  });

  it("does not increment failure twice when recording the first failure itself rejects", async () => {
    execute.mockResolvedValue(new Response("Unavailable", { status: 503 }));
    health.freeze.mockRejectedValue(new Error("storage failed"));
    expect((await run()).status).toBeGreaterThanOrEqual(500);
    expect(health.freeze).toHaveBeenCalledTimes(1);
  });
});

describe("Combo completed JSON and probe validation", () => {
  it.each([
    ["OpenAI text", completion],
    ["OpenAI tool call", { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "search", arguments: "{}" } }] } }] }],
    ["OpenAI reasoning", { choices: [{ message: { reasoning_content: "Considering the answer" } }] }],
    ["legacy text", { choices: [{ text: "OK" }] }],
    ["Claude", { type: "message", content: [{ type: "text", text: "OK" }] }],
    ["Gemini", { candidates: [{ content: { parts: [{ text: "OK" }] } }] }],
    ["Responses", { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }],
  ])("accepts meaningful %s without clearing any existing circuit", async (_, json) => {
    execute.mockResolvedValue(Response.json(json));
    const response = await run();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(json);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it.each([
    {}, { choices: [] }, { choices: [{ message: { content: "  " } }] },
    { ...completion, error: { message: "Partial upstream failure" } },
  ])("rejects unusable or failed HTTP 200 JSON: %j", async (json) => {
    execute.mockResolvedValue(Response.json(json));
    expect((await run()).status).toBe(502);
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 502, reason: "Invalid completion response" }));
  });

  it("rejects a malformed completed JSON body", async () => {
    execute.mockResolvedValue(new Response('{"choices":', { headers: { "content-type": "application/json" } }));
    expect((await run()).status).toBe(502);
    expect(health.freeze).toHaveBeenCalledTimes(1);
  });

  it("lets a recovery probe execute despite the circuit and requires actual answer text", async () => {
    health.get.mockResolvedValue({ state: "open", nextProbeAt: NOW + 60_000 });
    execute.mockResolvedValue(Response.json({ choices: [{ message: { reasoning_content: "Only reasoning" } }] }));
    expect((await run({ probe: true })).status).toBe(502);
    expect(health.get).not.toHaveBeenCalled();
    expect(health.freeze).not.toHaveBeenCalled();
    execute.mockResolvedValue(Response.json(completion));
    expect((await run({ probe: true })).status).toBe(200);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("times out a recovery probe without recording a foreground failure", async () => {
    execute.mockImplementation(() => new Promise(() => {}));
    const task = run({ probe: true });
    await vi.advanceTimersByTimeAsync(51);
    expect((await task).status).toBe(504);
    expect(execute.mock.calls[0][0].aborted).toBe(true);
    expect(health.freeze).not.toHaveBeenCalled();
  });
});

describe("Combo streaming output guard", () => {
  it("does not treat SSE headers, role metadata, or heartbeats as output or restart the first timer", async () => {
    const upstream = controlledResponse();
    execute.mockResolvedValue(upstream.response);
    let resolved = false;
    const task = run({ body: { stream: true } }).then((response) => { resolved = true; return response; });
    await vi.advanceTimersByTimeAsync(10);
    upstream.push('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    await vi.advanceTimersByTimeAsync(10);
    upstream.push(': keepalive\n\ndata: {"type":"ping"}\n\n');
    await vi.advanceTimersByTimeAsync(19);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await task).status).toBe(504);
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "First response timeout", status: 504 }));
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['data: {"error":{"message":"upstream failed"}}\n\n', "error event"],
    ['data: [DONE]\n\n', "empty completed stream"],
    ['data: {"choices":\n\n', "malformed SSE JSON"],
  ])("returns a fallback-compatible 502 before committing %s (%s)", async (frames) => {
    const upstream = controlledResponse();
    upstream.push(frames);
    upstream.close();
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).not.toContain("data:");
    expect(health.freeze).toHaveBeenCalledTimes(1);
  });

  it("preserves exact SSE bytes on a successful completed stream", async () => {
    const upstream = controlledResponse();
    const expected = ': keepalive\n\n' + contentFrame("Привет") + doneFrame;
    upstream.push(expected);
    upstream.close();
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
    expect(health.freeze).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("finishes on a definitive DONE marker without requiring the provider socket to close", async () => {
    const upstream = controlledResponse();
    const expected = contentFrame() + doneFrame;
    upstream.push(expected);
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    let outcome;
    const reading = response.text().then((text) => { outcome = { text }; }, (error) => { outcome = { error }; });
    await pump();
    expect(outcome).toEqual({ text: expected });
    await reading;
    await vi.advanceTimersByTimeAsync(100);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("preserves usage arriving after finish_reason and before the definitive DONE marker", async () => {
    const upstream = controlledResponse();
    const prefix = contentFrame() + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
    upstream.push(prefix);
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    const reading = response.text();
    await vi.advanceTimersByTimeAsync(10);
    const tail = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n';
    upstream.push(tail);
    upstream.close();
    expect(await reading).toBe(prefix + tail);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("does not blame the provider for a slow consumer pause longer than the idle budget", async () => {
    const upstream = controlledResponse();
    const prefix = contentFrame();
    upstream.push(prefix);
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    // The consumer has not requested the next bytes. The provider has already
    // made them available, so this wait is downstream backpressure, not a stall.
    await vi.advanceTimersByTimeAsync(10);
    const tail = contentFrame("tail") + doneFrame;
    upstream.push(tail);
    upstream.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(execute.mock.calls[0][0].aborted).toBe(false);
    expect(await response.text()).toBe(prefix + tail);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("freezes and errors an already committed stalled stream without another executor attempt", async () => {
    const upstream = controlledResponse();
    upstream.push(contentFrame());
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
    const pendingRead = reader.read().then(() => null, (error) => error);
    await vi.advanceTimersByTimeAsync(31);
    expect(await pendingRead).toBeInstanceOf(Error);
    expect(response.status).toBe(200);
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 504, reason: "Stream stalled" }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].aborted).toBe(true);
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
  });

  it("reports an unfinished stream after its first output as a body error and freezes it once", async () => {
    const upstream = controlledResponse();
    upstream.push(contentFrame());
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    const reader = response.body.getReader();
    await reader.read();
    const tail = reader.read().then(() => null, (error) => error);
    upstream.close();
    expect(await tail).toBeInstanceOf(Error);
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 502 }));
  });

  it.each([
    { choices: [{ delta: { reasoning_content: "Checking the calculation" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: "{" } }] } }] },
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Considering" } },
    { type: "response.output_text.delta", delta: "OK" },
  ])("treats reasoning/tool/content progress as real streaming output: %j", async (frame) => {
    const upstream = controlledResponse();
    upstream.push(`data: ${JSON.stringify(frame)}\n\n`);
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    const reader = response.body.getReader();
    expect((await reader.read()).done).toBe(false);
    const tail = reader.read();
    await vi.advanceTimersByTimeAsync(20);
    upstream.push(contentFrame("next"));
    expect((await tail).done).toBe(false);
    const finish = reader.read();
    await vi.advanceTimersByTimeAsync(20);
    upstream.push(doneFrame);
    upstream.close();
    expect((await finish).done).toBe(false);
    expect((await reader.read()).done).toBe(true);
    expect(health.freeze).not.toHaveBeenCalled();
  });

  it("does not refresh the post-output idle timer on heartbeat-only frames", async () => {
    const upstream = controlledResponse();
    upstream.push(contentFrame());
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    const reader = response.body.getReader();
    await reader.read();
    let next = reader.read();
    await vi.advanceTimersByTimeAsync(15);
    upstream.push(': keepalive\n\n');
    await next;
    next = reader.read().then(() => null, (error) => error);
    await vi.advanceTimersByTimeAsync(16);
    expect(await next).toBeInstanceOf(Error);
    expect(health.freeze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "Stream stalled" }));
  });

  it("treats caller abort after streamed output as neutral", async () => {
    const caller = new AbortController();
    const upstream = controlledResponse();
    upstream.push(contentFrame());
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true }, signal: caller.signal });
    const reader = response.body.getReader();
    await reader.read();
    const tail = reader.read().then(() => null, (error) => error);
    caller.abort(new Error("client gone"));
    expect(await tail).toBeInstanceOf(Error);
    expect(health.freeze).not.toHaveBeenCalled();
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
  });

  it("treats downstream reader cancellation as neutral even with a pending upstream read", async () => {
    const upstream = controlledResponse();
    upstream.push(contentFrame());
    execute.mockResolvedValue(upstream.response);
    const response = await run({ body: { stream: true } });
    const reader = response.body.getReader();
    await reader.read();
    const pending = reader.read();
    await pump();
    await reader.cancel("consumer no longer needs output");
    await pending;
    await pump();
    expect(health.freeze).not.toHaveBeenCalled();
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
  });
});
