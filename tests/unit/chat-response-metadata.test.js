import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { execute, getPricing } = vi.hoisted(() => ({ execute: vi.fn(), getPricing: vi.fn() }));
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({ getPricing }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: provider => ({ noAuth: true, execute: options => execute(provider, options) }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
    logProviderResponse() {}, logConvertedResponse() {}, logError() {},
  }),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { transformToOllama } = await import("../../open-sse/utils/ollamaTransform.js");
const { augmentModelsWithCapacityAdapter } = await import("../../open-sse/services/capacityAdapter.js");

const log = { debug() {}, info() {}, warn() {}, error() {} };
const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
const completion = model => ({
  id: "chatcmpl-test", object: "chat.completion", ...(model ? { model } : {}),
  choices: [{ index: 0, message: { role: "assistant", content: "Привет" }, finish_reason: "stop" }], usage,
});
const chunk = (delta, model, finish = null) => ({
  id: "chatcmpl-test", object: "chat.completion.chunk", ...(model ? { model } : {}),
  choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}),
});
const sse = frames => frames.map(frame => typeof frame === "string"
  ? `data: ${frame}\n\n`
  : `${frame.type ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`).join("");
const frames = text => text.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]"))
  .map(line => JSON.parse(line.slice(5).trim()));

function respond(payload, { format = FORMATS.OPENAI, stream = false, sentModel, split = false } = {}) {
  execute.mockImplementationOnce(async (_provider, options) => {
    const bytes = new TextEncoder().encode(stream ? payload : JSON.stringify(payload));
    const body = split ? new ReadableStream({
      start(controller) {
        // Split UTF-8 and JSON tokens across reads, including the model name.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }) : bytes;
    return {
      response: new Response(body, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }),
      responseFormat: format,
      transformedBody: { ...options.body, ...(sentModel ? { model: sentModel } : {}) },
    };
  });
}

function request({ provider = "openai-compatible-primary", model = "gpt-4o", format = FORMATS.OPENAI, stream = false, messages = [{ role: "user", content: "hello" }] } = {}) {
  const body = format === FORMATS.OPENAI_RESPONSES
    ? { model, input: "hello", stream }
    : { model, messages, stream, max_tokens: 32 };
  return handleChatCore({
    body, modelInfo: { provider, model }, credentials: {}, log,
    sourceFormatOverride: format,
    clientRawRequest: { endpoint: "/v1/test", body: { ...body, model: "user-alias" }, headers: {} },
  });
}

beforeEach(() => { execute.mockReset(); getPricing.mockResolvedValue({ "openai-compatible-primary": { "gpt-4o": { input: 2, output: 4 } } }); });

describe("client response identity through chatCore", () => {
  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE])("reports the upstream revision for %s JSON", async format => {
    respond({ ...completion("gpt-4o-2024-08-06"), provider: "upstream-label" });
    const result = await request({ format });
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(body).toMatchObject({ provider: "openai-compatible-primary", model: "gpt-4o-2024-08-06" });
  });

  it("uses the executed model when upstream omits it", async () => {
    respond(completion(), { sentModel: "deployment-model-v2" });
    const result = await request({ provider: "openai-compatible-custom", model: "configured-alias(high)" });
    expect(await result.response.json()).toMatchObject({ provider: "openai-compatible-custom", model: "deployment-model-v2" });
  });

  it("strips routing presets from the fallback model", async () => {
    respond(completion());
    const result = await request({ model: "gpt-4o(high)" });
    expect(await result.response.json()).toMatchObject({ provider: "openai-compatible-primary", model: "gpt-4o" });
  });

  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("preserves native Gemini modelVersion when translating to %s", async format => {
    respond({
      modelVersion: "gemini-2.5-flash-001",
      candidates: [{ content: { parts: [{ text: "Привет" }] }, finishReason: "STOP" }],
    }, { format: FORMATS.GEMINI });
    const result = await request({ provider: "gemini", model: "gemini-2.5-flash", format });
    expect(await result.response.json()).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash-001" });
  });

  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE])("retains stream identity and content for %s", async format => {
    respond(sse([
      chunk({ role: "assistant" }, "gpt-4o-2024-08-06"),
      chunk({ content: "Привет" }), chunk({}, null, "stop"), "[DONE]",
    ]), { stream: true, split: true });
    const result = await request({ format, stream: true });
    expect(result.success).toBe(true);
    const text = await result.response.text();
    const events = frames(text);
    const envelopes = format === FORMATS.OPENAI ? events
      : format === FORMATS.OPENAI_RESPONSES ? events.filter(e => e.response).map(e => e.response)
        : events.filter(e => e.type === "message_start").map(e => e.message);
    expect(envelopes.length).toBeGreaterThan(0);
    for (const envelope of envelopes) expect(envelope).toMatchObject({ provider: "openai-compatible-primary", model: "gpt-4o-2024-08-06" });
    expect(text).toContain("Привет");
    if (format === FORMATS.OPENAI_RESPONSES) expect(events.some(e => e.type === "response.completed")).toBe(true);
  });

  it("fills in missing model on every passthrough chunk, including an unterminated tail", async () => {
    respond(sse([chunk({ role: "assistant" }), chunk({ content: "Привет" }), chunk({}, null, "stop")]).trimEnd(),
      { stream: true, sentModel: "actual-model" });
    const result = await request({ stream: true });
    const text = await result.response.text();
    for (const event of frames(text)) expect(event).toMatchObject({ provider: "openai-compatible-primary", model: "actual-model" });
    expect(text).toContain("[DONE]");
  });

  it("keeps upstream identity across Claude-to-Chat translation", async () => {
    respond(sse([
      { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-revision", content: [], usage: { input_tokens: 8, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Привет" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]), { format: FORMATS.CLAUDE, stream: true });
    const result = await request({ provider: "anthropic-compatible-test", model: "claude-alias", stream: true });
    const events = frames(await result.response.text());
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event).toMatchObject({ provider: "anthropic-compatible-test", model: "claude-revision" });
  });

  it("uses a model reported after the first frame when collecting forced Chat SSE", async () => {
    respond(sse([chunk({ role: "assistant" }), chunk({ content: "Привет" }, "actual-model"), chunk({}, null, "stop"), "[DONE]"]), { stream: true });
    const result = await request({ provider: "github", model: "gpt-4o", format: FORMATS.OPENAI_RESPONSES });
    expect(await result.response.json()).toMatchObject({ provider: "github", model: "actual-model", object: "response" });
  });

  it.each([false, true])("preserves native Responses identity (stream=%s)", async stream => {
    respond(sse([
      { type: "response.created", response: { id: "resp_test", object: "response", model: "gpt-revision", status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Привет" }] } },
      { type: "response.completed", response: { id: "resp_test", object: "response", status: "completed", usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } },
    ]), { format: FORMATS.OPENAI_RESPONSES, stream: true });
    const result = await request({ provider: "codex", model: "gpt-5.6-terra", format: FORMATS.OPENAI_RESPONSES, stream });
    expect(result.success).toBe(true);
    if (stream) {
      const envelopes = frames(await result.response.text()).filter(e => e.response).map(e => e.response);
      expect(envelopes).toHaveLength(2);
      for (const envelope of envelopes) expect(envelope).toMatchObject({ provider: "codex", model: "gpt-revision" });
    } else {
      expect(await result.response.json()).toMatchObject({ provider: "codex", model: "gpt-revision", status: "completed" });
    }
  });

  it("does not change tool arguments containing provider/model properties", async () => {
    const args = JSON.stringify({ provider: "user-supplied", model: "user-data" });
    const body = completion("actual-model");
    body.choices[0] = { index: 0, finish_reason: "tool_calls", message: {
      role: "assistant", content: null,
      tool_calls: [{ id: "call_test", type: "function", function: { name: "lookup", arguments: args } }],
    } };
    respond(body);
    const result = await request({ format: FORMATS.OPENAI_RESPONSES });
    const output = await result.response.json();
    expect(output).toMatchObject({ provider: "openai-compatible-primary", model: "actual-model" });
    expect(output.output.find(item => item.type === "function_call").arguments).toBe(args);
  });

  it("reports identity on native Responses compaction without touching encrypted state", async () => {
    const output = [{ type: "compaction", encrypted_content: "opaque-provider-state" }];
    respond({ object: "response.compaction", model: "gpt-compaction-revision", output }, { format: FORMATS.OPENAI_RESPONSES });
    const result = await request({ provider: "openai-compatible-compaction", format: FORMATS.OPENAI_RESPONSES });
    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({ provider: "openai-compatible-compaction", model: "gpt-compaction-revision", object: "response.compaction", output });
  });

  it("preserves identity through the native Ollama facade and its terminal records", async () => {
    respond(sse([chunk({ content: "Привет" }, "actual-model"), chunk({}, null, "stop"), "[DONE]"]), { stream: true });
    const result = await request({ stream: true });
    const text = await transformToOllama(result.response, "user-alias").text();
    const records = text.trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(record => record.message.content === "Привет")).toBe(true);
    expect(records.some(record => record.done)).toBe(true);
    for (const record of records) expect(record).toMatchObject({ provider: "openai-compatible-primary", model: "actual-model" });
  });

  it.each([false, true])("reports the successful Combo fallback (stream=%s)", async stream => {
    execute.mockResolvedValueOnce({ response: new Response("unavailable", { status: 503 }) });
    respond(stream ? sse([chunk({ content: "Привет" }, "fallback-revision"), chunk({}, null, "stop"), "[DONE]"])
      : completion("fallback-revision"), { stream });
    const result = await handleComboChat({
      body: { model: "Coding", stream }, models: ["openai/primary", "openai-compatible-backup/fallback"],
      log, comboName: "Coding", skipCooldown: true,
      handleSingleModel: async (_body, modelStr) => {
        const [provider, model] = modelStr.split("/");
        return (await request({ provider, model, stream })).response;
      },
    });
    const envelopes = stream ? frames(await result.text()) : [await result.json()];
    expect(execute).toHaveBeenCalledTimes(2);
    for (const envelope of envelopes) expect(envelope).toMatchObject({ provider: "openai-compatible-backup", model: "fallback-revision" });
  });

  it.each([false, true])("reports the model actually selected for vision (capacity adapter=%s)", async useAdapter => {
    const body = { model: "VisionCombo", stream: true, messages: [{ role: "user", content: [
      { type: "text", text: "Describe this image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ] }] };
    const models = useAdapter
      ? augmentModelsWithCapacityAdapter(["deepseek/deepseek-chat"], new Set(["vision"]), {
        capacityAdapter: { vision: { enabled: true, models: ["openai/gpt-4o"] } },
      })
      : ["deepseek/deepseek-chat", "openai/gpt-4o"];
    respond(sse([chunk({ content: "An image" }, "gpt-4o-vision-revision"), chunk({}, null, "stop"), "[DONE]"]), { stream: true });
    const result = await handleComboChat({
      body, models, log, comboName: "VisionCombo", skipCooldown: true,
      handleSingleModel: async (b, modelStr) => {
        const [provider, model] = modelStr.split("/");
        return (await request({ provider, model, stream: true, messages: b.messages })).response;
      },
    });
    const events = frames(await result.text());
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event).toMatchObject({ provider: "openai", model: "gpt-4o-vision-revision" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe("openai");
    expect(execute.mock.calls[0][1].body.messages[0].content).toContainEqual(body.messages[0].content[1]);
  });

  it("does not claim an executed model on an upstream error", async () => {
    execute.mockResolvedValueOnce({ response: new Response("unavailable", { status: 503 }) });
    const result = await request();
    expect(result.success).toBe(false);
    const body = await result.response.json();
    expect(body).not.toHaveProperty("provider");
    expect(body).not.toHaveProperty("model");
  });
});


describe("client-visible cost and headers", () => {
  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE])("JSON %s uses saved prices and raw counts before the context buffer", async format => {
    respond(completion("gpt-4o"));
    const result = await request({ format });
    const payload = await result.response.json();
    expect(payload.usage.cost).toBeCloseTo(0.000024, 12);
    expect(payload.usage.cost_details).toMatchObject({ currency: "USD", source: "pricing", estimated: true });
    expect(result.response.headers.get("x-9router-provider")).toBe("openai-compatible-primary");
    expect(result.response.headers.get("x-9router-model")).toBe("gpt-4o");
    expect(Number(result.response.headers.get("x-9router-cost"))).toBeCloseTo(payload.usage.cost, 12);
  });
  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE])("SSE %s retains cost after filtering and translation", async format => {
    respond(sse([chunk({ role: "assistant" }, "gpt-4o"), chunk({ content: "hello" }), chunk({}, null, "stop"), "[DONE]"]), { stream: true });
    const result = await request({ format, stream: true });
    const events = frames(await result.response.text());
    const priced = events.map(e => e.response || e.message || e).filter(e => e.usage?.cost !== undefined);
    expect(priced.length).toBeGreaterThan(0);
    expect(priced.at(-1).usage.cost).toBeCloseTo(0.000024, 12);
    expect(priced.at(-1)).toMatchObject({ provider: "openai-compatible-primary", model: "gpt-4o" });
  });
  it("preserves provider-reported pricing across the lossy JSON translator", async () => {
    respond({ ...completion("gpt-4o"), usage: { ...usage, cost: 0.123, cost_details: { upstream_inference_cost: 0.1 } } });
    const result = await request({ format: FORMATS.OPENAI_RESPONSES });
    expect((await result.response.json()).usage).toMatchObject({ cost: 0.123, cost_details: { source: "provider", estimated: false, upstream_inference_cost: 0.1 } });
  });
  it.each([FORMATS.OPENAI, FORMATS.CLAUDE])("marks estimated client usage as unpriced without raw upstream usage (%s)", async format => {
    const tail = chunk({}, "gpt-4o", "stop");
    delete tail.usage;
    respond(sse([chunk({ content: "hello" }, "gpt-4o"), tail, "[DONE]"]), { stream: true });
    const result = await request({ format, stream: true });
    const events = frames(await result.response.text());
    const terminal = events.findLast(event => event.usage);
    expect(terminal?.usage).toMatchObject({ cost: null, cost_details: { source: "unavailable", estimated: false } });
  });
  it("keeps cache, reasoning details and the provider bill through forced Responses SSE-to-JSON", async () => {
    respond(sse([
      { type: "response.created", response: { id: "r", model: "gpt-4o", object: "response", output: [] } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] } },
      { type: "response.completed", response: { id: "r", status: "completed", usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 1 }, cost: 0.07 } } },
    ]), { stream: true, format: FORMATS.OPENAI_RESPONSES });
    const result = await request({ provider: "codex", format: FORMATS.OPENAI_RESPONSES });
    expect((await result.response.json()).usage).toMatchObject({ cost: 0.07, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 1 } });
  });
});
