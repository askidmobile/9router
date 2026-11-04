import { describe, expect, it } from "vitest";
import {
  normalizeToolParameters,
  normalizeToolStrict,
  schemaSupportsStrict,
  normalizeResponsesToolChoice,
  normalizeResponsesToolBody,
} from "../../open-sse/translator/concerns/toolSchema.js";

const CLOSED = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
  additionalProperties: false,
};

describe("toolSchema — OpenAI function tool compatibility", () => {
  it("wraps a root union under input", () => {
    const union = { anyOf: [{ type: "object" }, { type: "string" }] };
    expect(normalizeToolParameters(union)).toEqual({
      type: "object",
      properties: { input: union },
      required: ["input"],
      additionalProperties: false,
    });
  });

  it("fills properties on an object root", () => {
    expect(normalizeToolParameters({ type: "object" })).toEqual({ type: "object", properties: {} });
  });

  it("leaves a compliant schema untouched", () => {
    expect(normalizeToolParameters(CLOSED)).toBe(CLOSED);
  });

  it("accepts a closed nested object as strict-compatible", () => {
    expect(schemaSupportsStrict(CLOSED)).toBe(true);
    expect(normalizeToolStrict(CLOSED, true)).toBe(true);
  });

  it("rejects strict when an object is open or a property is optional", () => {
    expect(schemaSupportsStrict({ type: "object", properties: { a: { type: "string" } } })).toBe(false);
    expect(schemaSupportsStrict({
      type: "object",
      properties: { a: { type: "string" } },
      required: [],
      additionalProperties: false,
    })).toBe(false);
    expect(normalizeToolStrict({ type: "object", properties: {} }, true)).toBe(false);
  });

  it("checks union branches", () => {
    const openBranch = {
      anyOf: [
        CLOSED,
        { type: "object", properties: { b: { type: "string" } }, additionalProperties: false },
      ],
    };
    expect(schemaSupportsStrict(openBranch)).toBe(false);
  });

  it("never upgrades strict=false", () => {
    expect(normalizeToolStrict(CLOSED, false)).toBe(false);
    expect(normalizeToolStrict(CLOSED, undefined)).toBeUndefined();
  });

  it("flattens a named Chat tool_choice for Responses", () => {
    expect(normalizeResponsesToolChoice({ type: "function", function: { name: "read" } }))
      .toEqual({ type: "function", name: "read" });
    expect(normalizeResponsesToolChoice({ type: "function", name: "read" }))
      .toEqual({ type: "function", name: "read" });
  });

  it("keeps string and custom tool_choice values", () => {
    expect(normalizeResponsesToolChoice("auto")).toBe("auto");
    expect(normalizeResponsesToolChoice({ type: "custom", function: { name: "exec" } }))
      .toEqual({ type: "custom", name: "exec" });
  });

  it("normalizes tool_choice without touching tools", () => {
    const body = { input: "hi", tool_choice: { type: "function", function: { name: "read" } } };
    normalizeResponsesToolBody(body);
    expect(body.tool_choice).toEqual({ type: "function", name: "read" });
    expect(body.tools).toBeUndefined();
  });
});
