// Unit tests for ZcodeExecutor. Uses the fake app-server fixture through
// ZCODE_BIN so the full spawn→turn→close path runs for real (no protocol mock).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ZcodeExecutor, buildZcodePrompt, resolveZcodeModel, resolveZcodeBin, extractAssistantText } from "open-sse/executors/zcode.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "../fixtures/fake-zcode-app-server.mjs");

const ORIG_ENV = { ...process.env };

function withEnv(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("buildZcodePrompt", () => {
  it("flattens a conversation with role labels", () => {
    const prompt = buildZcodePrompt([
      { role: "system", content: "be terse" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "bye" },
    ]);
    expect(prompt).toBe("[System]\nbe terse\n\n[User]\nhello\n\n[Assistant]\nhi there\n\n[User]\nbye");
  });

  it("drops empty messages", () => {
    expect(buildZcodePrompt([{ role: "user", content: "" }, { role: "user", content: [] }])).toBe("");
  });
});

describe("resolveZcodeModel", () => {
  it("accepts bare, zcode/- and zc/-prefixed catalog ids", () => {
    expect(resolveZcodeModel("glm-5.3-flash").model).toBe("glm-5.3-flash");
    expect(resolveZcodeModel("zcode/glm-5.3").model).toBe("glm-5.3");
    expect(resolveZcodeModel("zc/glm-5.2").model).toBe("glm-5.2");
    expect(resolveZcodeModel("").model).toBe("glm-5.3"); // catalog default
  });

  it("rejects unknown and effort-alias models with the catalog list", () => {
    const bad = resolveZcodeModel("glm-5.2-max");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Supported models:");
  });
});

describe("resolveZcodeBin", () => {
  it("prefers ZCODE_BIN and wraps .cjs entries with node", () => {
    const bin = resolveZcodeBin({ ZCODE_BIN: "/opt/x/zcode.cjs" });
    expect(bin.command).toBe(process.execPath);
    expect(bin.args[0]).toBe("/opt/x/zcode.cjs");
  });

  it("uses ZCODE_ARGS verbatim for binary entries", () => {
    const bin = resolveZcodeBin({ ZCODE_BIN: "/usr/bin/zcode", ZCODE_ARGS: '["app-server","--debug"]' });
    expect(bin.command).toBe("/usr/bin/zcode");
    expect(bin.args).toEqual(["app-server", "--debug"]);
  });

  it("falls back to the macOS app bundle entry", () => {
    const bin = resolveZcodeBin({});
    if (process.platform === "darwin") {
      expect(bin.command).toBe(process.execPath);
      expect(bin.args).toEqual(["/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", "app-server"]);
    } else {
      expect(bin.error).toContain("ZCode CLI not found");
    }
  });
});

describe("extractAssistantText", () => {
  it("skips timeline events and returns the last real assistant text", () => {
    const text = extractAssistantText({
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
        { info: { role: "assistant", semantics: { kind: "timeline_event" } }, parts: [{ type: "timeline" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "answer" }] },
      ],
    });
    expect(text).toBe("answer");
  });
});

