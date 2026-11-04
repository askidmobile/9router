import { describe, expect, it } from "vitest";
import {
  openaiResponsesToOpenAIRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const ROOT_UNION_TOOL = {
  type: "function",
  name: "js",
  description: "Run JavaScript",
  parameters: { anyOf: [{ type: "object", properties: { code: { type: "string" } } }, { type: "string" }] },
  strict: true,
};

const EXEC_TOOL = {
  type: "custom",
  name: "exec",
  description: "Run JavaScript code to orchestrate tool calls.",
  format: {
    type: "grammar",
    syntax: "lark",
    definition: "start: /(.|\\n)+/",
  },
};

describe("Codex Responses Lite custom tools → OpenAI Chat", () => {
  it("promotes additional_tools custom declarations into Chat tools", () => {
    const out = openaiResponsesToOpenAIRequest("cx/gpt-5.6-sol", {
      input: [
        { type: "additional_tools", role: "developer", tools: [EXEC_TOOL] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Run pwd" }] },
      ],
      tool_choice: "auto",
    }, true, null);

    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "exec",
        parameters: {
          type: "object",
          required: ["input"],
          properties: { input: { type: "string" } },
        },
      },
    });
    expect(out._customToolNames).toEqual(["exec"]);
    expect(out.messages.some((message) => message.role === "developer")).toBe(false);
  });

  it("unwraps codex 0.151 namespace-wrapped additional_tools into real tool declarations", () => {
    // Real payload from codex-tui/0.151.0: tools arrive as namespace wrappers
    // ({type:"namespace", name:"functions", tools:[...]}) inside the input items.
    const out = openaiResponsesToOpenAIRequest("Coding", {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              description: "",
              tools: [EXEC_TOOL, { type: "function", name: "wait", description: "Wait", parameters: { type: "object", properties: {} }, strict: false }],
            },
            {
              type: "namespace",
              name: "collaboration",
              description: "Tools for spawning and managing sub-agents.",
              tools: [{ type: "function", name: "spawn_agent", description: "Spawn", parameters: { type: "object", properties: {} }, strict: false }],
            },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "List files" }] },
      ],
    }, true, null);

    const names = out.tools.map((tool) => tool.function.name);
    expect(names).toEqual(["exec", "wait", "spawn_agent"]);
    expect(out._customToolNames).toEqual(["exec"]);
    expect(names).not.toContain("functions");
    expect(names).not.toContain("collaboration");
  });

  it("translates custom tool call/output history into Chat assistant/tool messages", () => {
    const program = "const result = await tools.shell({command: 'pwd'});\nreturn result;";
    const out = openaiResponsesToOpenAIRequest("cx/gpt-5.6-sol", {
      input: [
        { type: "additional_tools", role: "developer", tools: [EXEC_TOOL] },
        { type: "custom_tool_call", call_id: "call_exec_1", name: "exec", input: program },
        { type: "custom_tool_call_output", call_id: "call_exec_1", output: "/srv/app" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    }, true, null);

    const assistant = out.messages.find((message) => message.role === "assistant");
    expect(assistant.tool_calls[0]).toMatchObject({
      id: "call_exec_1",
      type: "function",
      function: { name: "exec" },
    });
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ input: program });
    expect(out.messages.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      tool_call_id: "call_exec_1",
      content: "/srv/app",
    });
  });

  it("records the originating namespace for namespaced tool calls", () => {
    const out = openaiResponsesToOpenAIRequest("cx/gpt-5.6-sol", {
      input: [
        {
          type: "additional_tools",
          tools: [{
            type: "namespace",
            name: "multi_agent_v1",
            tools: [{ type: "function", name: "spawn_agent", description: "Spawn", parameters: { type: "object", properties: {} } }],
          }],
        },
      ],
    }, true, null);

    expect(out._toolNamespaces).toEqual([["spawn_agent", "multi_agent_v1"]]);
  });

  it("preserves namespace metadata when pivoting Responses requests through OpenAI to Ollama", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OLLAMA, "glm/glm-5.3", {
      input: [
        {
          type: "additional_tools",
          tools: [{
            type: "namespace",
            name: "multi_agent_v1",
            tools: [{ type: "function", name: "spawn_agent", description: "Spawn", parameters: { type: "object", properties: {} } }],
          }],
        },
      ],
    }, true, null);

    expect(out.model).toBe("glm/glm-5.3");
    expect(out._customToolNames).toBeUndefined();
    expect(out._toolNameMap).toBeUndefined();
    expect(out._toolNamespaces).toEqual([["spawn_agent", "multi_agent_v1"]]);
  });

  it("converts completed hosted web_search history into Chat-visible context", () => {
    const out = openaiResponsesToOpenAIRequest("cx/gpt-5.6-sol", {
      input: [
        { type: "web_search_call", status: "completed", action: { type: "search", query: "codex responses api" }, results: [{ title: "Docs", url: "https://example.com", snippet: "Use SSE" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Use SSE." }] },
      ],
    }, true, null);

    const context = out.messages.find(message => message.role === "user");
    expect(context.content).toContain("codex responses api");
    expect(context.content).toContain("https://example.com");
    expect(out.input).toBeUndefined();
  });

  it("merges additional_tools with normal top-level function tools", () => {
    const out = openaiResponsesToOpenAIRequest("cx/gpt-5.6-sol", {
      input: [{ type: "additional_tools", role: "developer", tools: [EXEC_TOOL] }],
      tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }],
    }, true, null);

    expect(out.tools.map((tool) => tool.function.name)).toEqual(["search", "exec"]);
    expect(out._customToolNames).toEqual(["exec"]);
  });

  it("wraps a Responses function root union for Chat Completions", () => {
    const out = openaiResponsesToOpenAIRequest("gpt-6-astra", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Run" }] }],
      tools: [ROOT_UNION_TOOL],
    }, true, null);

    expect(out.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { input: ROOT_UNION_TOOL.parameters },
      required: ["input"],
      additionalProperties: false,
    });
    // The union cannot satisfy strict mode; keep the schema, drop strict.
    expect(out.tools[0].function.strict).toBe(false);
  });

  it("keeps Chat tools on the Responses wire and merges additional_tools", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6-astra", {
      messages: [{ role: "user", content: "Run" }],
      tools: [ROOT_UNION_TOOL],
    }, false, null);

    expect(out.tools[0]).toMatchObject({
      type: "function",
      name: "js",
      strict: false,
      parameters: {
        type: "object",
        properties: { input: ROOT_UNION_TOOL.parameters },
      },
    });
  });

  it("merges Responses additional_tools when converting chat to Responses", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6-astra", {
      messages: [{ role: "user", content: "Run" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }],
      input: [{ type: "additional_tools", tools: [EXEC_TOOL] }],
    }, true, null);

    expect(out.tools.map((t) => t.name)).toEqual(["read", "exec"]);
  });

  it("preserves tool_choice and parallel_tool_calls when converting to Responses", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6-astra", {
      messages: [{ role: "user", content: "Run" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }],
      tool_choice: { type: "function", function: { name: "read" } },
      parallel_tool_calls: false,
    }, true, null);

    expect(out.tool_choice).toEqual({ type: "function", name: "read" });
    expect(out.parallel_tool_calls).toBe(false);
  });

  it("keeps Responses-only tool extensions", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6-astra", {
      messages: [{ role: "user", content: "Run" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } }, defer_loading: true }],
    }, true, null);

    expect(out.tools[0].defer_loading).toBe(true);
  });

  it("translates Chat reasoning_effort into reasoning.effort for the Responses wire", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6-astra", {
      messages: [{ role: "user", content: "Run" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }],
      reasoning_effort: "xhigh",
    }, true, {}, "openai");

    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toMatchObject({ effort: "xhigh" });
  });

  it("dedupes Responses tools repeated in tools[] and input.additional_tools", () => {
    const read = { type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } };
    const readFlat = { type: "function", name: "read", parameters: { type: "object", properties: {} } };
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6-astra", {
      messages: [{ role: "user", content: "Run" }],
      tools: [read],
      input: [{ type: "additional_tools", tools: [readFlat, { type: "function", name: "write", parameters: { type: "object", properties: {} } }] }],
    }, true, null);

    expect(out.tools.map((t) => t.name)).toEqual(["read", "write"]);
  });
});

