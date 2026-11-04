import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const UNION_TOOL = {
  type: "function",
  name: "js",
  description: "Run JavaScript",
  parameters: { anyOf: [{ type: "object", properties: { code: { type: "string" } } }, { type: "string" }] },
  strict: true,
};

function dispatchTools(body, credentials = { runtimeTransport: { format: "openai-responses" } }) {
  const out = new DefaultExecutor("openai").transformRequest("gpt-6-astra", structuredClone(body), false, credentials);
  return out.tools;
}

describe("OpenAI Responses dispatch-time tool normalization", () => {
  it("normalizes native Responses passthrough tools", () => {
    const tools = dispatchTools({ input: "hi", tools: [UNION_TOOL] });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "function",
      name: "js",
      strict: false,
      parameters: {
        type: "object",
        required: ["input"],
        additionalProperties: false,
        properties: { input: UNION_TOOL.parameters },
      },
    });
  });

  it("flattens Chat-shaped declarations and namespaces on the Responses wire", () => {
    const tools = dispatchTools({
      input: "hi",
      tools: [
        { type: "function", function: { name: "read", parameters: { type: "object", properties: {}, additionalProperties: false } } },
        { type: "namespace", name: "functions", tools: [UNION_TOOL] },
      ],
    });
    expect(tools.map((t) => t.name)).toEqual(["read", "js"]);
  });

  it("dedupes repeated names, first definition wins", () => {
    const tools = dispatchTools({
      input: "hi",
      tools: [
        { type: "function", name: "read", description: "first", parameters: { type: "object", properties: {} } },
        { type: "function", function: { name: "read", description: "second", parameters: { type: "object", properties: {} } } },
      ],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe("first");
  });

  it("keeps a strict-compatible schema strict", () => {
    const tools = dispatchTools({
      input: "hi",
      tools: [{
        type: "function",
        name: "weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
        strict: true,
      }],
    });
    expect(tools[0].strict).toBe(true);
  });

  it("leaves Chat Completions bodies untouched", () => {
    const body = { messages: [{ role: "user", content: "hi" }], tools: [UNION_TOOL] };
    const out = new DefaultExecutor("openai").transformRequest("gpt-4o", structuredClone(body), false, {});
    expect(out.tools[0].parameters).toEqual(UNION_TOOL.parameters);
  });
});
