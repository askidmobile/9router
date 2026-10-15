import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
} from "open-sse/utils/opencodeFingerprint.js";

const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));

describe("opencodeFingerprint — request side", () => {
  it.each([true, false])("preserves caller tool schemas and restores their names (flat=%s)", (isFlat) => {
    const original = { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] };
    const body = { tools: isFlat
      ? [{ type: "function", name: "Read", parameters: original }]
      : [{ type: "function", function: { name: "Read", parameters: original } }],
      tool_choice: isFlat ? { type: "function", name: "Read" } : { type: "function", function: { name: "Read" } },
    };
    const map = applyFingerprintTools(body, isFlat);
    const client = isFlat ? body.tools[0] : body.tools[0].function;
    expect(client.name).toBe("client_Read");
    expect(client.parameters).toBe(original);
    expect(map.get(client.name)).toBe("Read");
    expect(isFlat ? body.tool_choice.name : body.tool_choice.function.name).toBe("client_Read");
    const read = body.tools.find(t => (t.function || t).name === "read");
    expect((read.function || read).parameters.properties).toHaveProperty("path");
    expect(takeRenamedToolNames(body)).toBe(map);
    expect(restoreToolNames({ choices: [{ message: { tool_calls: [{ function: { name: client.name } }] } }] }, map)
      .choices[0].message.tool_calls[0].function.name).toBe("Read");
  });

  it("keeps aliases collision-free and case-distinct", () => {
    const { tools, map } = concealFingerprintToolNames(flat(["Read", "read", "client_Read", "Foo", "foo"]));
    expect(tools.map(t => t.name)).toEqual(["_client_Read", "client_read", "client_Read", "Foo", "foo"]);
    expect(map.get("_client_Read")).toBe("Read");
  });

  it("uses genuine shell/read schemas and is idempotent on executor retries", () => {
    const body = { tools: chat(["Bash", "Read", "custom"]), messages: [{ role: "assistant", tool_calls: [{ function: { name: "Read", arguments: '{}' } }] }] };
    applyFingerprintTools(body, false);
    const sent = structuredClone(body);
    expect(body.messages[0].tool_calls[0].function.name).toBe("client_Read");
    expect(body.tools.map(t => t.function.name)).toEqual(["client_Bash", "client_Read", "custom", "shell", "read"]);
    applyFingerprintTools(body, false);
    expect(body).toEqual(sent);
    expect(takeRenamedToolNames(body).get("client_Read")).toBe("Read");
  });

  it("renames Responses history and Claude tool_use history with the declarations", () => {
    for (const key of ["input", "messages"]) {
      const body = { tools: flat(["read"]), [key]: [{ type: "function_call", name: "read", arguments: '{}' }, { role: "assistant", content: [{ type: "tool_use", name: "read", input: { file_path: "x" } }] }] };
      applyFingerprintTools(body, true);
      expect(body[key][0].name).toBe("client_read");
      expect(body[key][1].content[0].name).toBe("client_read");
    }
  });

  it("uses the right wire schema for each endpoint", () => {
    for (const [flatTools, claude] of [[false, false], [true, false], [false, true]]) {
      const body = {};
      applyFingerprintTools(body, flatTools, claude);
      expect(body.tools.map(t => (t.function || t).name)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
      expect(body.tool_choice).toBe(flatTools ? "auto" : "none");
      expect(claude ? body.tools[0].input_schema : (body.tools[0].function || body.tools[0]).parameters).toHaveProperty("properties.command");
    }
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "bash", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("Bash");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Grep");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("maps quartet case/whitespace variants and rejects other tools", () => {
    expect(fingerprintToolKey("Bash")).toBe("bash");
    expect(fingerprintToolKey(" bash ")).toBe("bash");
    expect(fingerprintToolKey("GLOB")).toBe("glob");
    expect(fingerprintToolKey("Read")).toBe("read");
    expect(fingerprintToolKey("Edit")).toBe("edit");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});
