import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { filterUsageForFormat } = await import("../../open-sse/utils/usageTracking.js");
const { openAICompletionToResponses } = await import("../../open-sse/translator/response/openai-responses-json.js");

describe("native provider JSON for a Responses client", () => {
  it.each([FORMATS.GEMINI, FORMATS.ANTIGRAVITY, FORMATS.GEMINI_CLI, FORMATS.VERTEX])("completes both translation stages for %s", format => {
    const native = { candidates: [{ content: { parts: [{ text: "Context summary" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };
    const out = translateNonStreamingResponse(format === FORMATS.ANTIGRAVITY ? { response: native } : native, format, FORMATS.OPENAI_RESPONSES);
    expect(out).toMatchObject({ object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Context summary" }] }] });
    expect(filterUsageForFormat(out.usage, FORMATS.OPENAI_RESPONSES)).toEqual({ input_tokens: 100, output_tokens: 20, total_tokens: 120 });
  });
  it("converts Claude JSON and preserves an incomplete stop status", () => {
    const native = { id: "qa", content: [{ type: "text", text: "partial summary" }], stop_reason: "max_tokens", usage: { input_tokens: 100, output_tokens: 20 } };
    const out = translateNonStreamingResponse(native, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    expect(out.output[0].content[0].text).toBe("partial summary");
  });
});

// A chat.completion body as returned by a chat-native upstream (e.g. op-ericding)
const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/claude-haiku-4-5",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe("non-stream Chat upstream for a Responses-API client (op-ericding bug)", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    // translateNonStreamingResponse(body, targetFormat=PROVIDER format, sourceFormat=CLIENT format)
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"ls\"}");
  });

  it("translates marked Chat tools into Responses custom_tool_call output", () => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    customBody.choices[0].message.tool_calls[0] = {
      id: "call_exec",
      type: "function",
      function: {
        name: "exec",
        arguments: "{\"input\":\"return await tools.shell({command: 'pwd'});\"}"
      }
    };
    const out = translateNonStreamingResponse(
      customBody,
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      new Set(["exec"])
    );
    const call = (out.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    });
    expect(out.output.some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].type).toBe("output_text");
    expect(msg.content[0].text).toBe("hello");
  });

  it("keeps structured Chat text blocks as Responses output text", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: [
        { type: "text", text: "hello " }, { type: "text", text: "world" },
      ] }, finish_reason: "stop" }],
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.output).toMatchObject([{ type: "message", content: [{ type: "output_text", text: "hello world" }] }]);
  });

  it("maps a reasoning-only token-limit response to the Responses incomplete contract", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: "One token" }, finish_reason: "length" }],
      usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out).toMatchObject({
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "One token" }] }],
    });
  });

  it("leaves chat->chat untouched", () => {
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("forced-SSE JSON path for a Responses-API client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat, customFrames = null) => {
    const encoder = new TextEncoder();
    const raw = (customFrames || [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      ""
    ]).join("\n\n");
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "op-test-chat",
      model: "gpt-x",
      body: { model: "gpt-x", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("parses chat SSE chunks and returns a Responses function_call body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const fc = (json.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"pwd\"}");
  });

  it("returns a custom_tool_call for a marked tool", async () => {
    const ctx = sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    ctx.customToolNames = new Set(["shell"]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    const call = (json.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_9",
      name: "shell",
      input: "{\"cmd\":\"pwd\"}"
    });
  });

  it("still returns chat.completion for a plain chat client", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });

  it("preserves a forced stream token limit as a Responses incomplete result", async () => {
    const frames = [
      'data: {"id":"chatcmpl-limit","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"reasoning_content":"One token"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-limit","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":20,"completion_tokens":1,"total_tokens":21}}',
      "data: [DONE]",
      "",
    ];
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, frames));
    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [{ text: "One token" }] }],
    });
  });
});

// Providers occasionally emit a content array holding a null or bare-string block.
// The converter used to throw on it, and Combo reported that crash as an opaque
// "Invalid completion response" while freezing a provider that had answered.
describe("Chat -> Responses conversion survives ragged provider content", () => {
  it("does not throw on null or malformed content blocks", () => {
    const out = openAICompletionToResponses({
      id: "chatcmpl-1", model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: {
        role: "assistant",
        content: [null, { type: "text", text: "hi" }, "loose", { type: "image_url" }],
      } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    expect(out.status).toBe("completed");
    const msg = out.output.find((x) => x.type === "message");
    expect(msg.content[0].text).toBe("hi");
  });

  it("does not throw when content is null", () => {
    const out = openAICompletionToResponses({
      id: "chatcmpl-2", model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: null,
        reasoning_content: "thought" } }],
    });
    expect(out.output.map((x) => x.type)).toEqual(["reasoning"]);
  });
});

// _customToolNames / _toolNamespaces cross the OpenAI pivot as serializable
// arrays. The streaming path rebuilds them into a Set/Map; the JSON path called
// .has()/.get() on the raw arrays, so every namespaced Codex tool call on a
// non-streaming route died with "c?.get is not a function".
describe("namespaced tool calls survive the non-streaming route", () => {
  const body = {
    id: "chatcmpl-9", model: "deepseek-flash",
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "call_1", function: { name: "spawn_agent", arguments: '{"task_name":"qa"}' } }] } }],
  };

  it("accepts the serialized array form", () => {
    const out = openAICompletionToResponses(body, ["freeform"], [["spawn_agent", "multi_agent_v1"]]);
    const call = out.output.find((x) => x.type === "function_call");
    expect(call.namespace).toBe("multi_agent_v1");
    expect(call.name).toBe("spawn_agent");
  });

  it("still accepts a ready Map/Set", () => {
    const out = openAICompletionToResponses(body, new Set(["freeform"]),
      new Map([["spawn_agent", "multi_agent_v1"]]));
    expect(out.output.find((x) => x.type === "function_call").namespace).toBe("multi_agent_v1");
  });

  it("omits the namespace when none was declared", () => {
    const out = openAICompletionToResponses(body, null, null);
    expect(out.output.find((x) => x.type === "function_call").namespace).toBeUndefined();
  });
});
