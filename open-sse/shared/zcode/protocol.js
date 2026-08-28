/**
 * ZcodeAppServerClient — local stdio client for the ZCode CLI app-server
 * (`zcode app-server`, verified against ZCode CLI 0.16.5).
 *
 * Wire format: line-delimited JSON over stdio.
 *   request      → { id, method, params }
 *   response     ← { id, result } | { id, error: { code, message, data } }
 *   notification ← { method, params }
 * The protocol is JSON-RPC-shaped WITHOUT the "jsonrpc" key. There is no
 * initialize handshake: the client calls domain methods directly, and the
 * server may issue its own requests back over the same channel (answered via
 * onServerRequest, e.g. `session/requestRuntimePreferences`).
 *
 * Turn flow used by the executor:
 *   session/create → session/send → poll session/read → session/close
 *
 * Keep this codec self-contained: the protocol is internal to Z.ai and may
 * drift between ZCode releases — patch here without touching the executor.
 *
 * Security: the spawned app-server receives the provider API key via the
 * `ZHIPU_API_KEY` environment variable; this module never logs it and never
 * forwards the subprocess stderr (it may echo provider diagnostics).
 */

import { spawn } from "node:child_process";

export const ZCODE_PROTOCOL_VERSION = "0.16.5";

/** Methods the server may ask of us; answered with static, harmless results. */
const SERVER_REQUEST_DEFAULTS = {
  // Required key per Zod validation; disabling is the honest default.
  "session/requestRuntimePreferences": { nativeSearchEnhancementsEnabled: false },
};

export class ZcodeProtocolError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ZcodeProtocolError";
    if (options.code !== undefined) this.code = options.code;
    if (options.data !== undefined) this.data = options.data;
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ZcodeProtocolError(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * One client instance wraps one spawned app-server process. Spawn per turn and
 * close afterwards — the executor does not keep long-lived servers around.
 */
export class ZcodeAppServerClient {
  constructor(options = {}) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.onNotification = options.onNotification;
    this.child = undefined;
    this.lineBuffer = "";
    this.ready = false;
    this.startPromise = undefined;
    this.firstLineWaiter = undefined;
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  start() {
    if (this.ready) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async startInternal() {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    this.child = child;
    this.lineBuffer = "";
    child.stdin.on("error", () => {
      // EPIPE is expected when timeout/abort closes an already-exited runtime.
    });

    const readyPromise = new Promise((resolve, reject) => {
      // "Ready" means the OS spawned the process (a bad path fails fast with
      // ENOENT here). The server sends no greeting; per-RPC timeouts handle a
      // process that starts but never answers.
      child.once("spawn", resolve);
      const failEarly = (error) => reject(error instanceof Error ? error : new Error(String(error)));
      child.once("error", failEarly);
      child.once("exit", () => failEarly(new ZcodeProtocolError(`ZCode app-server exited during startup`)));
    });

    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", () => {
      // ZCode stderr is intentionally not forwarded: it can contain provider
      // diagnostics or credentials from the user's local runtime.
    });
    child.on("error", (error) => {
      this.rejectPending(error);
    });
    child.on("exit", (code, signal) => {
      const error = new ZcodeProtocolError(`ZCode app-server exited: ${code ?? signal ?? "unknown"}`);
      this.ready = false;
      this.rejectPending(error);
      if (this.child === child) this.child = undefined;
    });

    try {
      await withTimeout(readyPromise, this.startupTimeoutMs, "ZCode app-server did not start in time");
      this.ready = true;
    } catch (error) {
      await this.disposeChild(child);
      throw error;
    }
  }

  onStdout(chunk) {
    this.lineBuffer += chunk.toString("utf8");
    let index;
    while ((index = this.lineBuffer.indexOf("\n")) >= 0) {
      const line = this.lineBuffer.slice(0, index).trim();
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // tolerate stray non-JSON output on stdout
      }
      this.handleMessage(msg);
    }
  }

  handleMessage(msg) {
    if (msg.id !== undefined && msg.method !== undefined) {
      // Server → client request: answer known ones, decline the rest so the
      // server degrades gracefully instead of blocking the turn.
      const reply = SERVER_REQUEST_DEFAULTS[msg.method];
      if (reply !== undefined) {
        this.child?.stdin.write(`${JSON.stringify({ id: msg.id, result: reply })}\n`);
      } else {
        this.child?.stdin.write(`${JSON.stringify({ id: msg.id, error: { code: -32601, message: `Method not supported by client: ${msg.method}` } })}\n`);
      }
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const request = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(request.timer);
      if (msg.error) {
        const detail = typeof msg.error.message === "string" ? msg.error.message : JSON.stringify(msg.error);
        request.reject(new ZcodeProtocolError(`ZCode RPC failed: ${detail}`, { code: msg.error.code }));
      } else {
        request.resolve(msg.result);
      }
      return;
    }
    if (msg.method !== undefined) {
      try {
        this.onNotification?.(msg);
      } catch {
        // listener errors must not kill the reader loop
      }
    }
  }

  async call(method, params = {}) {
    await this.start();
    const child = this.child;
    if (!child || !this.ready) throw new ZcodeProtocolError("ZCode app-server is not ready");
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ZcodeProtocolError(`ZCode RPC request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close() {
    const child = this.child;
    this.ready = false;
    this.child = undefined;
    this.rejectPending(new ZcodeProtocolError("ZCode app-server closed"));
    if (child) await this.disposeChild(child);
  }

  rejectPending(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async disposeChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("close", () => resolve()));
    try {
      child.stdin.end();
    } catch {
      // The process may already have closed stdin.
    }
    if (!child.killed) child.kill("SIGTERM");
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1500);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

export default ZcodeAppServerClient;
