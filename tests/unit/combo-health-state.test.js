import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { comboHealthKey, createComboHealthRepository } from "@/lib/db/repos/comboHealthRepo.js";
import { COMBO_HEALTH_CONFIG, loadComboHealthConfig } from "open-sse/config/comboHealth.js";
import { createComboHealthService, sanitizeComboHealthReason } from "open-sse/services/comboHealth.js";

const pair = { provider: "clinepass", model: "cline-pass/glm-5.3-flash" };
const otherPair = { provider: "commandcode", model: "z-ai/glm-5.3-flash" };
let tempDir;
let filePath;
let adapter;
let repository;
let service;
let timestamp;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-health-"));
  filePath = path.join(tempDir, "health.sqlite");
  adapter = await createNodeSqliteAdapter(filePath);
  adapter.exec("CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope, key))");
});

beforeEach(() => {
  adapter.run("DELETE FROM kv");
  timestamp = 1_800_000_000_000;
  repository = createComboHealthRepository(async () => adapter);
  service = createComboHealthService({ repository, now: () => timestamp });
});

afterAll(() => {
  adapter?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function freeze(target = pair, extra = {}) {
  return service.freezeComboModel({ ...target, status: 502, reason: "Upstream request timeout", ...extra });
}

describe("persistent Combo provider/model health", () => {
  it("freezes the exact pair until its cooldown ends", async () => {
    const record = await freeze();
    expect(record).toMatchObject({ ...pair, state: "open", failureCount: 1, openedAt: timestamp,
      lastFailureAt: timestamp, nextProbeAt: timestamp + 10_000 });
    expect(await service.getComboHealth(otherPair.provider, otherPair.model)).toBeNull();
    expect(await service.listComboHealth()).toHaveLength(1);
    timestamp += 9_999;
    expect((await service.getComboHealth(pair.provider, pair.model)).nextProbeAt).toBeGreaterThan(timestamp);
  });

  it("persists freezes across fresh database connections", async () => {
    await freeze();
    const reopened = await createNodeSqliteAdapter(filePath);
    try {
      const restored = createComboHealthService({ repository: createComboHealthRepository(async () => reopened), now: () => timestamp });
      expect(await restored.getComboHealth(pair.provider, pair.model)).toMatchObject({ state: "open", failureCount: 1 });
    } finally {
      reopened.close();
    }
  });

  it("escalates the cooldown X, 2X, 3X... on consecutive incidents and caps it", async () => {
    let record = await freeze();
    const waits = [record.nextProbeAt - timestamp];
    for (let attempt = 0; attempt < 4; attempt++) {
      timestamp = record.nextProbeAt; // the cooldown expired; the next real request is the retry
      record = await freeze();
      waits.push(record.nextProbeAt - timestamp);
    }
    expect(waits).toEqual([10, 20, 30, 40, 50].map((seconds) => seconds * 1000));
    expect(record.failureCount).toBe(5);

    const huge = { ...COMBO_HEALTH_CONFIG, maxCooldownMs: 60_000 };
    const capped = createComboHealthService({ repository, now: () => timestamp, config: huge });
    timestamp += 60_000;
    expect((await capped.freezeComboModel({ ...pair, status: 502, reason: "x" })).nextProbeAt).toBe(timestamp + 60_000);
  });

  it("coalesces concurrent failures of one incident instead of inflating the counter", async () => {
    await Promise.all(Array.from({ length: 20 }, () => freeze()));
    const record = await service.getComboHealth(pair.provider, pair.model);
    expect(record.failureCount).toBe(1);
    expect(record.nextProbeAt).toBe(timestamp + 10_000);
  });

  it("respects an absolute provider Retry-After deadline up to the six-hour cap", async () => {
    const record = await freeze(pair, { status: 429, retryAfterMs: timestamp + 3 * 60 * 60_000 });
    expect(record.nextProbeAt).toBe(timestamp + 3 * 60 * 60_000);
    timestamp = record.nextProbeAt;
    const next = await freeze(pair, { status: 429, retryAfterMs: timestamp + 48 * 60 * 60_000 });
    expect(next.nextProbeAt).toBe(timestamp + 6 * 60 * 60_000);
  });

  it("ignores past or invalid Retry-After without shortening the escalation", async () => {
    const record = await freeze(pair, { retryAfterMs: timestamp - 60_000 });
    expect(record.nextProbeAt).toBe(timestamp + COMBO_HEALTH_CONFIG.baseCooldownMs);
    timestamp = record.nextProbeAt;
    expect((await freeze(pair, { retryAfterMs: Infinity })).nextProbeAt).toBe(timestamp + 20_000);
  });

  it("forgets the pair on a positive completion; the next incident starts at one", async () => {
    await freeze();
    expect(await service.clearComboModel(pair)).toBe(true);
    expect(await service.getComboHealth(pair.provider, pair.model)).toBeNull();
    expect(await service.listComboHealth()).toEqual([]);
    expect((await freeze()).failureCount).toBe(1);
  });

  it("does not collide when provider or model names contain routing separators", async () => {
    expect(comboHealthKey("a/b", "c")).not.toBe(comboHealthKey("a", "b/c"));
    await freeze({ provider: "a/b", model: "c" });
    await freeze({ provider: "a", model: "b/c" });
    expect(await service.listComboHealth()).toHaveLength(2);
  });

  it("takes the SQLite write lock before transaction reads, including across processes", async () => {
    await repository.transaction((tx) => {
      expect(tx.list()).toEqual([]);
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA busy_timeout = 20');
        try {
          db.exec('BEGIN');
          db.prepare('UPDATE kv SET value = value WHERE scope = ? AND key = ?').run('comboModelHealth', '__transaction_lock__');
          process.stdout.write('unlocked');
        } catch (error) { process.stdout.write(/locked|busy/i.test(error.message) ? 'locked' : 'unexpected'); }
        finally { db.close(); }
      `, filePath], { encoding: "utf8", timeout: 5_000 });
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("locked");
    });
  });

  it("rejects asynchronous transaction callbacks and rolls back their early writes", async () => {
    await expect(repository.transaction(async (tx) => {
      tx.set({ ...pair, state: "open" });
    })).rejects.toThrow("must be synchronous");
    expect(await repository.list()).toEqual([]);
  });

  it("bounds and removes recognizable credentials from persisted errors", async () => {
    const reason = 'fetch timeout Bearer token-secret api_key="key-secret" access_token=access-secret '
      + 'refreshToken=refresh-secret https://user:password@example.test/v1?token=url-secret test@example.com\n'
      + 'sk-other-secret ' + 'x'.repeat(500);
    const record = await freeze(pair, { reason, status: 999 });
    expect(record.lastReason.length).toBeLessThanOrEqual(240);
    for (const secret of ["token-secret", "key-secret", "access-secret", "refresh-secret", "url-secret", "test@example.com", "other-secret"]) {
      expect(record.lastReason).not.toContain(secret);
    }
    expect(record.lastReason).not.toContain("\n");
    expect(record.lastStatus).toBeNull();
    expect(sanitizeComboHealthReason({ accessToken: "private" })).toBe("");
  });

  it("fails closed for corrupt persisted records instead of silently reopening them", async () => {
    adapter.run("INSERT INTO kv(scope,key,value) VALUES(?,?,?)", ["comboModelHealth", comboHealthKey(pair.provider, pair.model), "bad json"]);
    await expect(service.getComboHealth(pair.provider, pair.model)).rejects.toThrow("Invalid persisted");
    await expect(service.listComboHealth()).rejects.toThrow("Invalid persisted");
  });
});

describe("Combo health environment configuration", () => {
  it("preserves defaults and only accepts positive bounded integer overrides", () => {
    const defaults = loadComboHealthConfig({});
    expect(defaults).toMatchObject({ firstResponseTimeoutMs: 45_000, requestTimeoutMs: 120_000,
      streamIdleTimeoutMs: 45_000, baseCooldownMs: 10_000,
      maxCooldownMs: 1_800_000, maxBufferedBytes: 1_048_576 });
    for (const invalid of ["0", "-1", "1.5", "Infinity", "60seconds", "", " "]) {
      expect(loadComboHealthConfig({ COMBO_FIRST_RESPONSE_TIMEOUT_MS: invalid }).firstResponseTimeoutMs).toBe(defaults.firstResponseTimeoutMs);
    }
    expect(loadComboHealthConfig({ COMBO_FIRST_RESPONSE_TIMEOUT_MS: "1234" }).firstResponseTimeoutMs).toBe(1_234);
    expect(loadComboHealthConfig({ COMBO_FIRST_RESPONSE_TIMEOUT_MS: "999999999" }).firstResponseTimeoutMs).toBe(6 * 60 * 60_000);
    expect(loadComboHealthConfig({ COMBO_BASE_COOLDOWN_MS: "5000", COMBO_MAX_COOLDOWN_MS: "1000" }).maxCooldownMs).toBe(5_000);
  });
});
