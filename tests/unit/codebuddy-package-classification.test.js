// CodeBuddy classifies each credit package as either a refill allowance or a
// one-shot bonus grant. The original test compared CycleEndTime against
// DeductionEndTime with a 2-day tolerance, but on the live payload both are the
// SAME instant (DeductionEndTime is CycleEndTime rendered as epoch ms, the -5h
// gap is just a timezone shift), so every package was classified as a bonus and
// a monthly plan surfaced under the title "Bonus Pack".
//
// The classification now keys off the package itself: Tencent names bonus
// grants `*_bonus_pack` / `*_bonus`.
//
// The usage handler reaches the network through proxyAwareFetch, which captures
// globalThis.fetch at import time — so the stub has to be installed with
// vi.stubGlobal BEFORE the module is imported (hence the dynamic import).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Trimmed but structurally faithful copy of a live
// /v2/billing/meter/get-user-resource response (personal Pro account).
const LIVE_PAYLOAD = {
  code: 0,
  msg: "OK",
  data: {
    Response: {
      Data: {
        TotalCount: 3,
        TotalDosage: 2350,
        Accounts: [
          {
            PackageName: "Bonus Pack",
            SubProductCode: "sp_tcaca_codebuddyide_bonus_pack",
            CapacityUsed: 0,
            CapacityRemain: 250,
            CapacitySize: 250,
            CycleCapacitySize: 250,
            CycleCapacityRemain: 250,
            CycleStartTime: "2026-10-30 05:36:41",
            CycleEndTime: "2026-11-13 05:36:40",
            DeductionEndTime: 1794519400000,
          },
          {
            PackageName: "Pro Plan Monthly Subscription",
            SubProductCode: "sp_tcaca_codebuddy_ide",
            CapacityUsed: 0,
            CapacityRemain: 1000,
            CapacitySize: 1000,
            CycleCapacitySize: 1000,
            CycleCapacityRemain: 1000,
            CycleStartTime: "2026-10-30 05:41:37",
            CycleEndTime: "2026-11-30 05:41:36",
            DeductionEndTime: 1795983696000,
          },
          {
            PackageName: "Plan Bonus Quota",
            SubProductCode: "sp_tcaca_codebuddy_subscribe_bonus",
            CapacityUsed: 0,
            CapacityRemain: 1000,
            CapacitySize: 1000,
            CycleCapacitySize: 1000,
            CycleCapacityRemain: 1000,
            CycleStartTime: "2026-10-30 05:41:37",
            CycleEndTime: "2026-11-30 05:41:36",
            DeductionEndTime: 1795983696000,
          },
        ],
      },
    },
  },
};

let getCodeBuddyIntlUsage;

beforeEach(async () => {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => LIVE_PAYLOAD,
    text: async () => JSON.stringify(LIVE_PAYLOAD),
  }));
  // Re-import with the stub already in place so proxyFetch captures it.
  vi.resetModules();
  ({ getCodeBuddyIntlUsage } = await import("../../open-sse/services/usage/codebuddy-cn.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CodeBuddy credit package classification", () => {
  it("treats the subscription plan as a recurring refill, not a bonus pack", async () => {
    const usage = await getCodeBuddyIntlUsage(undefined, "ck-test-key", {});
    expect(usage.plan).toBe("Pro Plan Monthly Subscription");
    expect(usage.quotas["Pro Plan Monthly Subscription"]).toMatchObject({
      recurring: true,
      total: 1000,
      used: 0,
    });
  });

  it("keeps bonus grants non-recurring and labels them by the upstream name", async () => {
    const usage = await getCodeBuddyIntlUsage(undefined, "ck-test-key", {});
    expect(usage.quotas["Bonus Pack"]).toMatchObject({ recurring: false, total: 250 });
    expect(usage.quotas["Plan Bonus Quota"]).toMatchObject({ recurring: false, total: 1000 });
  });

  it("keeps every package visible so the balance is auditable", async () => {
    const usage = await getCodeBuddyIntlUsage(undefined, "ck-test-key", {});
    const total = Object.values(usage.quotas).reduce((sum, q) => sum + q.total, 0);
    // 250 + 1000 + 1000 — the full purchased balance.
    expect(total).toBe(2250);
  });
});
