import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "open-sse/translator/formats.js";
import { isFailedComboCompletion, validateComboUpstreamResponse } from "open-sse/utils/comboUpstream.js";

const encoder = new TextEncoder();
const textDelta = { choices: [{ delta: { content: "OK" }, finish_reason: null }] };
const finished = { choices: [{ delta: {}, finish_reason: "stop" }] };
const sse = (value, event) => `${event ? `event: ${event}\n` : ""}data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;

function responseFromChunks(chunks, contentType = "text/event-stream") {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) controller.close();
      else controller.enqueue(typeof chunks[index] === "string" ? encoder.encode(chunks[index++]) : chunks[index++]);
    },
  }), { headers: contentType ? { "content-type": contentType } : {} });
}

function checked(text, format = FORMATS.OPENAI, contentType = "text/event-stream") {
  return validateComboUpstreamResponse(responseFromChunks([text], contentType), { format });
}

describe("strict real-upstream completion validation for Combo", () => {
  it.each([
    ["OpenAI finish", FORMATS.OPENAI, sse(textDelta) + sse(finished)],
    ["OpenAI DONE", FORMATS.OPENAI, sse(textDelta) + sse("[DONE]")],
    ["Claude", FORMATS.CLAUDE, sse({ type: "content_block_delta", delta: { text: "OK" } }) + sse({ type: "message_stop" })],
    ["Responses completed", FORMATS.OPENAI_RESPONSES, sse({ type: "response.output_text.delta", delta: "OK" }) + sse({ type: "response.completed", response: { status: "completed" } })],
    ["Responses incomplete at token budget", FORMATS.OPENAI_RESPONSES, sse({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })],
    ["Gemini", FORMATS.GEMINI, sse({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] })],
    ["Antigravity wrapper", FORMATS.ANTIGRAVITY, sse({ response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "MAX_TOKENS" }] } })],
  ])("preserves byte-for-byte a genuine %s terminal", async (_, format, text) => {
    expect(await checked(text, format).text()).toBe(text);
  });

  it("recognizes Responses SSE without a Content-Type header", async () => {
    const text = sse({ response: { status: "completed" } }, "response.completed");
    expect(await checked(text, FORMATS.OPENAI_RESPONSES, "").text()).toBe(text);
  });

  it("validates Ollama NDJSON including a final line without newline", async () => {
    const text = JSON.stringify({ message: { content: "OK" }, done: false }) + "\n"
      + JSON.stringify({ done: true, done_reason: "stop", eval_count: 1 });
    expect(await checked(text, FORMATS.OLLAMA, "application/x-ndjson").text()).toBe(text);
    await expect(checked(JSON.stringify({ message: { content: "partial" }, done: false }), FORMATS.OLLAMA, "application/x-ndjson").text())
      .rejects.toThrow("without a completion terminal");
  });

  it.each([
    ["partial answer", sse(textDelta)],
    ["role only", sse({ choices: [{ delta: { role: "assistant" } }] })],
    ["heartbeat only", ": ping\n\n"],
    ["no frames", ""],
  ])("rejects EOF after %s before translators can fabricate success", async (_, text) => {
    await expect(checked(text).text()).rejects.toThrow("without a completion terminal");
  });

  it.each([
    { error: { message: "upstream failed" } },
    { choices: [{ delta: {}, finish_reason: "stop", native_finish_reason: "network_error" }] },
    { choices: [{ delta: {}, finish_reason: "failed" }] },
    { type: "response.failed", response: { status: "failed" } },
    { type: "response.incomplete", response: { incomplete_details: { reason: "server_error" } } },
    { type: "error", error: { type: "overloaded_error" } },
    { response: { error: { message: "failed" } } },
    { data: { status: "failed" } },
  ])("rejects upstream error even after partial content: %j", async (error) => {
    await expect(checked(sse(textDelta) + sse(error)).text()).rejects.toThrow("failed completion");
  });

  it("does not let an already seen terminal hide a later upstream error", async () => {
    await expect(checked(sse(textDelta) + sse(finished) + sse({ error: "late gateway failure" })).text())
      .rejects.toThrow("failed completion");
  });

  it("rejects event-only failure and malformed JSON instead of swallowing it", async () => {
    await expect(checked("event: error\n\n").text()).rejects.toThrow("failed completion");
    await expect(checked(sse(textDelta) + "data: {broken}\n\n" + sse("[DONE]")).text()).rejects.toThrow("malformed");
  });

  it("preserves usage frames arriving after finish_reason", async () => {
    const text = sse(textDelta) + sse(finished) + sse({ choices: [], usage: { completion_tokens: 2 } }) + sse("[DONE]");
    const result = checked(text);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(await result.text()).toBe(text);
  });

  it("handles split UTF-8 characters, CRLF delimiters and multiline SSE data", async () => {
    const text = ': ping\r\n\r\nevent: completion\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"Привет 🌍"},"finish_reason":"stop"}]}\r\n\r\n';
    const bytes = encoder.encode(text);
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const result = validateComboUpstreamResponse(responseFromChunks(chunks), { format: FORMATS.OPENAI });
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
  });

  it("rejects invalid UTF-8 and bounds an incomplete frame in bytes", async () => {
    const bad = validateComboUpstreamResponse(responseFromChunks([new Uint8Array([0xC3, 0x28])]), { format: FORMATS.OPENAI });
    await expect(bad.text()).rejects.toThrow("UTF-8");
    const large = validateComboUpstreamResponse(responseFromChunks(["data: " + "🌍".repeat(20)]), { format: FORMATS.OPENAI, maxBufferedBytes: 40 });
    await expect(large.text()).rejects.toThrow("buffer limit");
  });

  it("bounds one complete giant frame without capping a healthy long stream", async () => {
    const large = validateComboUpstreamResponse(responseFromChunks([sse({ data: "x".repeat(100) })]), { format: FORMATS.OPENAI, maxBufferedBytes: 80 });
    await expect(large.text()).rejects.toThrow("buffer limit");
    const text = Array.from({ length: 100 }, () => sse(textDelta)).join("") + sse(finished);
    const normal = validateComboUpstreamResponse(responseFromChunks([text]), { format: FORMATS.OPENAI, maxBufferedBytes: 100 });
    expect(await normal.text()).toBe(text);
  });

  it("propagates downstream cancellation and does not eagerly drain upstream", async () => {
    const cancel = vi.fn();
    let pulled = 0;
    const source = new Response(new ReadableStream({
      pull(controller) { pulled++; controller.enqueue(encoder.encode(sse(textDelta))); },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } });
    const result = validateComboUpstreamResponse(source, { format: FORMATS.OPENAI });
    const reader = result.body.getReader();
    await reader.read();
    await reader.cancel("caller left");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledWith("caller left");
    expect(pulled).toBeLessThan(5);
  });

  it("leaves binary, ordinary JSON and HTTP failures to their existing handlers", async () => {
    for (const [format, contentType] of [[FORMATS.KIRO, "application/vnd.amazon.eventstream"], [FORMATS.CURSOR, "application/proto"], [FORMATS.OPENAI, "application/json"]]) {
      const source = responseFromChunks(["unparsed bytes"], contentType);
      expect(validateComboUpstreamResponse(source, { format })).toBe(source);
    }
    const rejected = new Response("upstream failure", { status: 502 });
    expect(validateComboUpstreamResponse(rejected, { format: FORMATS.OPENAI })).toBe(rejected);
  });
});

describe("upstream JSON failure predicate", () => {
  it.each([
    { error: "failed" }, { success: false }, { status: "failed" },
    { response: { status: "failed" } }, { data: { error: "failed" } },
    { choices: [{ finish_reason: "failed", message: { content: "partial" } }] },
    { choices: [{ finish_reason: "in_progress", message: { content: "partial" } }] },
    { choices: [{ native_finish_reason: "network_error", message: { content: "partial" } }] },
  ])("detects failure before its metadata can be lost: %j", (json) => {
    expect(isFailedComboCompletion(json)).toBe(true);
  });

  it("accepts ordinary completed data, benign null errors and token-limited output", () => {
    expect(isFailedComboCompletion({ error: null, choices: [{ finish_reason: "length", message: { content: "OK" } }] })).toBe(false);
    expect(isFailedComboCompletion({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).toBe(false);
    expect(isFailedComboCompletion(null)).toBe(false);
  });
});
