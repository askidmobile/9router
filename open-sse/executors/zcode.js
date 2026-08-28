/**
 * ZcodeExecutor — routes completions through the local ZCode CLI app-server
 * (`zcode app-server`), turning each API request into one coding turn.
 *
 * Protocol: line-delimited JSON over stdio (see shared/zcode/protocol.js).
 * Flow per request: session/create → session/send → poll session/read until
 * the turn is terminal → session/close → kill the subprocess. Stateless by
 * design: the whole OpenAI conversation is flattened into the turn prompt.
 *
 * Auth: the provider's API key (a Z.ai Coding Plan key) is handed to the
 * spawned app-server through the `ZHIPU_API_KEY` environment variable and the
 * provider's `apiKey: { source: "env" }` reference. The key never appears in
 * logs, request bodies, or this process's own outbound traffic; stderr of the
 * subprocess is intentionally discarded (it can echo provider diagnostics).
 *
 * Binary discovery: ZCODE_BIN (+ optional ZCODE_ARGS JSON array) → `zcode` on
 * the known install paths → macOS app bundle entry. Paths pointing at a
 * .cjs/.js entry are run with the current Node executable.
 *
 * The app-server has no real streaming: the turn's text arrives as a whole,
 * so stream=true is emulated as OpenAI SSE chunks after the turn completes.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BaseExecutor } from "./base.js";
import { ZcodeAppServerClient, ZcodeProtocolError } from "../shared/zcode/protocol.js";
import { errorResponse } from "../utils/error.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import ZCODE_REGISTRY from "../providers/registry/zcode.js";

const ZCODE_URL = "zcode://app-server/stdio";
const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_PROVIDER_ID = "zai-coding-plan";
const TERMINAL_STATUSES = new Set(["completed", "idle", "paused", "error"]);

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

// Turn prompt guard: absurdly large conversations are rejected before we
// spend a subprocess spawn and Coding Plan quota on them (~1M chars ≈ 250k
// tokens, well within GLM's 1M-token context but past any sane /v1 request).
const MAX_PROMPT_CHARS = Number(process.env.ZCODE_MAX_PROMPT_CHARS || 1_000_000);

// Bound concurrent turns: each request spawns a full app-server subprocess.
let activeTurns = 0;

function maxConcurrent() {
  return Math.max(1, Number(process.env.ZCODE_MAX_CONCURRENT || 2));
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

/** Flatten an OpenAI conversation into one ZCode turn prompt. */
export function buildZcodePrompt(messages) {
  const parts = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const text = extractText(message.content).trim();
    if (!text) continue;
    const label = message.role === "system" ? "System" : message.role === "assistant" ? "Assistant" : "User";
    parts.push(`[${label}]\n${text}`);
  }
  return parts.join("\n\n");
}

/** Resolve a /v1 model id ("zcode/glm-5.3-flash", "zc/glm-5.3", bare) to a catalog id. */
export function resolveZcodeModel(requested) {
  const catalog = new Set(ZCODE_REGISTRY.models.map((m) => m.id));
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return { ok: true, model: ZCODE_REGISTRY.models[0].id };
  const stripped = raw.startsWith("zcode/") ? raw.slice("zcode/".length)
    : raw.startsWith("zc/") ? raw.slice("zc/".length)
    : raw;
  if (!catalog.has(stripped)) {
    return { ok: false, error: `Unknown ZCode model "${requested}". Supported models: ${[...catalog].join(", ")}.` };
  }
  return { ok: true, model: stripped };
}

/** Parse ZCODE_ARGS as a strict JSON array of short strings. */
function parseZcodeArgs(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ZCODE_ARGS must be a JSON array of strings");
  }
  if (!Array.isArray(parsed) || parsed.length > 16 || parsed.some((a) => typeof a !== "string" || a.length > 4096)) {
    throw new Error("ZCODE_ARGS must be a JSON array of at most 16 strings (each ≤ 4096 chars)");
  }
  return parsed;
}

/**
 * Locate the ZCode CLI. Returns { command, args } for spawn, or { error }.
 * ZCODE_BIN wins; a .cjs/.js entry is run with the current Node executable.
 */
