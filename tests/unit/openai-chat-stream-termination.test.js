import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { SSE_DONE } from "../../open-sse/utils/sseConstants.js";

const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;
const antigravity = (parts = [{ text: "OK" }], finishReason = "STOP") => sse({
  response: {
    responseId: "sse-terminal-test",
    candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
  },
});

async function transform(input, targetFormat = FORMATS.ANTIGRAVITY, sourceFormat = FORMATS.OPENAI) {
  const upstream = new ReadableStream({
    start(controller) {
      for (const chunk of Array.isArray(input) ? input : [input]) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(upstream.pipeThrough(createSSEStream({
    targetFormat, sourceFormat, provider: "antigravity", model: "claude-opus-5-5", trackDone: vi.fn(),
  }))).text();
}

function expectCompleted(output, finishReason = "stop") {
  expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  expect(output.endsWith(SSE_DONE)).toBe(true);
  expect(output.indexOf(`"finish_reason":"${finishReason}"`)).toBeGreaterThanOrEqual(0);
  expect(output.indexOf(`"finish_reason":"${finishReason}"`)).toBeLessThan(output.indexOf(SSE_DONE));
}

describe("OpenAI Chat SSE termination after translation", () => {
  it("terminates a complete Antigravity answer after its finish reason and usage", async () => {
    const output = await transform(antigravity());
    expectCompleted(output);
    expect(output).toContain('"content":"OK"');
    expect(output).toContain('"completion_tokens":3');
  });

  it("emits one DONE even when the upstream sends its own sentinel", async () => {
    expectCompleted(await transform([antigravity(), SSE_DONE, SSE_DONE]));
  });

  it("preserves a terminal frame without its trailing newline", async () => {
    expectCompleted(await transform(antigravity().trimEnd()));
  });

  it("terminates tool calls without changing their finish reason", async () => {
    const output = await transform(antigravity([{ functionCall: { name: "lookup", args: { id: 1 } } }]));
    expectCompleted(output, "tool_calls");
    expect(output).toContain('"name":"lookup"');
  });

  it("terminates native Claude responses translated to OpenAI", async () => {
    expectCompleted(await transform([
      sse({ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 7 } } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
      sse({ type: "message_stop" }),
    ], FORMATS.CLAUDE));
  });

  it("terminates an Ollama final frame without a newline", async () => {
    expectCompleted(await transform(JSON.stringify({
      model: "qwen3", message: { content: "OK" }, done: true, done_reason: "stop",
      prompt_eval_count: 7, eval_count: 3,
    }), FORMATS.OLLAMA));
  });

  it("terminates completed Responses events translated to Chat", async () => {
    expectCompleted(await transform([
      sse({ type: "response.output_text.delta", delta: "OK" }),
      sse({ type: "response.completed", response: { status: "completed" } }),
    ], FORMATS.OPENAI_RESPONSES));
  });

  it("does not confirm an Antigravity stream that ended without a finish reason", async () => {
    const output = await transform(antigravity([{ text: "partial" }], null));
    expect(output).toContain('"content":"partial"');
    expect(output).not.toContain(SSE_DONE);
    expect(output).not.toContain('"finish_reason":"stop"');
  });

  it("does not confirm a Responses stream that ended before its terminal event", async () => {
    const output = await transform(sse({ type: "response.output_text.delta", delta: "partial" }), FORMATS.OPENAI_RESPONSES);
    expect(output).toContain('"content":"partial"');
    expect(output).not.toContain(SSE_DONE);
  });

  it("keeps native Claude and Responses terminal events", async () => {
    const claude = await transform(antigravity(), FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    expect(claude).toContain("event: message_stop");
    expect(claude).not.toContain(SSE_DONE);
    const responses = await transform(antigravity(), FORMATS.ANTIGRAVITY, FORMATS.OPENAI_RESPONSES);
    expect(responses).toContain("event: response.completed");
    expect(responses).not.toContain(SSE_DONE);
  });
});
