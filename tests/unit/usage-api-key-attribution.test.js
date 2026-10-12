import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-api-key-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  delete process.env.DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Usage stats API key attribution", () => {
  it("keeps the model breakdown for requests without a key consistent across periods", async () => {
    for (const model of ["gpt-4", "gpt-5"]) {
      await db.saveRequestUsage({ provider: "openai", model, tokens: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    for (const period of ["24h", "today", "7d", "all"]) {
      const entries = Object.values((await db.getUsageStats(period)).byApiKey);
      expect(entries.map(entry => entry.rawModel).sort()).toEqual(["gpt-4", "gpt-5"]);
      expect(new Set(entries.map(entry => entry.apiKeyKey)).size).toBe(1);
    }
  });

  it("keeps colliding masked keys separate without exposing secrets in every period", async () => {
    const apiKeyA = "sk-machine-aaaaaa-11111111";
    const apiKeyB = "sk-machine-bbbbbb-11111111";

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyA,
      tokens: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01, cost_details: { source: "provider" } },
      endpoint: "/v1/chat",
      status: "ok",
    });

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyB,
      tokens: { prompt_tokens: 20, completion_tokens: 10, cost: 0.02, cost_details: { source: "provider" } },
      endpoint: "/v1/chat",
      status: "ok",
    });

    await db.saveRequestUsage({
      provider: "openai", model: "gpt-5", connectionId: "c1", apiKey: apiKeyA,
      tokens: { prompt_tokens: 30, completion_tokens: 15, cost: 0.03, cost_details: { source: "provider" } },
    });

    for (const period of ["24h", "today", "7d", "all"]) {
      const stats = await db.getUsageStats(period);
      const apiKeyEntries = Object.values(stats.byApiKey);

      expect(apiKeyEntries).toHaveLength(3);
      expect(JSON.stringify(stats)).not.toContain(apiKeyA);
      expect(JSON.stringify(stats)).not.toContain(apiKeyB);
      expect(new Set(apiKeyEntries.map(entry => entry.apiKeyMasked)).size).toBe(1);
      expect(new Set(apiKeyEntries.map(entry => entry.apiKeyKey)).size).toBe(2);
      const groups = Object.groupBy(apiKeyEntries, entry => entry.apiKeyKey);
      expect(Object.values(groups).map(entries => entries.reduce((sum, entry) => sum + entry.cost, 0)))
        .toEqual(expect.arrayContaining([0.02, 0.04]));
      expect(apiKeyEntries.map(entry => entry.promptTokens).sort((a, b) => a - b)).toEqual([10, 20, 30]);
    }
  });
});
