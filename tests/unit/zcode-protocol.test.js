// Unit tests for the ZCode line-JSON protocol client. Every case spawns a
// real helper process (no child_process mock — the client's stdio framing is
// only meaningful against a live stream). Slow paths live in
// zcode-protocol-integration.test.js (full turn against the fixture).
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ZcodeAppServerClient, ZcodeProtocolError } from "open-sse/shared/zcode/protocol.js";

/** Spawn a `node -e` helper as the app-server stand-in. */
function helperClient(script, env) {
  return new ZcodeAppServerClient({
    command: process.execPath,
    args: ["-e", script],
    env,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 500,
  });
}

describe("ZcodeAppServerClient error paths", () => {
  it("rejects with the server error message when an RPC fails", async () => {
    const script = [
      "let buf='';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {",
      "  const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;",
      "  const msg = JSON.parse(line);",
      "  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'Invalid params — workspace' } }) + '\\n');",
      "} });",
      "process.stdin.resume();",
    ].join("");
    const client = helperClient(script);
    try {
      await expect(client.call("session/create", {})).rejects.toThrow(/Invalid params/);
    } finally {
      await client.close();
    }
  });

  it("times out an RPC when the server never replies", async () => {
    const client = helperClient("process.stdin.resume();");
    try {
      await expect(client.call("session/read", {})).rejects.toThrow(/timed out/);
    } finally {
      await client.close();
    }
  });

  it("rejects pending calls when the server process dies", async () => {
    const client = helperClient("setTimeout(() => process.exit(1), 100); process.stdin.resume();");
    try {
      const error = await client.call("session/read", {}).catch((e) => e);
      expect(error).toBeInstanceOf(ZcodeProtocolError);
    } finally {
      await client.close();
    }
  });

  it("fails fast with a clear error when the command does not exist", async () => {
    const client = new ZcodeAppServerClient({
      command: "/nonexistent/zcode-binary-xyz",
      startupTimeoutMs: 2000,
      requestTimeoutMs: 500,
    });
    await expect(client.call("session/create", {})).rejects.toThrow(/ENOENT|ZCode app-server/);
  });

  it("passes the env through to the subprocess (API key stays in subprocess env)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-env-test-"));
    const outFile = join(dir, "env.json");
    const script = [
      `require('node:fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ key: process.env.ZHIPU_API_KEY || null }));`,
      "process.exit(0);",
    ].join("");
    const client = helperClient(script, { ZHIPU_API_KEY: "test-key-123" });
    try {
      // The helper exits immediately, so the call rejects — but the env file is written.
      await client.call("session/create", {}).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      const recorded = JSON.parse(readFileSync(outFile, "utf8"));
      expect(recorded.key).toBe("test-key-123");
    } finally {
      await client.close();
    }
  });
});

describe("ZcodeAppServerClient server-request handling", () => {
  it("answers session/requestRuntimePreferences and declines unknown server requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-sreq-test-"));
    const outFile = join(dir, "replies.json");
    // Helper sends two server requests, records client replies, exits.
    const script = [
      `const fs = require('node:fs');`,
      `const replies = {};`,
      `let buf='';`,
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {",
      "  const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;",
      "  const msg = JSON.parse(line);",
      "  if (msg.method !== undefined) continue;",
      "  if (msg.id === 9001) replies.pref = msg.result || null;",
      "  if (msg.id === 9002) replies.declined = !!(msg.error);",
      "}",
      "});",
      `process.stdout.write(JSON.stringify({ id: 9001, method: 'session/requestRuntimePreferences', params: { sessionId: 's' } }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ id: 9002, method: 'interaction/requestPermission', params: {} }) + '\\n');`,
      `setTimeout(() => { fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(replies)); process.exit(0); }, 300);`,
    ].join("");
    const client = helperClient(script);
    try {
      await client.start(); // begin reading/answering before the requests arrive
      await new Promise((r) => setTimeout(r, 700));
      const replies = JSON.parse(readFileSync(outFile, "utf8"));
      expect(replies.pref).toEqual({ nativeSearchEnhancementsEnabled: false });
      expect(replies.declined).toBe(true);
    } finally {
      await client.close();
    }
  });
});
