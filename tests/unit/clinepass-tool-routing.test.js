import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), usage: vi.fn(async () => {}) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => Object.fromEntries([
    "logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse",
    "logConvertedResponse", "logError",
  ].map(name => [name, vi.fn()])),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: mocks.usage,
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const model = "cline-pass/glm-5.3-flash";
const routing = { only: ["z-ai"], allow_fallbacks: false, require_parameters: true };
const tool = {
  type: "function",
  function: { name: "info", description: "Get application capabilities", parameters: { type: "object", properties: {} } },
};
const request = () => ({ model, messages: [{ role: "user", content: "Use info to describe the app" }], tools: [tool], max_tokens: 8000 });

beforeEach(() => vi.clearAllMocks());

describe("ClinePass GLM Flash automatic tool routing", () => {
  it.each([model, "z-ai/glm-5.3-flash", "glm-5.3-flash"])("routes %s to the verified backend without changing tool choice", id => {
    const body = { ...request(), model: id, reasoning: { effort: "xhigh" } };
    const result = new DefaultExecutor("clinepass").transformRequest(id, body);
    expect(result.provider).toEqual(routing);
    expect(result).not.toHaveProperty("tool_choice");
    expect(result.messages).toEqual(body.messages);
    expect(result.tools).toEqual(body.tools);
    expect(result.reasoning).toEqual({ effort: "xhigh" });
    expect(body.reasoning).toEqual({ effort: "xhigh" });
    expect(body).not.toHaveProperty("provider");
  });

  it("keeps explicit automatic selection automatic", () => {
    const body = { ...request(), tool_choice: "auto" };
    const result = new DefaultExecutor("clinepass").transformRequest(model, body);
    expect(result.provider).toEqual(routing);
    expect(result.tool_choice).toBe("auto");
  });

  it.each(["none", "required", { type: "function", function: { name: "info" } }])("preserves an explicit tool choice %j", choice => {
    const body = { ...request(), tool_choice: choice };
    const result = new DefaultExecutor("clinepass").transformRequest(model, body);
    expect(result).not.toHaveProperty("provider");
    expect(result.tool_choice).toEqual(choice);
  });

  it.each([undefined, []])("leaves requests without tools on the ordinary route (%j)", tools => {
    const body = { ...request(), tools };
    expect(new DefaultExecutor("clinepass").transformRequest(model, body)).not.toHaveProperty("provider");
  });

  it.each(["cline-pass/glm-5.3", "cline-pass/glm-5.2", "cline-pass/kimi-k3"])("does not change another model %s", id => {
    const body = { ...request(), model: id };
    expect(new DefaultExecutor("clinepass").transformRequest(id, body)).not.toHaveProperty("provider");
  });

  it.each(["cline", "openrouter"])("does not change another gateway %s", provider => {
    expect(new DefaultExecutor(provider).transformRequest(model, request())).not.toHaveProperty("provider");
  });

  it("honors the caller's explicit upstream provider preferences", () => {
    const provider = { order: ["relace"], ignore: ["open-inference"] };
    const body = { ...request(), provider };
    expect(new DefaultExecutor("clinepass").transformRequest(model, body).provider).toEqual(provider);
  });

  it.each([[false, false], [true, false], [true, true]])("delivers structured calls through chatCore and the actual executor (stream=%s, xhigh=%s)", async (stream, xhigh) => {
    mocks.fetch.mockImplementation(async (_url, options) => {
      const upstream = JSON.parse(options.body);
      // The affected backend returns only text in auto mode; the verified backend
      // returns structured tool calls without forcing the client to use tools.
      const routed = upstream.provider?.only?.includes("z-ai") === true;
      const message = routed
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_info", type: "function", function: { name: "info", arguments: "{}" } }] }
        : { role: "assistant", content: "info(topic=\"capabilities\")" };
      const finish = routed ? "tool_calls" : "stop";
      const response = { id: "qa-cline", object: "chat.completion", model: "z-ai/glm-5.3-flash", choices: [{ index: 0, message, finish_reason: finish }] };
      if (!stream) return new Response(JSON.stringify({ success: true, data: response }), { headers: { "content-type": "application/json" } });
      const delta = { ...message };
      delete delta.role;
      const frames = [
        { ...response, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        { ...response, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
      ];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });

    const body = { ...request(), stream, ...(xhigh ? { reasoning: { effort: "xhigh" } } : {}) };
    const { response, success } = await handleChatCore({
      body, modelInfo: { provider: "clinepass", model }, credentials: { apiKey: "qa-key" },
      sourceFormatOverride: "openai", connectionId: "clinepass-tool-route-test",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    });
    expect(success).toBe(true);
    expect(response.status).toBe(200);
    const [url, options] = mocks.fetch.mock.calls[0];
    const upstream = JSON.parse(options.body);
    expect(url).toBe("https://api.cline.bot/api/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer qa-key");
    expect(upstream.provider).toEqual(routing);
    expect(upstream).not.toHaveProperty("tool_choice");
    expect(upstream.messages).toEqual(body.messages);
    expect(upstream.tools).toEqual(body.tools);
    if (xhigh) {
      expect(upstream.reasoning_effort).toBe("max");
      expect(upstream.thinking).toEqual({ type: "enabled" });
    }
    if (stream) {
      const text = await response.text();
      const frames = text.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(6)));
      expect(frames.flatMap(frame => frame.choices ?? []).some(choice => choice.delta?.tool_calls?.some(call => call.function?.name === "info"))).toBe(true);
      expect(frames.flatMap(frame => frame.choices ?? []).filter(choice => choice.finish_reason === "tool_calls")).toHaveLength(1);
    } else {
      const result = await response.json();
      expect(result.choices[0].finish_reason).toBe("tool_calls");
      expect(result.choices[0].message.tool_calls[0].function).toEqual({ name: "info", arguments: "{}" });
    }
  });
});
