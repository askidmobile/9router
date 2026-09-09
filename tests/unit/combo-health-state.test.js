import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { comboHealthKey, createComboHealthRepository } from "@/lib/db/repos/comboHealthRepo.js";
import { COMBO_HEALTH_CONFIG, getComboProbeTimeoutMs, loadComboHealthConfig } from "open-sse/config/comboHealth.js";
import { GEMINI_FLEX_TIMEOUT_MS } from "open-sse/config/gemini.js";
import { createComboHealthService, sanitizeComboHealthReason } from "open-sse/services/comboHealth.js";

const pair = { provider: "clinepass", model: "cline-pass/glm-5.3-flash" };
const otherPair = { provider: "commandcode", model: "z-ai/glm-5.3-flash" };
let tempDir;
let filePath;
let adapter;
let repository;
let service;
let timestamp;
let tokenSequence;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-health-"));
  filePath = path.join(tempDir, "health.sqlite");
  adapter = await createNodeSqliteAdapter(filePath);
  adapter.exec("CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope, key))");
});

beforeEach(() => {
  adapter.run("DELETE FROM kv");
  timestamp = 1_800_000_000_000;
  tokenSequence = 0;
  repository = createComboHealthRepository(async () => adapter);
  service = createComboHealthService({ repository, now: () => timestamp, createToken: () => `probe-${++tokenSequence}` });
});

