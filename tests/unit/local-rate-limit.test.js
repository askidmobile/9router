// Local per-minute budgets: the router must skip an account whose request or
// token allowance is spent instead of collecting the provider's 429.
import { describe, it, expect, beforeEach } from "vitest";

import {
  connectionRpmLimit,
  connectionTpmLimit,
  connectionRpmPerModel,
  isRateAvailable,
  recordRequestHit,
  recordTokenUsage,
  rateRetryAfterMs,
  resetRateLimitState,
} from "../../open-sse/services/localRateLimit.js";

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);

describe("localRateLimit", () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it("treats a missing or zero budget as unlimited", () => {
    expect(connectionRpmLimit({})).toBe(0);
    expect(connectionRpmLimit({ rpmLimit: 0 })).toBe(0);
    expect(connectionRpmLimit({ rpmLimit: "abc" })).toBe(0);
    expect(connectionRpmLimit({ rpmLimit: 10 })).toBe(10);
    expect(connectionTpmLimit({})).toBe(0);
    expect(connectionTpmLimit({ tpmLimit: 1000 })).toBe(1000);
    expect(connectionRpmPerModel({})).toBe(true);
    expect(connectionRpmPerModel({ rpmPerModel: false })).toBe(false);

    const conn = { id: "c1", rpmLimit: 0, tpmLimit: 0 };
    for (let i = 0; i < 50; i++) expect(isRateAvailable(conn, "m", T0)).toBe(true);
  });

  it("blocks once the per-model request budget is spent and frees it after the window", () => {
    const conn = { id: "c1", rpmLimit: 2 };
    expect(isRateAvailable(conn, "model-a", T0)).toBe(true);
    recordRequestHit(conn, "model-a", T0);
    recordRequestHit(conn, "model-a", T0 + 1_000);
    expect(isRateAvailable(conn, "model-a", T0 + 2_000)).toBe(false);
    // A different model has its own budget (gateway free tiers meter per model).
    expect(isRateAvailable(conn, "model-b", T0 + 2_000)).toBe(true);
    // The oldest hit leaves the window at T0 + 60s.
    expect(isRateAvailable(conn, "model-a", T0 + 60_001)).toBe(true);
  });

  it("shares one request budget across models when metering the account", () => {
    const conn = { id: "c2", rpmLimit: 1, rpmPerModel: false };
    recordRequestHit(conn, "model-a", T0);
    expect(isRateAvailable(conn, "model-b", T0)).toBe(false);
    expect(isRateAvailable(conn, "model-b", T0 + 60_001)).toBe(true);
  });

  it("separates accounts", () => {
    const a = { id: "a", rpmLimit: 1 };
    const b = { id: "b", rpmLimit: 1 };
    recordRequestHit(a, "m", T0);
    expect(isRateAvailable(a, "m", T0)).toBe(false);
    expect(isRateAvailable(b, "m", T0)).toBe(true);
  });

  it("blocks on settled tokens and frees them after the window", () => {
    const conn = { id: "c5", tpmLimit: 1_000 };
    expect(isRateAvailable(conn, null, T0)).toBe(true);
    recordTokenUsage("c5", 600, T0);
    expect(isRateAvailable(conn, null, T0)).toBe(true);
    recordTokenUsage("c5", 500, T0 + 5_000);
    expect(isRateAvailable(conn, null, T0 + 6_000)).toBe(false);
    // The first 600 tokens expire a minute after they were counted.
    expect(isRateAvailable(conn, null, T0 + 60_001)).toBe(true);
  });

  it("ignores token hits for connections without a token budget", () => {
    const conn = { id: "c6", rpmLimit: 5 };
    recordTokenUsage("c6", 10_000_000, T0);
    expect(isRateAvailable(conn, null, T0)).toBe(true);
  });

  it("reports the delay until the window opens", () => {
    const rpmConn = { id: "c3", rpmLimit: 1 };
    recordRequestHit(rpmConn, "m", T0);
    expect(rateRetryAfterMs(rpmConn, "m", T0)).toBe(60_000);
    expect(rateRetryAfterMs(rpmConn, "m", T0 + 45_000)).toBe(15_000);
    expect(rateRetryAfterMs(rpmConn, "m", T0 + 60_000)).toBe(0);
    // Unlimited accounts never wait.
    expect(rateRetryAfterMs({ id: "c4", rpmLimit: 0 }, "m", T0)).toBe(0);

    // Token budget: the wait lasts until enough tokens age out.
    const tpmConn = { id: "c7", tpmLimit: 100 };
    recordTokenUsage("c7", 60, T0);
    recordTokenUsage("c7", 60, T0 + 10_000);
    expect(rateRetryAfterMs(tpmConn, null, T0 + 20_000)).toBe(40_000);
    // Once the first 60 age out the budget admits again — nothing to wait for.
    expect(rateRetryAfterMs(tpmConn, null, T0 + 60_001)).toBe(0);
  });
});