export function resolveZcodeBin(env = process.env) {
  const extraArgs = parseZcodeArgs(env.ZCODE_ARGS);
  const isScript = (p) => /\.(cjs|mjs|js)$/i.test(p);

  if (env.ZCODE_BIN?.trim()) {
    const bin = env.ZCODE_BIN.trim();
    if (isScript(bin)) return { command: process.execPath, args: [bin, ...(extraArgs ?? [])] };
    return { command: bin, args: extraArgs ?? ["app-server"] };
  }

  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push({ path: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", script: true });
  }
  const home = homedir();
  for (const p of [
    join(home, ".local", "bin", "zcode"),
    "/opt/homebrew/bin/zcode",
    "/usr/local/bin/zcode",
    "/usr/bin/zcode",
  ]) {
    candidates.push({ path: p, script: false });
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      if (candidate.script) return { command: process.execPath, args: [candidate.path, "app-server"] };
      return { command: candidate.path, args: ["app-server"] };
    }
  }
  return { error: "ZCode CLI not found. Install ZCode (https://z.ai) or set ZCODE_BIN to the CLI entry (e.g. /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs)." };
}

function workspaceDir() {
  const dir = process.env.ZCODE_CWD?.trim() || join(tmpdir(), "9router-zcode-workspace");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Pull the last assistant text (skipping system timeline events) out of a session read. */
export function extractAssistantText(state) {
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = message?.info?.role ?? message?.role;
    const kind = message?.info?.semantics?.kind;
    if (role !== "assistant" || kind === "timeline_event") continue;
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ZcodeProtocolError("ZCode request aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function sseChunks(model, content) {
  const id = `chatcmpl-zcode-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) => `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  const pieces = content.match(/[\s\S]{1,256}/g) ?? [""];
  const body = [
    chunk({ role: "assistant", content: "" }, null),
    ...pieces.map((piece) => chunk({ content: piece }, null)),
    chunk({}, "stop"),
    SSE_DONE,
  ].join("");
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

function completionResponse(model, prompt, content) {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(content);
  return new Response(JSON.stringify({
    id: `chatcmpl-zcode-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      estimated: true,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class ZcodeExecutor extends BaseExecutor {
  constructor() {
    super("zcode", { id: "zcode", baseUrl: ZCODE_URL, format: "openai" });
  }

  buildUrl() {
    return ZCODE_URL;
  }

  // Auth is passed to the subprocess via env, never as HTTP headers.
  buildHeaders() {
    return {};
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const resolution = resolveZcodeModel(model);
    if (!resolution.ok) {
      return { response: errorResponse(400, resolution.error), url: ZCODE_URL, headers: {}, transformedBody: { model } };
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const prompt = buildZcodePrompt(messages);
    if (!prompt.trim()) {
      return { response: errorResponse(400, "ZCode requires a non-empty conversation."), url: ZCODE_URL, headers: {}, transformedBody: { model: resolution.model } };
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return { response: errorResponse(400, `ZCode turn prompt exceeds the ${MAX_PROMPT_CHARS} character limit (got ${prompt.length}). Trim the conversation.`), url: ZCODE_URL, headers: {}, transformedBody: { model: resolution.model } };
    }

    const bin = resolveZcodeBin();
    if (bin.error) {
      return { response: errorResponse(502, bin.error), url: ZCODE_URL, headers: {}, transformedBody: { model: resolution.model } };
    }

    const limit = maxConcurrent();
    if (activeTurns >= limit) {
      return { response: errorResponse(429, `ZCode is already running ${activeTurns} concurrent turn(s) (limit ${limit}). Retry shortly or raise ZCODE_MAX_CONCURRENT.`), url: ZCODE_URL, headers: {}, transformedBody: { model: resolution.model } };
    }

    const apiKey = credentials?.apiKey;
    if (!apiKey) {
      return { response: errorResponse(401, "ZCode connection is missing its Z.ai Coding Plan API key. Re-save the connection with a key from console.z.ai."), url: ZCODE_URL, headers: {}, transformedBody: { model: resolution.model } };
    }

    activeTurns += 1;
    try {
      const content = await this.runTurn({ bin, apiKey, model: resolution.model, prompt, signal, log });
      const response = stream
        ? sseChunks(resolution.model, content)
        : completionResponse(resolution.model, prompt, content);
      return { response, url: ZCODE_URL, headers: {}, transformedBody: { model: resolution.model, promptLength: prompt.length, buffered: true } };
    } catch (error) {
      const aborted = signal?.aborted;
      const raw = aborted ? "request aborted by client" : (error?.message || String(error));
      // Never leak the API key through upstream error text.
      const message = String(raw).replaceAll(apiKey, "<redacted>").slice(0, 500);
      log?.debug?.("ZCODE", `turn failed: ${message}`);
      return { response: errorResponse(aborted ? 499 : 502, `ZCode error: ${message}`), url: ZCODE_URL, headers: {}, transformedBody: { model: resolution.model } };
    } finally {
      activeTurns -= 1;
    }
  }

  async runTurn({ bin, apiKey, model, prompt, signal, log }) {
    const cwd = workspaceDir();
    const client = new ZcodeAppServerClient({
      command: bin.command,
      args: bin.args,
      cwd,
      env: apiKey ? { ZHIPU_API_KEY: apiKey } : {},
      startupTimeoutMs: envInt("ZCODE_STARTUP_TIMEOUT_MS", 10_000),
      requestTimeoutMs: envInt("ZCODE_RPC_TIMEOUT_MS", 30_000),
    });

    let sessionId;
    let turnTimedOut = false;
    try {
      await client.start();
      if (signal?.aborted) throw new ZcodeProtocolError("ZCode request aborted");

      const runtimeModel = {
        revision: "1",
        generatedAt: Date.now(),
        model: { providerId: DEFAULT_PROVIDER_ID, modelId: model },
        provider: {
          providerId: DEFAULT_PROVIDER_ID,
          kind: "openai-compatible",
          apiFormat: "openai-chat-completions",
          label: "Z.AI Coding Plan (9router)",
          baseURL: process.env.ZCODE_API_BASE_URL?.trim() || ZAI_CODING_BASE_URL,
          apiKey: { source: "env", name: "ZHIPU_API_KEY" },
          models: ZCODE_REGISTRY.models.map((m) => ({
            modelId: m.id,
            label: m.name,
            ...(m.contextLength ? { contextWindow: m.contextLength } : {}),
          })),
        },
      };

      const created = await client.call("session/create", {
        workspace: { workspacePath: cwd, workspaceIdentity: cwd, workspaceKey: cwd },
        runtimeModel,
      });
      sessionId = created?.session?.sessionId
        || (created?.projection?.sessionId && created.projection.sessionId !== "unknown" ? created.projection.sessionId : undefined);
      if (!sessionId) throw new ZcodeProtocolError("ZCode session/create returned no sessionId");

      await client.call("session/send", { sessionId, content: prompt });
      log?.debug?.("ZCODE", `turn started model=${model} session=${sessionId}`);

      const deadline = Date.now() + envInt("ZCODE_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS);
      const pollIntervalMs = envInt("ZCODE_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);

      let state;
      let text = "";
      while (Date.now() <= deadline) {
        if (signal?.aborted) throw new ZcodeProtocolError("ZCode request aborted");
        state = await client.call("session/read", { sessionId });
        const status = state?.session?.status;
        text = extractAssistantText(state);
        if (text && (status === undefined || TERMINAL_STATUSES.has(status))) return text;
        if (status === "error") throw new ZcodeProtocolError("turn failed upstream (model returned an error status)");
        await delay(pollIntervalMs, signal);
      }
      turnTimedOut = true;
      if (text) return text; // deadline hit but a usable answer arrived
      throw new ZcodeProtocolError(`turn timed out after ${envInt("ZCODE_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS) / 1000}s`);
    } finally {
      if (sessionId && !signal?.aborted) {
        await client.call("session/close", { sessionId }).catch(() => undefined);
      }
      void turnTimedOut;
      await client.close().catch((error) => log?.debug?.("ZCODE", `app-server close failed: ${error?.message}`));
    }
  }
}

export default ZcodeExecutor;
