import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const original = process.env.DATA_DIR;
let dir;
let health;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-model-health-"));
  process.env.DATA_DIR = dir;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  health = await import("@/lib/db/repos/modelHealthRepo.js");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = original;
});

beforeEach(() => {
  health.__test__.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T10:05:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyOutcome", () => {
  it.each([
    [200, "ok"],
    [201, "ok"],
    [401, "e401"],
    [402, "e402"],
    [403, "e403"],
    [404, "e404"],
    [408, "e408"],
    [429, "e429"],
    [500, "e5xx"],
    [503, "e5xx"],
    [400, "err"],
  ])("maps %i to %s", (status, expected) => {
    expect(health.classifyOutcome(status)).toBe(expected);
  });

  it("does not blame the provider for a client cancel or a deadline", () => {
    expect(health.classifyOutcome(499)).toBe("client");
    expect(health.classifyOutcome(504, { timeout: true })).toBe("timeout");
  });
});

describe("recordModelOutcome", () => {
  it("counts successes and failures in the same hour bucket", () => {
    health.recordModelOutcome({ provider: "p", model: "m", status: 200, latencyMs: 100 });
    health.recordModelOutcome({ provider: "p", model: "m", status: 200, latencyMs: 300 });
    health.recordModelOutcome({ provider: "p", model: "m", status: 429, error: "slow down" });

    const snapshot = health.__test__.snapshot();
    const counters = snapshot["p|m"].buckets["2026-11-06T10"];
    expect(counters.ok).toBe(2);
    expect(counters.e429).toBe(1);
    expect(counters.err).toBe(1);
    expect(counters.latSum).toBe(400);
    expect(counters.latCount).toBe(2);
    expect(counters.lastError).toBe("slow down");
  });

  it("does not count a client cancel as an error", () => {
    health.recordModelOutcome({ provider: "p", model: "m", status: 499, cancelled: true });

    const counters = health.__test__.snapshot()["p|m"].buckets["2026-11-06T10"];
    expect(counters.client).toBe(1);
    expect(counters.err).toBe(0);
  });

  it("separates hours", () => {
    health.recordModelOutcome({ provider: "p", model: "m", status: 200 });
    vi.setSystemTime(new Date("2026-11-06T11:05:00.000Z"));
    health.recordModelOutcome({ provider: "p", model: "m", status: 500 });

    const buckets = health.__test__.snapshot()["p|m"].buckets;
    expect(Object.keys(buckets)).toEqual(["2026-11-06T10", "2026-11-06T11"]);
    expect(buckets["2026-11-06T10"].ok).toBe(1);
    expect(buckets["2026-11-06T11"].e5xx).toBe(1);
  });

  it("ignores outcomes without a provider or model", () => {
    health.recordModelOutcome({ provider: "", model: "m", status: 200 });
    health.recordModelOutcome({ provider: "p", status: 200 });
    expect(health.__test__.bufferSize()).toBe(0);
  });
});

describe("summarizeHealth", () => {
  const now = new Date("2026-11-06T12:00:00.000Z").getTime();

  it("computes an error rate and average latency over the window", () => {
    const summary = health.summarizeHealth(
      {
        buckets: {
          "2026-11-06T09": { ok: 3, err: 1, e429: 1, latSum: 600, latCount: 4 },
          "2026-11-03T09": { ok: 100, err: 0, latSum: 0, latCount: 0 },
        },
      },
      { hours: 24, now },
    );

    expect(summary.requests).toBe(4);
    expect(summary.ok).toBe(3);
    expect(summary.err).toBe(1);
    expect(summary.errorRate).toBe(0.25);
    expect(summary.rateLimited).toBe(1);
    expect(summary.avgLatency).toBe(150);
  });

  it("excludes buckets older than the window", () => {
    const summary = health.summarizeHealth(
      {
        buckets: {
          "2026-11-01T09": { ok: 5, err: 5, e5xx: 5, latSum: 0, latCount: 0 },
          "2026-11-06T09": { ok: 1, err: 0, latSum: 10, latCount: 1 },
        },
      },
      { hours: 24, now },
    );

    expect(summary.requests).toBe(1);
    expect(summary.errorRate).toBe(0);
  });

  it("returns null error rate when there is no traffic", () => {
    const summary = health.summarizeHealth({ buckets: {} }, { now });
    expect(summary.requests).toBe(0);
    expect(summary.errorRate).toBeNull();
  });

  it("reports the newest error across buckets", () => {
    const summary = health.summarizeHealth(
      {
        buckets: {
          "2026-11-06T09": { err: 1, lastError: "old", lastErrorAt: "2026-11-06T09:30:00.000Z" },
          "2026-11-06T11": { err: 1, lastError: "new", lastErrorAt: "2026-11-06T11:30:00.000Z" },
        },
      },
      { now },
    );

    expect(summary.lastError).toBe("new");
    expect(summary.lastErrorAt).toBe("2026-11-06T11:30:00.000Z");
  });
});

describe("retention", () => {
  it("prunes buckets older than seven days and drops empty models", () => {
    const now = new Date("2026-11-06T12:00:00.000Z").getTime();
    const pruned = health.__test__.pruneBuckets(
      {
        "2026-10-01T00": { ok: 1 },
        "2026-11-06T11": { ok: 1 },
      },
      now,
    );

    expect(Object.keys(pruned)).toEqual(["2026-11-06T11"]);
    expect(health.__test__.pruneBuckets({ "2026-10-01T00": { ok: 1 } }, now)).toEqual({});
  });

  it("persists counters to the database on flush", async () => {
    health.recordModelOutcome({ provider: "flushp", model: "fm", status: 200 });
    health.recordModelOutcome({ provider: "flushp", model: "fm", status: 502 });

    await health.flushToDatabase();
    const stored = await health.getModelHealth();

    expect(stored.flushp.fm.buckets["2026-11-06T10"].ok).toBe(1);
    expect(stored.flushp.fm.buckets["2026-11-06T10"].e5xx).toBe(1);
    expect(health.__test__.bufferSize()).toBe(0);
  });
});