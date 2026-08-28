/**
 * Connection probe for the ZCode CLI provider: spawns the local app-server
 * and verifies the full session lifecycle (create → close) with the saved
 * Coding Plan key threaded through the subprocess env.
 *
 * The probe is intentionally quota-free: the API key itself is only exercised
 * by Z.ai at turn time, so an invalid key still passes here and surfaces on
 * the first real request with the upstream error text.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { ZcodeAppServerClient } from "../shared/zcode/protocol.js";
import { resolveZcodeBin, buildZcodeRuntimeModel } from "./zcode.js";

function sanitize(message, apiKey) {
  const text = String(message || "unknown error");
  const safe = apiKey ? text.replaceAll(apiKey, "<redacted>") : text;
  return safe.slice(0, 400);
}

export async function probeZcodeConnection(apiKey, { timeoutMs = 20_000 } = {}) {
  const bin = resolveZcodeBin();
  if (bin.error) return { valid: false, error: bin.error };

  const cwd = mkdtempSync(join(tmpdir(), "9router-zcode-probe-"));
  const client = new ZcodeAppServerClient({
    command: bin.command,
    args: bin.args,
    cwd: process.env.ZCODE_CWD?.trim() || join(homedir(), ".9router", "zcode-workspace"),
    env: apiKey ? { ZHIPU_API_KEY: apiKey } : {},
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
  });

  try {
    const created = await Promise.race([
      (async () => {
        await client.start();
        return client.call("session/create", {
          workspace: { workspacePath: cwd, workspaceIdentity: cwd, workspaceKey: cwd },
          runtimeModel: buildZcodeRuntimeModel(),
        });
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
    const sessionId = created?.session?.sessionId
      || (created?.projection?.sessionId && created.projection.sessionId !== "unknown" ? created.projection.sessionId : undefined);
    if (!sessionId) return { valid: false, error: "ZCode app-server returned no sessionId" };
    await client.call("session/close", { sessionId }).catch(() => undefined);
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: `ZCode CLI probe failed: ${sanitize(error?.message, apiKey)}` };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export default probeZcodeConnection;