describe("ZcodeExecutor.execute", () => {
  let executor;
  beforeEach(() => {
    executor = new ZcodeExecutor();
    withEnv({ ZCODE_BIN: fixture, ZCODE_ARGS: undefined, ZCODE_MAX_CONCURRENT: undefined, ZCODE_CWD: undefined });
  });
  afterEach(() => {
    withEnv(ORIG_ENV);
  });

  it("returns a synthetic SSE stream for stream=true", async () => {
    const { response } = await executor.execute({
      model: "zc/glm-5.3-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "test-key" },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"role":"assistant"');
    expect(body).toContain("fake zcode response");
    expect(body).toContain('"finish_reason":"stop"');
    expect(body.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("returns a completion JSON with estimated usage for non-stream", async () => {
    const { response } = await executor.execute({
      model: "glm-5.3-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "test-key" },
    });
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("fake zcode response");
    expect(json.usage.estimated).toBe(true);
    expect(json.usage.total_tokens).toBeGreaterThan(0);
  });

  it("returns 400 for unknown models without spawning anything", async () => {
    const { response } = await executor.execute({
      model: "glm-nope",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "k" },
    });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.message).toContain("Supported models");
  });

  it("returns 400 for an empty conversation without spawning anything", async () => {
    const { response } = await executor.execute({
      model: "glm-5.3",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "k" },
    });
    expect(response.status).toBe(400);
  });

  it("returns 401 when the connection has no API key", async () => {
    const { response } = await executor.execute({
      model: "glm-5.3",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
    });
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.message).toContain("Coding Plan API key");
  });

  it("maps upstream turn failures to a 502 with sanitized message", async () => {
    // Helper errors on session/create; the executor must surface a 502.
    const dir = mkdtempSync(join(tmpdir(), "zcode-exec-err-"));
    const helper = join(dir, "helper.mjs");
    writeFileSync(helper, "process.stdin.resume(); process.stdin.on('data', () => {\n" +
      "  process.stdout.write(JSON.stringify({ id: 1, error: { code: -32603, message: 'boom upstream' } }) + '\\n');\n" +
      "});\n");
    withEnv({ ZCODE_BIN: helper, ZCODE_ARGS: JSON.stringify([]) });
    const { response } = await executor.execute({
      model: "glm-5.3",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "supersecret" },
    });
    expect(response.status).toBe(502);
    const json = await response.json();
    expect(json.error.message).toContain("boom upstream");
    expect(json.error.message).not.toContain("supersecret");
  });

  it("enforces the concurrency cap with 429", async () => {
    withEnv({ ZCODE_MAX_CONCURRENT: "1" });
    // The helper blocks forever, so the first turn holds the only slot.
    const dir = mkdtempSync(join(tmpdir(), "zcode-exec-cap-"));
    const helper = join(dir, "helper.mjs");
    writeFileSync(helper, "setTimeout(() => process.exit(0), 5000); process.stdin.resume();\n");
    withEnv({ ZCODE_BIN: helper, ZCODE_ARGS: JSON.stringify([]), ZCODE_TURN_TIMEOUT_MS: "1200", ZCODE_RPC_TIMEOUT_MS: "200" });

    const first = executor.execute({
      model: "glm-5.3",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "k" },
    });
    const second = await executor.execute({
      model: "glm-5.3",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "k" },
    });
    expect(second.response.status).toBe(429);
    await first; // let the first turn settle so activeTurns drains
  });

  it("builds no auth headers — the key travels via subprocess env only", () => {
    const executor2 = new ZcodeExecutor();
    expect(executor2.buildHeaders({ apiKey: "whatever" })).toEqual({});
  });
});

describe("ZcodeExecutor turn timeout", () => {
  it("aborts a hung turn after ZCODE_TURN_TIMEOUT_MS with a 502", async () => {
    const executor = new ZcodeExecutor();
    const dir = mkdtempSync(join(tmpdir(), "zcode-exec-hang-"));
    const helper = join(dir, "helper.mjs");
    writeFileSync(helper, "setTimeout(() => process.exit(0), 30000); process.stdin.resume();\n");
    const orig = { ...process.env };
    withEnv({ ZCODE_BIN: helper, ZCODE_ARGS: JSON.stringify([]), ZCODE_TURN_TIMEOUT_MS: "700", ZCODE_POLL_INTERVAL_MS: "120", ZCODE_RPC_TIMEOUT_MS: "200" });
    try {
      const { response } = await executor.execute({
        model: "glm-5.3",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "k" },
      });
      expect(response.status).toBe(502);
      const json = await response.json();
      expect(json.error.message).toContain("timed out");
    } finally {
      withEnv(orig);
    }
  }, 15000);
});
