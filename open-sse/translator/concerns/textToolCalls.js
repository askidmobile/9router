// Recover tool calls that a model printed as XML text instead of emitting the
// provider's structured tool_calls field. Free aggregator routes (the apinex
// free tier reported by Codex users) return the model's textual tool syntax
// verbatim, e.g.:
//
//   <tool_calls>
//   <tool_exec_command>
//   <parameter=cmd>git status</parameter>
//   <parameter=yield_time_ms>10000</parameter>
//   </tool>
//   </tool_call>
//
// Left as text this reaches Responses clients (Codex) as raw markup instead of
// being executed. parseTextToolCalls extracts the call(s) and returns the
// remaining visible assistant text.

const BLOCK_START = /<tool_calls\b/i;
const BLOCK_END = /<\/tool_calls>/i;
const CALL_TAG = /<tool_([a-zA-Z0-9_]+)>/g;
const ANY_TAG = /<([a-zA-Z][a-zA-Z0-9_]*)>/g;
const PARAM_EQUALS = /<parameter=([a-zA-Z0-9_]+)>([\s\S]*?)<\/parameter>/gi;
const PARAM_NAME = /<parameter\s+name\s*=\s*["']?([a-zA-Z0-9_]+)["']?\s*>([\s\S]*?)<\/parameter>/gi;
const CLOSE_MARKERS = ["</tool>", "</function>", "</invoke>", "</tool_call>"];

// Tags that are structure or parameters, never call names.
const RESERVED_CALL_TAGS = new Set([
  "tool_calls", "tool_call", "parameter", "parameters", "args", "arguments",
  "input", "output", "response", "result", "error", "name", "value",
  "cmd", "server",
]);

// Tags that are never parameter names when scanning a call body.
const STRUCTURAL_TAGS = new Set(["tool_calls", "tool_call", "parameter", "parameters", "args", "arguments"]);

function coerceValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stripTags(value) {
  return String(value ?? "").replace(/<[^>]*>/g, "").trim();
}

function parseParameters(body) {
  const args = {};
  let matched = false;
  for (const pattern of [PARAM_EQUALS, PARAM_NAME]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(body))) {
      args[match[1]] = coerceValue(match[2]);
      matched = true;
    }
  }
  if (matched) return args;

  // <exec><cmd><cmd>cd ...</cmd></exec> — doubled element carries the value.
  const doubled = body.match(/<([a-zA-Z][a-zA-Z0-9_]*)>\s*<\1>([\s\S]*?)<\/\1>/i);
  if (doubled) return { [doubled[1].toLowerCase()]: coerceValue(stripTags(doubled[2])) };

  // A single nested element with text content, e.g. <server>context7</server>.
  const nested = body.match(/<([a-zA-Z][a-zA-Z0-9_]*)>([^<]*)<\/\1>/i);
  if (nested && !STRUCTURAL_TAGS.has(nested[1].toLowerCase())) {
    return { [nested[1].toLowerCase()]: coerceValue(nested[2]) };
  }

  // Last resort: the whole (tag-stripped) body becomes a single argument.
  const raw = stripTags(body);
  return raw ? { cmd: raw } : {};
}

function prefixedSpans(inner) {
  const spans = [];
  CALL_TAG.lastIndex = 0;
  let match;
  while ((match = CALL_TAG.exec(inner))) {
    const name = match[1];
    const bodyStart = match.index + match[0].length;
    let bodyEnd = inner.indexOf(`</tool_${name}>`, bodyStart);
    if (bodyEnd < 0) {
      bodyEnd = CLOSE_MARKERS.reduce((found, marker) => {
        if (found >= 0) return found;
        const at = inner.indexOf(marker, bodyStart);
        return at >= 0 ? at : -1;
      }, -1);
    }
    if (bodyEnd < 0) bodyEnd = inner.length;
    spans.push({ name, tagStart: match.index, bodyStart, bodyEnd });
  }
  return spans;
}

function parseBlock(block) {
  const inner = block
    .replace(/^\s*<tool_calls\b[^>]*>/i, "")
    .replace(/<\/tool_calls>\s*$/i, "");
  const prefixed = prefixedSpans(inner);
  const entries = prefixed.map((span) => ({ ...span }));
  const inPrefixed = (index) => prefixed.some((span) => index >= span.tagStart && index < span.bodyEnd);

  ANY_TAG.lastIndex = 0;
  let match;
  while ((match = ANY_TAG.exec(inner))) {
    const name = match[1];
    if (name.startsWith("tool_")) continue; // handled by the prefixed scan
    if (RESERVED_CALL_TAGS.has(name.toLowerCase())) continue;
    if (inPrefixed(match.index)) continue;
    if (entries.some((entry) => match.index > entry.tagStart && match.index < entry.bodyEnd)) continue;
    const bodyStart = match.index + match[0].length;
    let bodyEnd = inner.indexOf(`</${name}>`, bodyStart);
    if (bodyEnd < 0) bodyEnd = inner.length;
    entries.push({ name, tagStart: match.index, bodyStart, bodyEnd });
  }

  entries.sort((left, right) => left.tagStart - right.tagStart);
  const calls = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    const args = parseParameters(inner.slice(entry.bodyStart, entry.bodyEnd));
    if (Object.keys(args).length === 0) continue;
    calls.push({ name: entry.name, arguments: JSON.stringify(args) });
  }
  return calls;
}

/**
 * Extract textual tool calls from an assistant message.
 * @param {string} text
 * @returns {{ text: string, calls: Array<{name: string, arguments: string}> }}
 */
export function parseTextToolCalls(text) {
  if (typeof text !== "string" || !text) return { text: text || "", calls: [] };
  const start = BLOCK_START.exec(text);
  if (!start) return { text, calls: [] };

  const head = text.slice(0, start.index);
  const rest = text.slice(start.index);
  const end = BLOCK_END.exec(rest);
  const block = end ? rest.slice(0, end.index + end[0].length) : rest;
  const tail = end ? rest.slice(end.index + end[0].length) : "";
  const calls = parseBlock(block);
  if (calls.length === 0) return { text, calls: [] };

  return { text: `${head}${tail}`.replace(/\n{3,}/g, "\n\n").trim(), calls };
}
