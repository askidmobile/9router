import { COMBO_HEALTH_CONFIG } from "../config/comboHealth.js";
import { FORMATS } from "../translator/formats.js";

const FAILURE_REASONS = new Set(["failed", "error", "server_error", "network_error", "timeout", "cancelled", "canceled", "in_progress"]);
const RESPONSES_FORMATS = new Set([FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE, FORMATS.CODEX]);
const TERMINAL_EVENTS = new Set(["message_stop", "response.completed", "response.done", "response.incomplete"]);
const FAILURE_EVENTS = new Set(["error", "response.failed", "response.error", "response.cancelled"]);

function failedReason(value) {
  return typeof value === "string" && FAILURE_REASONS.has(value.toLowerCase());
}

/** Check upstream JSON before format conversion can discard its failure fields. */
export function isFailedComboCompletion(json) {
  const visited = new Set();
  const inspect = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    if (value.error || value.success === false || FAILURE_EVENTS.has(value.type)
      || FAILURE_EVENTS.has(value.event) || ["failed", "error", "cancelled", "canceled"].includes(value.status)
      || failedReason(value.incomplete_details?.reason)) return true;
    if (Array.isArray(value.choices) && value.choices.some((choice) =>
      failedReason(choice?.finish_reason) || failedReason(choice?.native_finish_reason))) return true;
    return inspect(value.response) || inspect(value.data);
  };
  return inspect(json);
}

function createInspector({ ndjson, maxBufferedBytes }) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "";
  let data = [];
  let event = "";
  let frameBytes = 0;
  let terminal = false;

  const checkSize = (text, previous = 0) => {
    if (previous + encoder.encode(text).byteLength > maxBufferedBytes) {
      throw new Error("Combo upstream frame exceeded buffer limit");
    }
  };
  const payload = (text, eventType = "") => {
    if (FAILURE_EVENTS.has(eventType)) throw new Error("Combo upstream reported a failed completion");
    const value = text.trim();
    if (!value) return;
    if (!ndjson && value === "[DONE]") { terminal = true; return; }
    let json;
    try { json = JSON.parse(value); } catch { throw new Error("Combo upstream sent malformed completion data"); }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("Combo upstream sent malformed completion data");
    }
    if (isFailedComboCompletion(json)) throw new Error("Combo upstream reported a failed completion");
    const effective = json.response && typeof json.response === "object" ? json.response : json;
    if (TERMINAL_EVENTS.has(eventType) || TERMINAL_EVENTS.has(json.type)
      || Array.isArray(effective.choices) && effective.choices.some((choice) => choice?.finish_reason != null)
      || Array.isArray(effective.candidates) && effective.candidates.some((candidate) => candidate?.finishReason)
      || ndjson && json.done === true) terminal = true;
  };
  const dispatch = () => {
    payload(data.join("\n"), event);
    data = [];
    event = "";
    frameBytes = 0;
  };
  const line = (text) => {
    checkSize(text, ndjson ? 0 : frameBytes);
    if (ndjson) {
      if (text.trim()) payload(text);
      return;
    }
    if (text === "") { dispatch(); return; }
    frameBytes += encoder.encode(text).byteLength;
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  };

  return {
    push(bytes, done = false) {
      try { pending += decoder.decode(bytes, { stream: !done }); }
      catch { throw new Error("Combo upstream sent invalid UTF-8"); }
      let start = 0;
      for (let index = 0; index < pending.length; index++) {
        const char = pending[index];
        if (char !== "\n" && char !== "\r") continue;
        // A CRLF delimiter may itself be split between network chunks.
        if (char === "\r" && index + 1 === pending.length && !done) break;
        line(pending.slice(start, index));
        if (char === "\r" && pending[index + 1] === "\n") index++;
        start = index + 1;
      }
      pending = pending.slice(start);
      checkSize(pending, ndjson ? 0 : frameBytes);
      if (done) {
        if (pending) line(pending);
        pending = "";
        if (!ndjson) dispatch();
        if (!terminal) throw new Error("Combo upstream ended without a completion terminal");
      }
    },
  };
}

/**
 * Validate REAL upstream termination before a translator synthesizes [DONE] or
 * converts an incomplete stream into apparently successful JSON. Bytes, headers,
 * backpressure and downstream cancellation retain their native stream behavior.
 * Other JSON/binary transports remain the executor/non-stream handler's contract.
 */
export function validateComboUpstreamResponse(response, { format, maxBufferedBytes = COMBO_HEALTH_CONFIG.maxBufferedBytes } = {}) {
  if (!response?.ok || !response.body) return response;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const sse = contentType.includes("text/event-stream") || !contentType && RESPONSES_FORMATS.has(format);
  const ndjson = !sse && format === FORMATS.OLLAMA && (
    contentType.includes("application/x-ndjson") || contentType.includes("application/ndjson") || !contentType
  );
  // Kiro EventStream, Cursor protobuf and unrelated JSON must not be parsed as SSE.
  if (!sse && !ndjson) return response;
  const inspector = createInspector({ ndjson, maxBufferedBytes });
  const stream = response.body.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      inspector.push(bytes);
      controller.enqueue(bytes);
    },
    flush() { inspector.push(undefined, true); },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
