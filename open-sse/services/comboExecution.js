import { COMBO_HEALTH_CONFIG, getComboProbeTimeoutMs } from "../config/comboHealth.js";
import { GEMINI_FLEX_TIMEOUT_MS } from "../config/gemini.js";
import { getComboHealth, freezeComboModel } from "./comboHealth.js";
import { errorResponse, unavailableResponse } from "../utils/error.js";
import { isComboDeadlineError } from "../utils/abort.js";

/** These are provider outcomes, not malformed input or caller cancellation. */
export function isComboHealthFailure(status) {
  return [401, 402, 403, 404, 408, 429].includes(status) || status >= 500;
}

export function comboRetryAfter(response, payload, now = Date.now()) {
  const deadline = Date.parse(payload?.retryAfter || "");
  const raw = response?.headers?.get("retry-after");
  const header = raw && Number.isFinite(Number(raw))
    ? now + Number(raw) * 1000 : Date.parse(raw || "");
  return Math.max(now, deadline || 0, header || 0) > now
    ? Math.max(deadline || 0, header || 0) : undefined;
}

function hasContent(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasContent);
  if (!value || typeof value !== "object") return false;
  if (value.type === "tool_use" || value.type === "function_call" || value.functionCall) return true;
  if (Array.isArray(value.tool_calls) && value.tool_calls.length) return true;
  if (value.function_call || value.inlineData || value.audio || value.image_url) return true;
  return ["text", "content", "delta", "reasoning", "reasoning_content", "thinking", "refusal", "partial_json", "arguments", "parts", "content_block", "item"]
    .some((key) => hasContent(value[key]));
}

function hasFinalContent(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasFinalContent);
  if (!value || typeof value !== "object") return false;
  if (value.type === "tool_use" || value.type?.endsWith("_call") || value.functionCall) return true;
  if (Array.isArray(value.tool_calls) && value.tool_calls.length) return true;
  if (value.function_call || value.inlineData || value.audio || value.image_url) return true;
  return ["text", "content", "delta", "refusal", "partial_json", "arguments", "parts", "content_block", "item"]
    .some((key) => hasFinalContent(value[key]));
}

function hasReasoning(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasReasoning);
  if (!value || typeof value !== "object") return false;
  if (["reasoning", "thinking", "redacted_thinking"].includes(value.type)) {
    return ["summary", "content", "text", "thinking"].some((key) => hasContent(value[key]));
  }
  return ["reasoning", "reasoning_content", "reasoning_details", "thinking", "summary",
    "choices", "candidates", "output", "message", "delta"]
    .some((key) => hasReasoning(value[key]));
}

function hasFailure(json) {
  return !!(json?.error || json?.response?.error || json?.status === "failed" ||
    json?.type === "error" || json?.type === "response.failed" ||
    json?.choices?.some((c) => ["network_error", "error", "server_error", "timeout", "failed"].includes(c.native_finish_reason) ||
      ["failed", "error", "network_error", "timeout"].includes(c.finish_reason)));
}