describe("OpenAI Chat stream → Codex namespaced function_call", () => {
  it("adds the original namespace to a normal Chat tool call", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.toolNamespaces = new Map([["spawn_agent", "multi_agent_v1"]]);
    const events = [
      { id: "chatcmpl-normal", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_spawn", type: "function", function: { name: "spawn_agent", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-normal", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ].flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));

    expect(events.find((event) => event.event === "response.output_item.added").data.item).toMatchObject({
      type: "function_call",
      call_id: "call_spawn",
      name: "spawn_agent",
      namespace: "multi_agent_v1",
    });
    expect(events.find((event) => event.event === "response.output_item.done").data.item).toMatchObject({
      namespace: "multi_agent_v1",
    });
  });
});

describe("OpenAI Chat stream → Codex custom_tool_call", () => {
  it("unwraps the Chat input parameter and emits custom-tool events", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.customToolNames = new Set(["exec"]);
    const chunks = [
      {
        id: "chatcmpl-custom",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_exec_2", type: "function", function: { name: "exec", arguments: "" } }] }, finish_reason: null }],
      },
      {
        id: "chatcmpl-custom",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"input\":\"const x = await tools.shell({command: 'pwd'});\"}" } }] }, finish_reason: null }],
      },
      { id: "chatcmpl-custom", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const added = events.find((event) => event.event === "response.output_item.added");
    const delta = events.find((event) => event.event === "response.custom_tool_call_input.delta");
    const done = events.find((event) => event.event === "response.output_item.done");

    expect(added.data.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_exec_2",
      name: "exec",
      input: "",
    });
    expect(delta.data.delta).toBe("const x = await tools.shell({command: 'pwd'});");
    expect(done.data.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_exec_2",
      name: "exec",
      input: "const x = await tools.shell({command: 'pwd'});",
    });
    expect(events.some((event) => event.event === "response.function_call_arguments.delta")).toBe(false);
  });

  it("waits for the function name when id and name arrive in separate chunks", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.customToolNames = new Set(["exec"]);
    const chunks = [
      { id: "chatcmpl-split", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_split", type: "function", function: { arguments: "" } }] }, finish_reason: null }] },
      { id: "chatcmpl-split", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "exec", arguments: "{\"input\":\"return 1;\"}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-split", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const events = chunks.flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));
    const added = events.filter((event) => event.event === "response.output_item.added");
    expect(added).toHaveLength(1);
    expect(added[0].data.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_split",
      name: "exec",
    });
  });

  it("leaves normal Chat tool calls as Responses function_call events", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    state.customToolNames = new Set(["exec"]);
    const events = [
      { id: "chatcmpl-normal", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_search", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] }, finish_reason: null }] },
      { id: "chatcmpl-normal", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ].flatMap((chunk) => openaiToOpenAIResponsesResponse(chunk, state));

    expect(events.find((event) => event.event === "response.output_item.added").data.item.type).toBe("function_call");
    expect(events.find((event) => event.event === "response.output_item.done").data.item).toMatchObject({
      type: "function_call",
      name: "search",
      arguments: "{\"q\":\"x\"}",
    });
  });
});
