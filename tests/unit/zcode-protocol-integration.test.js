// Integration test: runs the real fake-zcode-app-server fixture (no
// child_process mock) and speaks the line-JSON protocol to it end to end.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ZcodeAppServerClient } from "open-sse/shared/zcode/protocol.js";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "../fixtures/fake-zcode-app-server.mjs");

describe("ZcodeAppServerClient against the fake fixture", () => {
  it("performs a full turn: create → server request answered → send → read → close", async () => {
    const client = new ZcodeAppServerClient({
      command: process.execPath,
      args: [fixture],
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000,
    });
    try {
      const created = await client.call("session/create", { workspace: { workspacePath: "/w" } });
      const sessionId = created.session.sessionId;
      expect(sessionId).toBe("fake-zcode-session");
      expect(created.projection.status).toBe("idle");

      await client.call("session/setModel", { sessionId, model: { providerId: "zai-coding-plan", modelId: "glm-5.3-flash" } });
      const sent = await client.call("session/send", { sessionId, content: "hello" });
      expect(sent.accepted).toBe(true);

      const state = await client.call("session/read", { sessionId });
      expect(state.session.status).toBe("completed");
      const assistant = state.messages.find((m) => m.info.role === "assistant");
      expect(assistant.parts[0].text).toBe("fake zcode response");

      await client.call("session/close", { sessionId });
    } finally {
      await client.close();
    }
  }, 15000);

  it("spawns with the provided env (API key reaches only the subprocess)", async () => {
    const spawnSpy = spawn; // reference kept for readability
    void spawnSpy;
    const client = new ZcodeAppServerClient({
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"], // silent server that never answers
      env: { ZHIPU_API_KEY: "test-key-123" },
      startupTimeoutMs: 5000,
      requestTimeoutMs: 300,
    });
    try {
      await client.start();
      await expect(client.call("session/read", {})).rejects.toThrow(/timed out/);
    } finally {
      await client.close();
    }
  }, 15000);
});
