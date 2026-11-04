// Drives the real handleChatCore transport guard with the executor's HTTP call
// mocked. The assertion target is credentials.runtimeTransport — exactly what
// DefaultExecutor.buildUrl reads — so a wrong decision shows as the wrong URL.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: false, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: () => null,
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const RESPONSES_URL = "https://api.openai.com/v1/responses";

const RESPONSE_BY_FORMAT = {
  openai: {
    id: "chatcmpl-1", object: "chat.completion", model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
  "openai-responses": {
    id: "resp_1", object: "response", created_at: 0, status: "completed", model: "test",
    output: [{
      type: "message", id: "msg_1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }],
  },
};

function chatTools(count) {
  return Array.from({ length: count }, (_, i) => ({
    type: "function",
    function: { name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: "object", properties: {}, additionalProperties: false } },
  }));
}

async function route({ model = "gpt-4o", toolCount = 1, sourceFormat = "openai", providerThinking } = {}) {
  executeMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify(RESPONSE_BY_FORMAT[sourceFormat]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    url: CHAT_URL,
    headers: {},
    transformedBody: null,
  });

  const body = sourceFormat === "openai-responses"
    ? {
      model: `openai/${model}`,
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: chatTools(toolCount).map((t) => ({
        type: "function",
        name: t.function.name,
        parameters: t.function.parameters,
      })),
    }
    : {
      model: `openai/${model}`,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      tools: chatTools(toolCount),
    };

  const credentials = { apiKey: "test-key", providerSpecificData: {} };
  const result = await handleChatCore({
    body,
    modelInfo: { provider: "openai", model },
    credentials,
    connectionId: "openai-route-test",
    sourceFormatOverride: sourceFormat,
    providerThinking,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  });

  return {
    result,
    runtimeTransport: credentials.runtimeTransport ?? null,
    sentBody: executeMock.mock.calls.at(-1)?.[0]?.body,
  };
}

describe("OpenAI tool-count transport guard (real handleChatCore)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps a Chat client at or below 128 tools on Chat Completions", async () => {
    const { result, runtimeTransport } = await route({ toolCount: 128 });
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(CHAT_URL);
  });

  it("moves a Chat client with 129 tools to Responses", async () => {
    const { result, runtimeTransport, sentBody } = await route({ toolCount: 129 });
    expect(result.success).toBe(true);
    expect(runtimeTransport?.baseUrl).toBe(RESPONSES_URL);
    expect(sentBody.tools).toHaveLength(129);
    expect(sentBody.messages).toBeUndefined();
    expect(Array.isArray(sentBody.input)).toBe(true);
  });

  it("moves a Chat client with 179 tools (ZCode) to Responses", async () => {
    const { runtimeTransport, sentBody } = await route({ toolCount: 179 });
    expect(runtimeTransport?.baseUrl).toBe(RESPONSES_URL);
    expect(sentBody.tools).toHaveLength(179);
  });

  it("routes a Responses client to Responses regardless of tool count", async () => {
    const { runtimeTransport } = await route({ toolCount: 5, sourceFormat: "openai-responses" });
    expect(runtimeTransport?.baseUrl).toBe(RESPONSES_URL);
  });

  it("routes GPT-6 tool requests to Responses even under the limit", async () => {
    const { runtimeTransport } = await route({ model: "gpt-6-astra", toolCount: 2 });
    expect(runtimeTransport?.baseUrl).toBe(RESPONSES_URL);
  });

  it("nests a server-side thinking mode as reasoning.effort on the Responses wire", async () => {
    const { runtimeTransport, sentBody } = await route({
      model: "gpt-6-astra",
      toolCount: 3,
      providerThinking: { mode: "xhigh" },
    });
    expect(runtimeTransport?.baseUrl).toBe(RESPONSES_URL);
    expect(sentBody.reasoning_effort).toBeUndefined();
    expect(sentBody.reasoning).toMatchObject({ effort: "xhigh" });
  });

  it("does not invent a reasoning field when the client asked for none", async () => {
    const { runtimeTransport, sentBody } = await route({
      model: "gpt-6-astra",
      toolCount: 179,
    });
    expect(runtimeTransport?.baseUrl).toBe(RESPONSES_URL);
    expect(sentBody.reasoning_effort).toBeUndefined();
    expect(sentBody.reasoning).toBeUndefined();
  });
});
