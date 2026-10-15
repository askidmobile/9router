// OpenCode 2.0.29 wire schemas from anomalyco/opencode (MIT; see config/opencodeTools.LICENSE).
import toolDefinitions from "../config/opencodeTools.json" with { type: "json" };

/** Canonical names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = Object.keys(toolDefinitions);
const RECOGNIZED_TOOLS = ["bash", "shell", "read", "edit", "execute", "glob", "grep", "question", "skill", "subagent", "webfetch", "websearch", "write"];

// Request body -> names renamed for that request. transformRequest() mutates the
// same body object that chatCore passed into the executor, so a WeakMap keeps the
// mapping request-local without putting transport metadata on the wire.
const renamedToolNames = new WeakMap();

/** Recognized CLI tool name; "" otherwise. */
export function fingerprintToolKey(name) {
  const lower = String(name ?? "").trim().toLowerCase();
  return RECOGNIZED_TOOLS.includes(lower) ? lower : "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

/**
 * Alias caller tools whose names trigger CLI schema checks, preserving their schemas.
 *
 * @param {Array} tools
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const names = new Set(tools.map(toolNameOf));
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const current = toolNameOf(tool);
    const key = fingerprintToolKey(current);
    if (!key) {
      out.push(tool);
      continue;
    }

    const definition = toolDefinitions[current];
    const original = tool.function || tool;
    if (definition && original.description === definition.description
      && JSON.stringify(original.parameters || original.input_schema) === JSON.stringify(definition.parameters)) {
      out.push(tool);
      continue;
    }
    // Keep caller schemas intact under aliases; recognized names require exact CLI schemas.
    let alias = `client_${current}`;
    while (names.has(alias)) alias = `_${alias}`;
    names.add(alias);
    map.set(alias, current);
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
      ? tool.function
      : null;
    out.push(fn ? { ...tool, function: { ...fn, name: alias } } : { ...tool, name: alias });
  }
  return { tools: out, map };
}

/** Append the required CLI declarations. */
export function appendMissingFingerprintTools(tools, flat, claude = false) {
  const list = Array.isArray(tools) ? tools : [];
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (list.some((tool) => toolNameOf(tool) === name)) continue;
    const definition = structuredClone(toolDefinitions[name]);
    list.push(claude ? { name, description: definition.description, input_schema: definition.parameters }
      : flat ? { type: "function", name, ...definition } : {
      type: "function",
      function: {
        name,
        ...definition,
      },
    });
  }
  return list;
}

/** Point an explicit tool_choice at the caller alias. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;

  if (typeof choice.name === "string") {
    const alias = [...map].find(([, original]) => original === choice.name)?.[0];
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = [...map].find(([, original]) => original === fn.name)?.[0];
    if (alias) {
      body.tool_choice = { ...choice, function: { ...fn, name: alias } };
    }
  }
}

/**
 * Preserve caller tools/history under aliases and add the required CLI schemas.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses tools ({name}), false for chat tools
 * @returns {Map<string,string>} map: sent name -> original name
 */
export function applyFingerprintTools(body, flat, claude = false) {
  if (!body || typeof body !== "object") return new Map();

  const hadClientTools = Array.isArray(body.tools) && body.tools.length > 0;
  const { tools, map: renamed } = concealFingerprintToolNames(body.tools);
  const map = new Map([...(renamedToolNames.get(body) || []), ...renamed]);
  body.tools = appendMissingFingerprintTools(tools, flat, claude);
  retargetToolChoice(body, map);
  const forward = new Map([...map].map(([alias, original]) => [original, alias]));
  for (const key of ["messages", "input"]) {
    if (Array.isArray(body[key])) body[key] = restoreToolNames(body[key], forward);
  }

  // Preserve the existing executor semantics. Responses uses auto when the
  // fingerprint helper supplies tools; chat requests with no caller tools use
  // none so the injected decoys cannot be selected.
  if (!body.tool_choice) {
    if (flat) body.tool_choice = "auto";
    else if (!hadClientTools) body.tool_choice = "none";
  }

  recordRenamedToolNames(body, map);
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

// Response side -------------------------------------------------------------

/** Restore caller tool spellings in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  for (const key of ["messages", "input", "tool_calls"]) {
    if (Array.isArray(payload[key])) put(key, restoreToolNames(payload[key], map));
  }
  if (payload.type === "function_call" && map.has(payload.name)) put("name", map.get(payload.name));
  if (payload.function && map.has(payload.function.name)) {
    put("function", { ...payload.function, name: map.get(payload.function.name) });
  }

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) =>
      block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
        ? { ...block, name: map.get(block.name) }
        : block));
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (typeof name === "string" && map.has(name)) {
            changed = true;
            return { ...call, function: { ...call.function, name: map.get(name) } };
          }
          return call;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) =>
      item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
        ? { ...item, name: map.get(item.name) }
        : item));
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }

  return out;
}
