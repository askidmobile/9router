// JSON Schema compatibility for OpenAI function tools.
//
// Two constraints differ between client formats and the OpenAI endpoints:
//   1. Function tools require an object schema root. MCP servers (for example
//      ZCode's node-repl `js` tool) may declare a root union instead.
//   2. `strict: true` requires `additionalProperties: false` on every object and
//      every property in `required`. Clients commonly mark a schema strict while
//      leaving nested objects open.
//
// Rewriting either constraint silently changes the caller's contract, so the
// root union is wrapped under `input` (the model still sees the original schema)
// and strict is downgraded only when the schema cannot satisfy it.

const ROOT_UNION_KEYS = ["anyOf", "oneOf", "allOf", "not", "enum"];

/** Wrap a non-object root schema so it is a valid function parameter schema. */
export function normalizeToolParameters(params) {
  if (!params) return { type: "object", properties: {} };
  if (typeof params !== "object" || Array.isArray(params)) return { type: "object", properties: {} };
  const nonObjectRoot = params.type !== undefined && params.type !== "object";
  const unionRoot = params.type === undefined && (ROOT_UNION_KEYS.some((key) => params[key] !== undefined) || params.const !== undefined);
  if (nonObjectRoot || unionRoot) {
    return {
      type: "object",
      properties: { input: params },
      required: ["input"],
      additionalProperties: false
    };
  }
  if (params.type === "object" && !params.properties) return { ...params, properties: {} };
  return params;
}

/** Whether a schema satisfies OpenAI's strict-mode subset. */
export function schemaSupportsStrict(schema) {
  if (Array.isArray(schema)) return schema.every(schemaSupportsStrict);
  if (!schema || typeof schema !== "object") return true;
  const isObject = schema.type === "object" || (!schema.type && schema.properties);
  if (isObject) {
    if (schema.additionalProperties !== false) return false;
    const props = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (props.some((key) => !required.includes(key))) return false;
  }
  for (const key of ["anyOf", "oneOf", "allOf", "items", "properties", "additionalProperties"]) {
    const value = schema[key];
    if (!value) continue;
    if (key === "properties") {
      if (!Object.values(value).every(schemaSupportsStrict)) return false;
    } else if (!schemaSupportsStrict(value)) {
      return false;
    }
  }
  return true;
}

/** Keep strict only when the schema can actually satisfy it. */
export function normalizeToolStrict(params, strict) {
  if (strict !== true) return strict;
  return schemaSupportsStrict(params);
}

/**
 * Tool choice differs between the two wires: Chat uses
 * {type:"function", function:{name}} while Responses uses {type:"function", name}.
 * A named Chat choice sent to /responses fails with "Missing required parameter:
 * 'tool_choice.name'." Custom choices use the same flat shape.
 */
export function normalizeResponsesToolChoice(choice) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return choice;
  const name = typeof choice.name === "string"
    ? choice.name
    : (typeof choice.function?.name === "string" ? choice.function.name : null);
  if (!name) return choice;
  if (choice.type !== "function" && choice.type !== "custom") return choice;
  return { type: choice.type, name };
}

/**
 * Sanitize the final outbound body for an OpenAI Responses-wire endpoint.
 * The native Responses passthrough skips the request translator, so this must
 * run at dispatch time as well: flatten Chat-shaped declarations, unwrap Codex
 * namespaces, dedupe names, wrap root unions and relax impossible strict mode.
 */
export function normalizeResponsesToolBody(body) {
  if (!body || typeof body !== "object") return body;
  if (!Array.isArray(body.tools)) {
    if (body.tool_choice) body.tool_choice = normalizeResponsesToolChoice(body.tool_choice);
    return body;
  }
  const flat = [];
  const walk = (tools) => {
    for (const tool of tools ?? []) {
      if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
        walk(tool.tools);
        continue;
      }
      flat.push(tool);
    }
  };
  walk(body.tools);

  const seen = new Set();
  const tools = [];
  for (const tool of flat) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    if (tool.type !== "function") {
      tools.push(tool);
      continue;
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const name = String(fn?.name ?? tool.name ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const parameters = normalizeToolParameters(fn?.parameters ?? tool.parameters);
    const requestedStrict = typeof (fn?.strict ?? tool.strict) === "boolean" ? (fn?.strict ?? tool.strict) : undefined;
    const strict = normalizeToolStrict(parameters, requestedStrict);
    // Keep Responses-only extensions such as defer_loading; only replace the
    // fields that differ between the Chat and Responses declarations.
    const { function: _fn, ...rest } = tool;
    tools.push({
      ...rest,
      type: "function",
      name: name.slice(0, 128),
      description: String((fn?.description ?? tool.description) || ""),
      parameters,
      ...(strict === undefined ? {} : { strict }),
    });
  }
  body.tools = tools;
  if (body.tool_choice) body.tool_choice = normalizeResponsesToolChoice(body.tool_choice);
  return body;
}