afterAll(() => {
  adapter?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function freeze(target = pair, extra = {}) {
  return service.freezeComboModel({ ...target, status: 502, reason: "Upstream request timeout", ...extra });
}

async function claim(target = pair) {
  const record = await service.getComboHealth(target.provider, target.model);
  timestamp = Math.max(timestamp, record.nextProbeAt, record.leaseUntil || 0);
  return service.claimDueComboProbe({ eligiblePairs: [target] });
}

describe("persistent Combo provider/model health", () => {
  it("freezes the exact pair and never reopens simply because cooldown elapsed", async () => {
    const record = await freeze();
    expect(record).toMatchObject({ ...pair, state: "open", failureCount: 1, openedAt: timestamp,
      lastFailureAt: timestamp, nextProbeAt: timestamp + 60_000, probeToken: null });
    expect(await service.getComboHealth(otherPair.provider, otherPair.model)).toBeNull();
    expect(await service.claimDueComboProbe()).toBeNull();
    timestamp += 24 * 60 * 60 * 1_000;
    expect(await service.getComboHealth(pair.provider, pair.model)).toMatchObject({ state: "open" });
    expect(await service.listComboHealth()).toHaveLength(1);
  });

  it("persists freezes and active leases across fresh database connections", async () => {
    await freeze();
    const active = await claim();
    const reopened = await createNodeSqliteAdapter(filePath);
    try {
      const restored = createComboHealthService({ repository: createComboHealthRepository(async () => reopened), now: () => timestamp });
      expect(await restored.getComboHealth(pair.provider, pair.model)).toEqual(active);
      expect(await restored.claimDueComboProbe()).toBeNull();
      timestamp = active.leaseUntil;
      const recovered = await restored.claimDueComboProbe();
      expect(recovered.state).toBe("probing");
      expect(recovered.probeToken).not.toBe(active.probeToken);
      expect(recovered.failureCount).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("keeps a Gemini Flex probe lease for its full fifteen-minute execution budget", async () => {
    const flexPair = { provider: "gemini", model: "gemini-3.8-flash:flex" };
    await freeze(flexPair);
    const probe = await claim(flexPair);
    expect(probe.leaseUntil - timestamp).toBe(GEMINI_FLEX_TIMEOUT_MS + COMBO_HEALTH_CONFIG.probeLeaseGraceMs);
    timestamp += 120_000;
    expect(await service.claimDueComboProbe()).toBeNull();
    expect(await service.finishComboProbe({ ...flexPair, probeToken: probe.probeToken, success: true })).toBe(true);
  });

  it("keeps the ordinary probe lease at forty-five seconds plus grace", async () => {
    await freeze();
    const probe = await claim();
    expect(probe.leaseUntil - timestamp).toBe(45_000 + COMBO_HEALTH_CONFIG.probeLeaseGraceMs);
  });

  it("preserves the full Flex probe lease when a thinking suffix follows the tier", async () => {
    const flexPair = { provider: "gemini", model: "gemini-3.8-flash:flex(high)" };
    await freeze(flexPair);
    const probe = await claim(flexPair);
    expect(probe.leaseUntil - timestamp).toBe(GEMINI_FLEX_TIMEOUT_MS + COMBO_HEALTH_CONFIG.probeLeaseGraceMs);
    timestamp += GEMINI_FLEX_TIMEOUT_MS - 1;
    expect(await service.claimDueComboProbe()).toBeNull();
    expect(await service.finishComboProbe({ ...flexPair, probeToken: probe.probeToken, success: true })).toBe(true);
  });

  it("atomically permits only one global probe across concurrent schedulers and pairs", async () => {
    await Promise.all([freeze(pair), freeze(otherPair)]);
    timestamp += 60_000;
    const secondConnection = await createNodeSqliteAdapter(filePath);
    try {
      const second = createComboHealthService({ repository: createComboHealthRepository(async () => secondConnection), now: () => timestamp });
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? second : service).claimDueComboProbe()));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await service.listComboHealth()).filter((record) => record.state === "probing")).toHaveLength(1);
    } finally {
      secondConnection.close();
    }
  });

  it("takes the SQLite write lock before transaction reads, including across processes", async () => {
    // A second process can read WAL while this transaction is open, but it must
    // not acquire a competing write claim before the callback sees any rows.
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

  it("waits 1, 2, 4, 8, 16, 30 minutes between failed recovery cycles", async () => {
    let record = await freeze();
    const waits = [record.nextProbeAt - timestamp];
    for (let attempt = 0; attempt < 6; attempt++) {
      const probe = await claim();
      expect(await service.finishComboProbe({ ...pair, probeToken: probe.probeToken, success: false, status: 504, reason: "Probe timeout" })).toBe(true);
      record = await service.getComboHealth(pair.provider, pair.model);
      waits.push(record.nextProbeAt - timestamp);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 30, 30].map((minutes) => minutes * 60_000));
    expect(record.failureCount).toBe(7);
  });

  it("respects an absolute provider Retry-After deadline up to the existing six-hour cap", async () => {
    let record = await freeze(pair, { status: 429, retryAfterMs: timestamp + 3 * 60 * 60_000 });
    expect(record.nextProbeAt).toBe(timestamp + 3 * 60 * 60_000);
    const probe = await claim();
    await service.finishComboProbe({ ...pair, probeToken: probe.probeToken, status: 429, success: false,
      retryAfterMs: timestamp + 48 * 60 * 60_000 });
    record = await service.getComboHealth(pair.provider, pair.model);
    expect(record.nextProbeAt).toBe(timestamp + 6 * 60 * 60_000);
  });

  it("ignores past or invalid Retry-After without shortening the exponential backoff", async () => {
    const record = await freeze(pair, { retryAfterMs: timestamp - 60_000 });
    expect(record.nextProbeAt).toBe(timestamp + COMBO_HEALTH_CONFIG.baseCooldownMs);
    const probe = await claim();
    await service.finishComboProbe({ ...pair, probeToken: probe.probeToken, success: false, retryAfterMs: Infinity });
    expect((await service.getComboHealth(pair.provider, pair.model)).nextProbeAt).toBe(timestamp + 120_000);
  });

  it("coalesces concurrent foreground failures instead of inflating the recovery counter", async () => {
    await Promise.all(Array.from({ length: 20 }, () => freeze()));
    const record = await service.getComboHealth(pair.provider, pair.model);
    expect(record.failureCount).toBe(1);
    expect(record.nextProbeAt).toBe(timestamp + 60_000);
  });

  it("only reopens after a matching unexpired probe succeeds; the next incident starts at one", async () => {
    await freeze();
    const probe = await claim();
    expect(await service.finishComboProbe({ ...pair, probeToken: "unknown", success: true })).toBe(false);
    expect(await service.finishComboProbe({ ...pair, probeToken: probe.probeToken, success: true })).toBe(true);
    expect(await service.getComboHealth(pair.provider, pair.model)).toBeNull();
    expect((await freeze()).failureCount).toBe(1);
    expect(await service.finishComboProbe({ ...pair, probeToken: probe.probeToken, success: true })).toBe(false);
  });

  it("rejects stale and expired success after lease recovery", async () => {
    await freeze();
    const oldProbe = await claim();
    timestamp = oldProbe.leaseUntil;
    expect(await service.finishComboProbe({ ...pair, probeToken: oldProbe.probeToken, success: true })).toBe(false);
    const newProbe = await claim();
    expect(await service.finishComboProbe({ ...pair, probeToken: oldProbe.probeToken, success: true })).toBe(false);
    expect((await service.getComboHealth(pair.provider, pair.model)).probeToken).toBe(newProbe.probeToken);
  });

  it("a late foreground failure invalidates a probe without opening another concurrent global probe", async () => {
    await freeze();
    await freeze(otherPair);
    const probe = await claim();
    timestamp += 1_000;
    const failed = await freeze();
    expect(failed).toMatchObject({ state: "open", failureCount: 1, probeToken: null, leaseUntil: probe.leaseUntil });
    expect(await service.finishComboProbe({ ...pair, probeToken: probe.probeToken, success: true })).toBe(false);
    expect(await service.claimDueComboProbe({ eligiblePairs: [otherPair] })).toBeNull();
    timestamp = probe.leaseUntil;
    expect(await service.claimDueComboProbe({ eligiblePairs: [otherPair] })).toMatchObject(otherPair);
  });

  it("scheduler cancellation releases the lease without counting a failure or erasing its cause", async () => {
    const initial = await freeze();
    const probe = await claim();
    expect(await service.finishComboProbe({ ...pair, probeToken: probe.probeToken, success: true, cancelled: true,
      status: 499, reason: "Shutdown" })).toBe(true);
    const record = await service.getComboHealth(pair.provider, pair.model);
    expect(record).toMatchObject({ state: "open", failureCount: 1, lastFailureAt: initial.lastFailureAt,
      lastStatus: initial.lastStatus, lastReason: initial.lastReason, leaseUntil: null, probeToken: null });
    expect(record.nextProbeAt).toBe(timestamp + COMBO_HEALTH_CONFIG.probeIntervalMs);
    expect(await service.claimDueComboProbe()).toBeNull();
  });

  it("only claims currently eligible exact provider/model pairs", async () => {
    await freeze();
    await freeze(otherPair);
    timestamp += 60_000;
    expect(await service.claimDueComboProbe({ eligiblePairs: [] })).toBeNull();
    expect(await service.claimDueComboProbe({ eligiblePairs: [{ ...pair, model: "other" }] })).toBeNull();
    expect(await service.claimDueComboProbe({ eligiblePairs: [otherPair] })).toMatchObject(otherPair);
    expect((await service.getComboHealth(pair.provider, pair.model)).state).toBe("open");
  });

  it("does not collide when provider or model names contain routing separators", async () => {
    expect(comboHealthKey("a/b", "c")).not.toBe(comboHealthKey("a", "b/c"));
    await freeze({ provider: "a/b", model: "c" });
    await freeze({ provider: "a", model: "b/c" });
    expect(await service.listComboHealth()).toHaveLength(2);
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
    await expect(service.claimDueComboProbe()).rejects.toThrow("Invalid persisted");
  });
});

describe("Combo health environment configuration", () => {
  it("extends only canonical Gemini Flex probe timeouts and respects normal overrides", () => {
    const config = { ...COMBO_HEALTH_CONFIG, probeTimeoutMs: 20_000 };
    expect(getComboProbeTimeoutMs("gemini", "gemini-3.8-flash:flex", config)).toBe(900_000);
    expect(getComboProbeTimeoutMs("gemini", "gemini-3.8-flash:flex(high)", config)).toBe(900_000);
    expect(getComboProbeTimeoutMs("gemini", "gemini-3.8-flash(high)", config)).toBe(20_000);
    expect(getComboProbeTimeoutMs("gemini", "gemini-3.8-flash", config)).toBe(20_000);
    expect(getComboProbeTimeoutMs("openai-compatible-chat", "custom:flex", config)).toBe(20_000);
    expect(getComboProbeTimeoutMs("gemini", undefined, config)).toBe(20_000);
  });

  it("preserves defaults and only accepts positive bounded integer overrides", () => {
    const defaults = loadComboHealthConfig({});
    expect(defaults).toMatchObject({ firstResponseTimeoutMs: 45_000, requestTimeoutMs: 120_000,
      streamIdleTimeoutMs: 45_000, probeTimeoutMs: 45_000, baseCooldownMs: 60_000,
      maxCooldownMs: 1_800_000, probeIntervalMs: 5_000, probeLeaseGraceMs: 5_000,
      probeMaxTokens: 1_024, maxBufferedBytes: 1_048_576, probePrompt: "Reply with exactly OK." });
    for (const invalid of ["0", "-1", "1.5", "Infinity", "60seconds", "", " "]) {
      expect(loadComboHealthConfig({ COMBO_FIRST_RESPONSE_TIMEOUT_MS: invalid }).firstResponseTimeoutMs).toBe(defaults.firstResponseTimeoutMs);
    }
    expect(loadComboHealthConfig({ COMBO_FIRST_RESPONSE_TIMEOUT_MS: "1234" }).firstResponseTimeoutMs).toBe(1_234);
    expect(loadComboHealthConfig({ COMBO_FIRST_RESPONSE_TIMEOUT_MS: "999999999" }).firstResponseTimeoutMs).toBe(6 * 60 * 60_000);
    expect(loadComboHealthConfig({ COMBO_PROBE_MAX_TOKENS: "99999" }).probeMaxTokens).toBe(4_096);
    expect(loadComboHealthConfig({ COMBO_BASE_COOLDOWN_MS: "5000", COMBO_MAX_COOLDOWN_MS: "1000" }).maxCooldownMs).toBe(5_000);
  });
});
