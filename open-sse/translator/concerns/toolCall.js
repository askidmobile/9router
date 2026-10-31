// Tool call helper functions for translator

import { FORMATS } from "../formats.js";

// Anthropic tool_use.id must match: ^[a-zA-Z0-9_-]+$
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Fallback streaming tool_call id when provider omits one (index optional)
export function fallbackToolCallId(index) {
  return index === undefined ? `call_${Date.now()}` : `call_${index}_${Date.now()}`;
}

// Generate deterministic tool call ID from position + tool name (cache-friendly)
export function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName = "") {
  const name = toolName ? `_${toolName.replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

// Sanitize ID to match Anthropic pattern: keep only alphanumeric, underscore, hyphen
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

// Ensure all tool_calls have valid id field and arguments is string (some providers require it)
export function ensureToolCallIds(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j];
        // Validate or regenerate ID for Anthropic compatibility
        if (!tc.id || !TOOL_ID_PATTERN.test(tc.id)) {
          const sanitized = sanitizeToolId(tc.id);
          tc.id = sanitized || generateToolCallId(i, j, tc.function?.name);
        }
        if (!tc.type) {
          tc.type = "function";
        }
        // Ensure arguments is JSON string, not object
        if (tc.function?.arguments && typeof tc.function.arguments !== "string") {
          tc.function.arguments = JSON.stringify(tc.function.arguments);
        }
      }
    }

    // Validate tool_call_id in tool messages (role: "tool")
    if (msg.role === "tool" && msg.tool_call_id && !TOOL_ID_PATTERN.test(msg.tool_call_id)) {
      const sanitized = sanitizeToolId(msg.tool_call_id);
      msg.tool_call_id = sanitized || generateToolCallId(i, 0);
    }

    // Also validate tool_use blocks in content (Claude format)
    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_use" && block.id && !TOOL_ID_PATTERN.test(block.id)) {
          const sanitized = sanitizeToolId(block.id);
          block.id = sanitized || generateToolCallId(i, k, block.name);
        }
        // Validate tool_use_id in tool_result blocks
        if (block.type === "tool_result" && block.tool_use_id && !TOOL_ID_PATTERN.test(block.tool_use_id)) {
          const sanitized = sanitizeToolId(block.tool_use_id);
          block.tool_use_id = sanitized || generateToolCallId(i, k);
        }
      }
    }
  }

  return body;
}

// Get tool_call ids from assistant message (OpenAI format: tool_calls, Claude format: tool_use in content)
export function getToolCallIds(msg) {
  if (msg.role !== "assistant") return [];

  const ids = [];

  // OpenAI format: tool_calls array
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.id) ids.push(tc.id);
    }
  }

  // Claude format: tool_use blocks in content
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        ids.push(block.id);
      }
    }
  }

  return ids;
}

// Check if user message has tool_result for given ids (OpenAI format: role=tool, Claude format: tool_result in content)
export function hasToolResults(msg, toolCallIds) {
  if (!msg || !toolCallIds.length) return false;

  // OpenAI format: role = "tool" with tool_call_id
  if (msg.role === "tool" && msg.tool_call_id) {
    return toolCallIds.includes(msg.tool_call_id);
  }

  // Claude format: tool_result blocks in user message content
  if (msg.role === "user" && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && toolCallIds.includes(block.tool_use_id)) {
        return true;
      }
    }
  }

  return false;
}

// Fix missing tool responses - insert empty tool_result if assistant has tool_use but next message has no tool_result
export function fixMissingToolResponses(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const newMessages = [];

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    const nextMsg = body.messages[i + 1];

    newMessages.push(msg);

    // Check if this is assistant with tool_calls/tool_use
    const toolCallIds = getToolCallIds(msg);
    if (toolCallIds.length === 0) continue;

    // Check if next message has tool_result
    if (nextMsg && !hasToolResults(nextMsg, toolCallIds)) {
      // Insert tool responses for each tool_call
      for (const id of toolCallIds) {
        // OpenAI format: role = "tool"
        newMessages.push({
          role: "tool",
          tool_call_id: id,
          content: ""
        });
      }
    }
  }

  body.messages = newMessages;
  return body;
}

// ── Tool-history reconciliation ──────────────────────────────────────────────
//
// An OpenAI chat conversation is only valid when every assistant `tool_calls`
// entry is answered by exactly one `role:"tool"` message carrying that id, and
// no tool message exists without a call. Strict upstreams enforce the rule:
// CodeBuddy answers `11148 "tool calls and tool results do not match"`, DeepSeek
// `"Invalid parameter: 'tool_calls' type error"`. A client that loses a turn in
// the middle of a tool call — interrupted agent, a queued message preempting the
// active turn, compaction cutting inside a pair, a Responses history whose tail
// is an unanswered call — replays that broken history on every retry, so each
// combo member rejects every attempt and the session never recovers.
//
// `fixMissingToolResponses` is not enough: it only looks at the message directly
// after a call, so it skips a trailing dangling call outright, misses a partial
// parallel answer (`hasToolResults` is true when *any* id matched), and on a
// split pair (`call → user → result`) inserts an empty result and leaves the
// real one behind as a duplicate.
//
// Rules applied here, in place of that heuristic:
//   * `tool_calls` is either a non-empty array or the key is gone;
//   * every call has a unique id, a name, and arguments as a JSON-object string;
//   * each call owns exactly one result, emitted immediately after its assistant
//     turn — a result found further down the history is moved up, not copied;
//   * a call with no result anywhere is dropped when its assistant turn is the
//     last message (the turn is still in flight: the result will arrive in the
//     next request, and a synthesized one would shadow it), otherwise a
//     placeholder result closes the turn;
//   * tool messages without a call (including duplicate answers) are dropped;
//   * an assistant turn left with no calls and no content is dropped.
const TOOL_NO_RESPONSE_PLACEHOLDER = "[No response received]";

// `arguments` must be a JSON object encoded as a string. Double-encoded values
// (`"\"{bad\""`, produced when a client stringifies an already-stringified
// field) and freeform text are exactly what the upstream reports as a
// `tool_calls` type error, so they are replaced with an empty object; the call
// itself stays, its id still pairs with a result.
function coerceToolArguments(value) {
  if (typeof value === "string") {
    if (value === "") return value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? value : "{}";
    } catch {
      return "{}";
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
  return "{}";
}

function hasMessageContent(content) {
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return content != null;
}

export function createToolRepairStats() {
  return {
    changed: false,
    droppedCalls: 0,
    synthesizedResults: 0,
    movedResults: 0,
    orphanResults: 0,
    duplicateIds: 0,
    normalizedCalls: 0,
    coercedArguments: 0,
    droppedMessages: 0,
  };
}

// Human summary for the request line; counts only, no tool names or ids.
export function formatToolRepairs(repairs) {
  if (!repairs?.changed) return null;
  const parts = [];
  if (repairs.droppedCalls) parts.push(`dropped ${repairs.droppedCalls} call${repairs.droppedCalls > 1 ? "s" : ""}`);
  if (repairs.synthesizedResults) parts.push(`synthesized ${repairs.synthesizedResults} result${repairs.synthesizedResults > 1 ? "s" : ""}`);
  if (repairs.movedResults) parts.push(`moved ${repairs.movedResults} result${repairs.movedResults > 1 ? "s" : ""}`);
  if (repairs.orphanResults) parts.push(`dropped ${repairs.orphanResults} orphan${repairs.orphanResults > 1 ? "s" : ""}`);
  if (repairs.duplicateIds) parts.push(`deduped ${repairs.duplicateIds} id${repairs.duplicateIds > 1 ? "s" : ""}`);
  if (repairs.normalizedCalls) parts.push(`normalized ${repairs.normalizedCalls} call${repairs.normalizedCalls > 1 ? "s" : ""}`);
  if (repairs.coercedArguments) parts.push(`coerced ${repairs.coercedArguments} args`);
  if (repairs.droppedMessages) parts.push(`dropped ${repairs.droppedMessages} empty turn${repairs.droppedMessages > 1 ? "s" : ""}`);
  return parts.length > 0 ? `TOOLFIX: ${parts.join(" · ")}` : null;
}

/**
 * Repair OpenAI-format tool history. Never mutates the input messages: combo
 * members share one body, so an in-place repair would leak into the next member.
 * A valid history is returned as the same array instance, which lets the caller
 * skip the assignment (and keeps the prompt prefix byte-identical for caches).
 *
 * @param {Array<object>} messages
 * @returns {{ messages: Array<object>, repairs: ReturnType<typeof createToolRepairStats> }}
 */
export function reconcileToolHistory(messages) {
  const repairs = createToolRepairStats();
  if (!Array.isArray(messages) || messages.length === 0) return { messages, repairs };

  // Where every tool result lives. `consumed` holds the indexes a call took.
  const resultIndexes = new Map();
  messages.forEach((msg, index) => {
    if (msg?.role === "tool" && typeof msg.tool_call_id === "string" && msg.tool_call_id) {
      const list = resultIndexes.get(msg.tool_call_id);
      if (list) list.push(index);
      else resultIndexes.set(msg.tool_call_id, [index]);
    }
  });

  const consumed = new Set();
  const claimedIds = new Set();
  // assistant index → { msg, calls: [{ call, resultIndex }] }
  const plan = new Map();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    if (msg.tool_calls.length === 0) {
      repairs.changed = true;
      plan.set(i, { msg, calls: [] });
      continue;
    }

    const calls = [];
    for (const rawCall of msg.tool_calls) {
      if (!rawCall || typeof rawCall !== "object") {
        repairs.droppedCalls += 1;
        continue;
      }
      const id = typeof rawCall.id === "string" ? rawCall.id : "";
      const name = rawCall.function?.name;
      // A call we cannot name or identify cannot be paired with a result, and an
      // upstream rejects it as a malformed entry — drop it rather than guess.
      if (!id || typeof name !== "string" || name.length === 0) {
        repairs.droppedCalls += 1;
        continue;
      }
      if (claimedIds.has(id)) {
        // Two turns claiming one id: keep the first, drop the impostor (its
        // result, if any, is then an orphan and goes away below).
        repairs.duplicateIds += 1;
        continue;
      }
      claimedIds.add(id);

      const rawArguments = rawCall.function?.arguments;
      const args = coerceToolArguments(rawArguments);
      if (args !== rawArguments) repairs.coercedArguments += 1;
      if (!rawCall.type) repairs.normalizedCalls += 1;

      const candidates = resultIndexes.get(id) || [];
      const resultIndex = candidates.find((index) => !consumed.has(index));
      if (resultIndex !== undefined) consumed.add(resultIndex);

      calls.push({
        call: {
          ...rawCall,
          id,
          type: rawCall.type || "function",
          function: { ...rawCall.function, name, arguments: args },
        },
        resultIndex,
      });
    }

    const isTrailing = i === messages.length - 1;
    for (const entry of calls) {
      if (entry.resultIndex !== undefined) continue;
      if (isTrailing) {
        // The turn is still running: the client sends this same call again with
        // the real output. Fabricating a result here would make the real one a
        // duplicate that the dedup below discards — the model would lose it.
        repairs.droppedCalls += 1;
        entry.dropCall = true;
      } else {
        repairs.synthesizedResults += 1;
      }
    }

    plan.set(i, { msg, calls: calls.filter((entry) => !entry.dropCall) });
  }

  if (plan.size === 0 && !messages.some((msg) => msg?.role === "tool")) {
    // Nothing to pair and no results to place: the history is fine (or has no
    // tool traffic at all).
    return { messages, repairs };
  }
  // Track movement for the log line: a result that is not where the pair should
  // sit is moved, and that is the signal that the history was split.
  for (const [assistantIndex, entry] of plan) {
    for (const call of entry.calls) {
      if (call.resultIndex !== undefined && call.resultIndex > assistantIndex + 1) repairs.movedResults += 1;
    }
  }

  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const planned = plan.get(i);

    if (planned) {
      const { calls } = planned;
      if (calls.length === 0) {
        const { tool_calls, ...rest } = msg;
        if (!hasMessageContent(rest.content)) {
          repairs.droppedMessages += 1;
          continue;
        }
        out.push(rest);
        continue;
      }
      out.push({ ...msg, tool_calls: calls.map((entry) => entry.call) });
      for (const entry of calls) {
        if (entry.resultIndex !== undefined) out.push(messages[entry.resultIndex]);
        else out.push({ role: "tool", tool_call_id: entry.call.id, content: TOOL_NO_RESPONSE_PLACEHOLDER });
      }
      continue;
    }

    if (msg?.role === "tool") {
      if (consumed.has(i)) continue; // already emitted next to its call
      repairs.orphanResults += 1;
      continue;
    }

    out.push(msg);
  }

  repairs.changed = repairs.changed
    || repairs.droppedCalls > 0 || repairs.synthesizedResults > 0
    || repairs.movedResults > 0 || repairs.orphanResults > 0
    || repairs.duplicateIds > 0 || repairs.normalizedCalls > 0 || repairs.coercedArguments > 0
    || repairs.droppedMessages > 0
    || out.length !== messages.length;

  return { messages: repairs.changed ? out : messages, repairs };
}

/**
 * Read-only scan of a dispatched tool history, used to explain an upstream 4xx
 * that names a `tool_calls` problem. Returns compact flags with message indexes
 * only — no content, tool names or ids reach the log.
 *
 * @param {Array<object>} messages
 * @param {{ maxToolNameLength?: number, limit?: number }} [options]
 * @returns {string[]}
 */
export function findToolHistoryAnomalies(messages, { maxToolNameLength = 64, limit = 8 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const anomalies = [];
  const claimed = new Map();
  const answered = new Set();
  const callIndexes = [];

  messages.forEach((msg, i) => {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      if (msg.tool_calls.length === 0) anomalies.push(`m${i}:calls:empty`);
      for (const call of msg.tool_calls) {
        const id = typeof call?.id === "string" ? call.id : "";
        if (!id) { anomalies.push(`m${i}:call:no-id`); continue; }
        if (claimed.has(id)) anomalies.push(`m${i}:call:dup-id`);
        else claimed.set(id, i);
        callIndexes.push({ id, index: i });
        const name = call?.function?.name;
        if (typeof name !== "string" || name.length === 0) anomalies.push(`m${i}:call:no-name`);
        else if (name.length > maxToolNameLength) anomalies.push(`m${i}:call:name>${maxToolNameLength}`);
        const args = call?.function?.arguments;
        if (typeof args !== "string") anomalies.push(`m${i}:call:args:${args === undefined ? "missing" : typeof args}`);
        else if (args !== "") {
          try {
            const parsed = JSON.parse(args);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) anomalies.push(`m${i}:call:args:not-object`);
          } catch {
            anomalies.push(`m${i}:call:args:invalid`);
          }
        }
      }
    } else if (msg?.role === "tool") {
      const id = msg.tool_call_id;
      if (typeof id !== "string" || id.length === 0) anomalies.push(`m${i}:result:no-id`);
      else if (answered.has(id)) anomalies.push(`m${i}:result:dup`);
      else if (!claimed.has(id)) anomalies.push(`m${i}:result:orphan`);
      else answered.add(id);
    } else if (msg?.tool_calls) {
      anomalies.push(`m${i}:call:on-${msg.role || "unknown"}`);
    }
  });

  for (const { id, index } of callIndexes) {
    if (!answered.has(id)) anomalies.push(`m${index}:call:dangling`);
  }

  return anomalies.slice(0, limit);
}

// Default `type: "custom"` on Claude-format tools that arrive without one.
// Anthropic's Claude tool schema requires `type` to be explicitly set; strict gateways
// (e.g., MiniMax Anthropic-compatible endpoint, error 2013) reject legacy payloads that
// omit it with HTTP 400. Tools that already carry a truthy `type` (e.g., `computer_use`,
// `bash`, `web_search_20250305`) are passed through untouched.
//
// Spread order matters: `{ ...tool, type: "custom" }` (spread first, override last)
// ensures that falsy `type` values (null, undefined, "") in the original tool don't
// overwrite the default. `{ type: "custom", ...tool }` would let `type: null` survive.
export function defaultClaudeToolType(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => tool?.type ? tool : { ...tool, type: "custom" });
}

// Whether Claude-format tools need explicit `type` defaulting before dispatch.
// Only gateways that declare the `requireClaudeToolType` quirk (MiniMax) reject typeless
// tools. Applying the default globally breaks Claude-format endpoints that only accept the
// legacy typeless tool shape — DeepSeek's Anthropic-compatible endpoint answers HTTP 400
// "unknown variant `custom`" and every Claude Code request routed there fails (#3905).
export function shouldDefaultClaudeToolType(provider, finalFormat, tools, PROVIDERS) {
  return (
    finalFormat === FORMATS.CLAUDE
    && Array.isArray(tools)
    && PROVIDERS?.[provider]?.quirks?.requireClaudeToolType === true
  );
}