function completionMarker(json) {
  const incomplete = typeof json?.incomplete_details?.reason === "string"
    ? json.incomplete_details.reason : null;
  const finish = json?.choices?.find((choice) => choice?.finish_reason)?.finish_reason ||
    json?.candidates?.find((candidate) => candidate?.finishReason)?.finishReason || null;
  const outputTokens = json?.usage?.output_tokens ?? json?.usage?.completion_tokens;
  const parts = [];
  if (incomplete && /^[A-Za-z0-9_.:-]{1,64}$/.test(incomplete)) parts.push(`reason=${incomplete}`);
  else if (finish && /^[A-Za-z0-9_.:-]{1,64}$/.test(finish)) parts.push(`finish_reason=${finish}`);
  else if (typeof json?.status === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(json.status)) parts.push(`status=${json.status}`);
  if (Number.isSafeInteger(outputTokens) && outputTokens >= 0) parts.push(`output_tokens=${outputTokens}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** A recognized but empty generation is request-specific and must not open a global circuit. */
export function getComboCompletionIssue(json, { probe = false } = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { reason: "Invalid completion response shape", healthFailure: true };
  }
  if (hasFailure(json)) return { reason: "Upstream completion reported failure", healthFailure: true };

  if (probe) {
    const text = json.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) return null;
    return { reason: `Recovery probe returned no answer text${completionMarker(json)}`, healthFailure: false };
  }

  let recognized = false;
  let valid = false;
  if (Array.isArray(json.choices)) {
    recognized = json.choices.length > 0;
    valid = json.choices.some((choice) => hasFinalContent(choice.message || choice.delta || choice.text));
  } else if (Array.isArray(json.candidates)) {
    recognized = json.candidates.length > 0;
    valid = json.candidates.some((candidate) => hasFinalContent(candidate.content));
  } else if (Array.isArray(json.output)) {
    recognized = true;
    valid = json.output.some(hasFinalContent);
  } else if (json.type === "message") {
    recognized = true;
    valid = hasFinalContent(json.content);
  }
  if (valid) return null;
  if (!recognized) return { reason: "Invalid completion response shape", healthFailure: true };

  const marker = completionMarker(json);
  if (hasReasoning(json)) {
    return { reason: `Completion contained reasoning but no final answer${marker}`, healthFailure: false };
  }
  return { reason: `Completion returned no final answer${marker}`, healthFailure: false };
}

export function isValidComboCompletion(json, { probe = false } = {}) {
  return getComboCompletionIssue(json, { probe }) === null;
}

class ComboCompletionError extends Error {
  constructor(issue) {
    super(issue.reason);
    this.healthFailure = issue.healthFailure;
  }
}

/** Inspects translated SSE without changing any bytes returned to the client. */
export function createComboStreamInspector(maxBufferedBytes = COMBO_HEALTH_CONFIG.maxBufferedBytes) {
  const decoder = new TextDecoder();
  let pending = "";
  const state = { meaningful: false, terminal: false, definitiveTerminal: false, progress: 0 };
  function frame(text) {
    const data = text.split("\n").filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart()).join("\n").trim();
    if (!data) return;
    if (data === "[DONE]") { state.terminal = true; state.definitiveTerminal = true; return; }
    let json;
    try { json = JSON.parse(data); } catch { throw new Error("Invalid completion response"); }
    if (hasFailure(json)) throw new Error("Upstream stream failed");
    const content = hasContent(json) || json.choices?.some((c) => hasContent(c.delta || c.message || c.text)) ||
      json.candidates?.some((c) => hasContent(c.content)) || json.output?.some(hasContent);
    if (content) { state.meaningful = true; state.progress++; }
    if (["message_stop", "response.completed", "response.incomplete"].includes(json.type) ||
      json.choices?.some((c) => c.finish_reason != null) || json.candidates?.some((c) => c.finishReason)) {
      state.terminal = true;
    }
    if (["message_stop", "response.completed", "response.incomplete"].includes(json.type)) state.definitiveTerminal = true;
  }
  return {
    state,
    push(bytes, done = false) {
      pending += decoder.decode(bytes, { stream: !done });
      pending = pending.replace(/\r\n/g, "\n");
      let index;
      while ((index = pending.indexOf("\n\n")) >= 0) {
        frame(pending.slice(0, index));
        pending = pending.slice(index + 2);
      }
      if (pending.length > maxBufferedBytes) throw new Error("Invalid completion response");
      if (done && pending.trim()) { frame(pending); pending = ""; }
      return state;
    },
  };
}

/**
 * One canonical Combo member, encompassing every account and executor attempt.
 * Only recovery probes may close an open circuit; foreground successes never do.
 */
export async function runComboModelExecution({
  provider, model, body, signal, execute, flex = false, probe = false, log,
  requestTimeoutFloorMs,
  config = COMBO_HEALTH_CONFIG,
  health = { get: getComboHealth, freeze: freezeComboModel },
}) {
  if (signal?.aborted) return errorResponse(499, "Request aborted");
  if (!probe) {
    const frozen = await health.get(provider, model);
    if (signal?.aborted) return errorResponse(499, "Request aborted");
    if (frozen) {
      log?.info?.("COMBO_HEALTH", `Skipping frozen ${provider}/${model}`);
      return unavailableResponse(503, `Combo member ${provider}/${model} is awaiting a successful background check`,
        new Date(Math.max(Date.now() + config.probeIntervalMs, frozen.nextProbeAt)).toISOString(), "background check pending");
    }
  }

  const controller = new AbortController();
  let timer;
  let timeoutReason = null;
  let cleaned = false;
  let consumerCancelled = false;
  let reader;
  let response;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // A rejection may precede the next read while downstream is applying backpressure.
  aborted.catch(() => {});
  const onAbort = () => rejectAbort(controller.signal.reason || new Error("Request aborted"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const onParentAbort = () => {
    if (isComboDeadlineError(signal.reason)) timeoutReason = "Response deadline exceeded";
    controller.abort(signal.reason);
  };
  signal?.addEventListener("abort", onParentAbort, { once: true });
  if (signal?.aborted) onParentAbort();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
    controller.signal.removeEventListener("abort", onAbort);
  };
  const arm = (ms, reason) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timeoutReason = reason;
      controller.abort(new Error(reason));
    }, ms);
    timer.unref?.();
  };
  const wait = (promise) => Promise.race([promise, aborted]);
  let failureRecorded = false;
  const fail = async (status, reason, retryAfterMs) => {
    if (failureRecorded || probe || consumerCancelled ||
      (signal?.aborted && !isComboDeadlineError(signal.reason)) || !isComboHealthFailure(status)) return;
    failureRecorded = true;
    await health.freeze({ provider, model, status, reason, retryAfterMs });
    log?.warn?.("COMBO_HEALTH", `Frozen ${provider}/${model}: ${reason}`);
  };
  const cancel = () => {
    if (!controller.signal.aborted) controller.abort(new Error("Combo response closed"));
    const pendingCancel = reader ? reader.cancel() : response?.body?.cancel();
    pendingCancel?.catch(() => {});
  };
  const probeMs = getComboProbeTimeoutMs(provider, model, config);
  const timeoutFloorMs = Number.isSafeInteger(requestTimeoutFloorMs) && requestTimeoutFloorMs > 0
    ? requestTimeoutFloorMs : 0;
  const firstMs = probe ? probeMs
    : Math.max(flex ? GEMINI_FLEX_TIMEOUT_MS : config.firstResponseTimeoutMs, timeoutFloorMs);
  const fullMs = probe ? probeMs
    : Math.max(flex ? GEMINI_FLEX_TIMEOUT_MS : config.requestTimeoutMs, timeoutFloorMs);
  const wantsStream = body.stream === true || Array.isArray(body.contents) || !!body.request?.contents;
  arm(wantsStream ? firstMs : fullMs, wantsStream ? "First response timeout" : "Response deadline exceeded");

  try {
    const requestPolicy = {
      maxRetries: 0,
      headersTimeoutMs: firstMs,
      strictCompletion: true,
      ...(timeoutFloorMs ? { headersTimeoutFloorMs: timeoutFloorMs } : {}),
    };
    const task = Promise.resolve().then(() => execute(controller.signal, requestPolicy));
    task.then((late) => {
      if (controller.signal.aborted && late?.body && !late.body.locked) late.body.cancel().catch(() => {});
    }, () => {});
    response = await wait(task);
    if (!response.ok) {
      const text = await wait(response.text());
      let payload;
      try { payload = JSON.parse(text); } catch { /* Plain HTTP errors remain HTTP errors. */ }
      await fail(response.status, `Upstream HTTP ${response.status}`, comboRetryAfter(response, payload));
      cleanup();
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const text = await wait(response.text());
      let json;
      try { json = JSON.parse(text); }
      catch { throw new ComboCompletionError({ reason: "Malformed completion JSON", healthFailure: true }); }
      const issue = getComboCompletionIssue(json, { probe });
      if (issue) throw new ComboCompletionError(issue);
      cleanup();
      return new Response(text, { status: response.status, headers: response.headers });
    }

    if (!response.body) throw new Error("Invalid completion response");
    reader = response.body.getReader();
    const inspector = createComboStreamInspector(config.maxBufferedBytes);
    const prefix = [];
    let bufferedBytes = 0;
    let upstreamDone = false;
    // Withhold HTTP success until real model output, enabling fallback on empty
    // 200/error streams. Comments, role-only frames and pings don't reset this timer.
    while (!inspector.state.meaningful) {
      const { value, done } = await wait(reader.read());
      inspector.push(value, done);
      if (value) { prefix.push(value); bufferedBytes += value.byteLength; }
      if (bufferedBytes > config.maxBufferedBytes) throw new Error("Invalid completion response");
      if (inspector.state.definitiveTerminal) {
        if (!inspector.state.meaningful) throw new Error("Stream ended without completion");
        upstreamDone = true;
        break;
      }
      if (done) {
        upstreamDone = true;
        if (!inspector.state.meaningful || !inspector.state.terminal) throw new Error("Stream ended without completion");
        break;
      }
    }
    clearTimeout(timer);
    let idleBudgetMs = config.streamIdleTimeoutMs;
    const stream = new ReadableStream({
      start(out) {
        for (const value of prefix) out.enqueue(value);
        if (upstreamDone) { cleanup(); cancel(); out.close(); }
      },
      async pull(out) {
        try {
          const previousProgress = inspector.state.progress;
          // Do not count a slow downstream consumer as an upstream stall. Only
          // outstanding reads spend the idle budget; heartbeats cannot reset it.
          const readStarted = Date.now();
          arm(idleBudgetMs, "Stream stalled");
          const { value, done } = await wait(reader.read());
          clearTimeout(timer);
          inspector.push(value, done);
          if (done) {
            if (!inspector.state.terminal) throw new Error("Stream ended without completion");
            cleanup();
            out.close();
            return;
          }
          idleBudgetMs = inspector.state.progress > previousProgress ? config.streamIdleTimeoutMs
            : Math.max(1, idleBudgetMs - (Date.now() - readStarted));
          out.enqueue(value);
          if (inspector.state.definitiveTerminal) { cleanup(); cancel(); out.close(); }
        } catch (error) {
          await fail(timeoutReason ? 504 : 502, timeoutReason || "Upstream stream failed");
          cancel();
          cleanup();
          if (!consumerCancelled) out.error(error);
        }
      },
      cancel() { consumerCancelled = true; cancel(); cleanup(); },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  } catch (error) {
    const status = signal?.aborted && !isComboDeadlineError(signal.reason) ? 499 : timeoutReason ? 504 : 502;
    const completionError = error instanceof ComboCompletionError;
    const reason = status === 499 ? "Request aborted" : timeoutReason ||
      (completionError ? error.message : "Invalid completion response");
    try {
      if (!completionError || error.healthFailure) await fail(status, reason);
      else log?.warn?.("COMBO", `Rejected ${provider}/${model} response without opening its circuit: ${reason}`);
    } finally { cancel(); cleanup(); }
    return errorResponse(status, reason);
  }
}
