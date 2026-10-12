import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
    logOpenAIRequest: vi.fn(), logResponseChunk: vi.fn(), logUpstreamChunk: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({ getPricing: async () => ({}) }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { resolveTransport } = await import("../../open-sse/services/provider.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const tool = { type: "custom", name: "exec", description: "Execute JavaScript", format: { type: "text" } };
const namespace = { type: "namespace", name: "functions", tools: [tool] };
const call = { index: 0, id: "call_probe", type: "function", function: { name: "exec", arguments: '{"input":"text(42)"}' } };

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockImplementation(async ({ stream, credentials, model }) => {
    const payload = stream
      ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ id: "chatcmpl-probe", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] });
    return {
      response: new Response(payload, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }),
      url: new DefaultExecutor("apinex").buildUrl(model, stream, 0, credentials),
      headers: {}, transformedBody: null,
    };
  });
});

describe("APInex custom Responses tools", () => {
  it.each([
    { tools: [tool] },
    { tools: [namespace] },
    { input: [{ type: "additional_tools", tools: [namespace] }] },
    { input: [{ type: "custom_tool_call", name: "exec", call_id: "call_old", input: "text(1)" }] },
    { input: [{ type: "custom_tool_call_output", call_id: "call_old", output: "1" }] },
  ])("uses the Chat transport for custom declarations or continuation %j", body => {
    expect(resolveTransport("apinex", "openai-responses", body)?.format).toBe("openai");
  });

  it("keeps native Responses for standard function tools and other providers", () => {
    expect(resolveTransport("apinex", "openai-responses", { tools: [{ type: "function", name: "read_report" }] })?.format).toBe("openai-responses");
    expect(resolveTransport("apinex", "openai-responses")?.format).toBe("openai-responses");
    expect(resolveTransport("kimi", "openai-responses", { tools: [namespace] })?.format).toBe("openai-responses");
  });
  it.each([{ previous_response_id: "resp_old" }, { input: [{ type: "item_reference", id: "msg_old" }] }])(
    "preserves native stored history %j", history => {
      expect(resolveTransport("apinex", "openai-responses", { tools: [namespace], ...history })?.format).toBe("openai-responses");
    },
  );

  it.each([[false, false], [true, false], [false, true], [true, true]])("executes the real adapters (stream=%s, additional_tools=%s)", async (stream, additional) => {
    const result = await handleChatCore({
      body: { model: "apinex/free/glm-5.3-flash", stream,
        ...(additional
          ? { input: [{ type: "additional_tools", tools: [namespace] }, { type: "message", role: "user", content: "Print 42" }] }
          : { input: "Print 42", tools: [namespace] }) },
      modelInfo: { provider: "apinex", model: "free/glm-5.3-flash" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      sourceFormatOverride: "openai-responses", connectionId: "tool-transport-test",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(result.success).toBe(true);
    const request = execute.mock.calls[0][0];
    expect(request.credentials.runtimeTransport.format).toBe("openai");
    expect(new URL((await execute.mock.results[0].value).url).pathname).toBe("/v1/chat/completions");
    expect(request.body.input).toBeUndefined();
    expect(request.body.tools[0]).toMatchObject({ type: "function", function: { name: "exec", parameters: { required: ["input"] } } });
    expect(request.body._customToolNames).toBeUndefined();
    const raw = await result.response.text();
    const response = stream
      ? raw.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.completed").response
      : JSON.parse(raw);
    expect(response.output).toContainEqual(expect.objectContaining({
      type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "call_probe", input: "text(42)",
    }));
  });

  it.runIf(process.env.RUN_REAL === "1")("round-trips a real APInex tool call and result through the patched handler", async () => {
    const { readFile } = await import("node:fs/promises");
    const state = JSON.parse(await readFile(`${process.env.HOME}/.codex/9router-chatgpt/state.json`, "utf8"));
    execute.mockImplementation(async ({ body, credentials }) => {
      expect(credentials.runtimeTransport.format).toBe("openai");
      const url = new URL("/v1/chat/completions", state.routerUrl);
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${state.apiKey}` },
        body: JSON.stringify({ ...body, model: "apinex/free/glm-5.3-flash" }),
        signal: AbortSignal.timeout(120000),
      });
      return { response, url: url.href, headers: {}, transformedBody: body };
    });
    const route = async input => {
      const result = await handleChatCore({
        body: { model: "apinex/free/glm-5.3-flash", stream: true, input, tools: [namespace],
          instructions: "Use the provided tools to carry out action requests. A progress update alone ends your turn; include the actual tool call in the same response. Wait for the tool result before claiming success." },
        modelInfo: { provider: "apinex", model: "free/glm-5.3-flash" },
        credentials: { apiKey: "test-key", providerSpecificData: {} },
        sourceFormatOverride: "openai-responses", connectionId: "tool-live-probe",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(result.success).toBe(true);
      const raw = await result.response.text();
      const events = raw.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      return events.find(event => event.type === "response.completed").response.output;
    };
    const input = [{ type: "message", role: "user", content: "Use exec to print ROUTER_PROBE_OK with JavaScript text('ROUTER_PROBE_OK'), then confirm the tool result. First briefly say you are starting." }];
    const output = await route(input);
    const toolCall = output.find(item => item.type === "custom_tool_call");
    expect(toolCall).toMatchObject({ name: "exec", namespace: "functions" });
    expect(toolCall.input).toContain("ROUTER_PROBE_OK");
    const followup = await route([...input, ...output, { type: "custom_tool_call_output", call_id: toolCall.call_id, output: "ROUTER_PROBE_OK" }]);
    expect(followup.some(item => item.type === "custom_tool_call")).toBe(false);
    expect(followup.filter(item => item.type === "message").flatMap(item => item.content).map(part => part.text).join(" ")).toContain("ROUTER_PROBE_OK");
  }, 180000);
});
