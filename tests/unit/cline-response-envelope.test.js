import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), usage: vi.fn(async () => {}) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => Object.fromEntries(["logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse", "logConvertedResponse", "logError"].map(name => [name, vi.fn()])),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: mocks.usage,
}));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const completion = {
  id: "chatcmpl-cline", object: "chat.completion", model: "z-ai/glm-5.3-flash", created: 1788966812,
  choices: [{ index: 0, message: { role: "assistant", content: "OK", reasoning: "Short reasoning" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 17, completion_tokens: 40, total_tokens: 57 },
};

async function run(payload, provider = "clinepass", format = "openai", stream = false) {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }));
  const onRequestSuccess = vi.fn();
  const body = { model: "cline-pass/glm-5.3-flash", messages: [{ role: "user", content: "Reply with OK" }], max_tokens: 128, stream };
  const result = await handleChatCore({
    body, modelInfo: { provider, model: body.model }, credentials: { apiKey: "test-api-key" },
    sourceFormatOverride: format, connectionId: "cline-envelope-test", onRequestSuccess,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
  });
  return { result, onRequestSuccess };
}

beforeEach(() => vi.clearAllMocks());

describe("Cline JSON envelopes through chatCore and the real executor", () => {
  it.each(["clinepass", "cline"])("unwraps %s completions before returning text and accounting usage", async provider => {
    const { result, onRequestSuccess } = await run({ success: true, data: completion }, provider);
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.choices[0].message.content).toBe("OK");
    expect(body.usage.completion_tokens).toBe(40);
    expect(body.usage.prompt_tokens).toBeGreaterThanOrEqual(17);
    expect(body).not.toHaveProperty("data");
    expect(body).not.toHaveProperty("success");
    expect(onRequestSuccess).toHaveBeenCalledOnce();
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({ tokens: expect.objectContaining(completion.usage) }));
  });

  it("still accepts flat OpenAI completions", async () => {
    const { result } = await run(completion);
    expect((await result.response.json()).choices[0].message.content).toBe("OK");
  });

  it.each(["openai-responses", "claude"])("translates the unwrapped completion to %s", async format => {
    const { result } = await run({ success: true, data: completion }, "clinepass", format);
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(JSON.stringify(body)).toContain('"text":"OK"');
    expect(body).not.toHaveProperty("data");
    expect(body).not.toHaveProperty("choices");
  });

  it.each([
    { success: false, error: { message: "Cline quota unavailable" } },
    { success: true, data: { error: { message: "Cline quota unavailable" } } },
    { success: true, data: { choices: [] } },
    { success: true, data: null },
  ])("does not mark an unsuccessful or malformed envelope as success: %j", async payload => {
    const { result, onRequestSuccess } = await run(payload);
    expect(result.response.status).toBe(502);
    expect(result.success).toBe(false);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("preserves tool calls from the envelope for Responses clients", async () => {
    const payload = structuredClone(completion);
    payload.choices[0] = { index: 0, finish_reason: "tool_calls", message: {
      role: "assistant", content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"id":1}' } }],
    } };
    const { result } = await run({ success: true, data: payload }, "clinepass", "openai-responses");
    const body = await result.response.json();
    expect(body.output).toContainEqual(expect.objectContaining({ type: "function_call", name: "lookup", arguments: '{"id":1}' }));
  });
});
