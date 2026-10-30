// Local per-minute request budget: the router must skip an account whose RPM
// allowance is spent instead of collecting the provider's 429.
import { describe, it, expect, beforeEach } from "vitest";

import {
  connectionRpmLimit,
  connectionRpmPerModel,
  isRpmAvailable,
  recordRpmHit,
  rpmRetryAfterMs,
  resetRpmState,
} from "../../src/sse/services/connectionRpm.js";

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);

describe("connectionRpm", () => {
  beforeEach(() => {
    resetRpmState();
  });

  it("treats a missing or zero budget as unlimited", () => {
    expect(connectionRpmLimit({})).toBe(0);
    expect(connectionRpmLimit({ rpmLimit: 0 })).toBe(0);
    expect(connectionRpmLimit({ rpmLimit: "abc" })).toBe(0);
    expect(connectionRpmLimit({ rpmLimit: 10 })).toBe(10);
    expect(connectionRpmPerModel({})).toBe(true);
    expect(connectionRpmPerModel({ rpmPerModel: false })).toBe(false);

    const conn = { id: "c1", rpmLimit: 0 };
    for (let i = 0; i < 50; i++) expect(isRpmAvailable(conn, "m", T0)).toBe(true);
  });

  it("blocks once the per-model budget is spent and frees it after the window", () => {
    const conn = { id: "c1", rpmLimit: 2 };
    expect(isRpmAvailable(conn, "model-a", T0)).toBe(true);
    recordRpmHit(conn, "model-a", T0);
    recordRpmHit(conn, "model-a", T0 + 1_000);
    expect(isRpmAvailable(conn, "model-a", T0 + 2_000)).toBe(false);
    // A different model has its own budget (gateway free tiers meter per model).
    expect(isRpmAvailable(conn, "model-b", T0 + 2_000)).toBe(true);
    // The oldest hit leaves the window at T0 + 60s.
    expect(isRpmAvailable(conn, "model-a", T0 + 60_001)).toBe(true);
  });

  it("shares one budget across models when metering the account", () => {
    const conn = { id: "c2", rpmLimit: 1, rpmPerModel: false };
    recordRpmHit(conn, "model-a", T0);
    expect(isRpmAvailable(conn, "model-b", T0)).toBe(false);
    expect(isRpmAvailable(conn, "model-b", T0 + 60_001)).toBe(true);
  });

  it("separates accounts", () => {
    const a = { id: "a", rpmLimit: 1 };
    const b = { id: "b", rpmLimit: 1 };
    recordRpmHit(a, "m", T0);
    expect(isRpmAvailable(a, "m", T0)).toBe(false);
    expect(isRpmAvailable(b, "m", T0)).toBe(true);
  });

  it("reports the delay until the window opens", () => {
    const conn = { id: "c3", rpmLimit: 1 };
    recordRpmHit(conn, "m", T0);
    expect(rpmRetryAfterMs(conn, "m", T0)).toBe(60_000);
    expect(rpmRetryAfterMs(conn, "m", T0 + 45_000)).toBe(15_000);
    expect(rpmRetryAfterMs(conn, "m", T0 + 60_000)).toBe(0);
    // Unlimited accounts never wait.
    expect(rpmRetryAfterMs({ id: "c4", rpmLimit: 0 }, "m", T0)).toBe(0);
  });
});
