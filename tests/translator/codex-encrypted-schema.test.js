import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const model = "claude-opus-5-5-high";
const credentials = { projectId: "fixture-project", connectionId: "fixture-connection" };

function makeTool() {
  return {
    type: "function",
    name: "save_message",
    description: "Save a message",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message text", encrypted: true },
        encrypted: { type: "boolean", description: "Encrypt the saved message", encrypted: false },
      },
      required: ["message", "encrypted"],
    },
  };
}

const expectedParameters = {
  type: "object",
  properties: {
    message: { type: "string", description: "Message text" },
    encrypted: { type: "boolean", description: "Encrypt the saved message" },
  },
  required: ["message", "encrypted"],
};

describe("Codex Responses tool schemas for Opus via Antigravity", () => {
  it.each(["tools", "additional_tools"])("sanitizes %s through translation and the executor", (location) => {
    const input = [{ role: "user", content: "Save a message" }];
    const body = { input };
    if (location === "tools") {
      body.tools = [makeTool()];
    } else {
      input.unshift({
        type: "additional_tools",
        tools: [{ type: "namespace", name: "functions", tools: [makeTool()] }],
      });
    }
    const original = structuredClone(body);

    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, model, body, true, credentials, "antigravity",
    );
    expect(translated.request.tools[0].functionDeclarations[0].parameters).toEqual(expectedParameters);

    const wire = new AntigravityExecutor().transformRequest(model, translated, true, credentials);
    const declaration = wire.request.tools[0].functionDeclarations.find(fn => fn.name === "save_message");
    expect(declaration.parameters).toEqual(expectedParameters);
    expect(body).toEqual(original);
  });

  it("sanitizes native envelopes at the executor boundary", () => {
    const { type, ...declaration } = makeTool();
    const body = {
      request: {
        contents: [{ role: "user", parts: [{ text: "Save a message" }] }],
        tools: [{ functionDeclarations: [declaration] }],
      },
    };
    const wire = new AntigravityExecutor().transformRequest(model, body, true, credentials);
    expect(wire.request.tools[0].functionDeclarations[0].parameters).toEqual(expectedParameters);
    expect(body.request.tools[0].functionDeclarations[0].parameters.properties.message.encrypted).toBe(true);
  });
});
