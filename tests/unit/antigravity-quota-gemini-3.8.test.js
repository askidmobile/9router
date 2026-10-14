import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
    : {
        models: {
          ...Object.fromEntries(["gemini-4-argon", "gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"].map(id => [id, {
            displayName: id, quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-15T12:00:00Z" },
          }])),
          "gemini-3.8-flash-high": {
            displayName: "Gemini 3.8 Flash (High)",
            quotaInfo: { remainingFraction: 0.85, resetTime: "2026-08-25T12:00:00Z" },
          },
          "gemini-3.8-flash-medium": {
            displayName: "Gemini 3.8 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-25T12:00:00Z" },
          },
          "gemini-3.8-flash-low": {
            displayName: "Gemini 3.8 Flash (Low)",
            quotaInfo: { remainingFraction: 0.35, resetTime: "2026-08-25T12:00:00Z" },
          },
          "internal-model": {
            displayName: "Internal",
            isInternal: true,
            quotaInfo: { remainingFraction: 0.5 },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity quota tracker: Gemini 3.8 Flash usage bars", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("returns Argon quotas when the upstream catalog exposes them", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});
    for (const id of ["gemini-4-argon", "gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"]) {
      expect(usage.quotas[id]).toMatchObject({ used: 500, total: 1000, remainingPercentage: 50 });
    }
    expect(usage.quotas["internal-model"]).toBeUndefined();
  });

  it("returns Gemini 3.8 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"]).toMatchObject({
      used: 150,
      total: 1000,
      remainingPercentage: 85,
      displayName: "Gemini 3.8 Flash (High)",
    });
    expect(usage.quotas["gemini-3.8-flash-medium"]).toMatchObject({
      used: 400,
      total: 1000,
      remainingPercentage: 60,
    });
    expect(usage.quotas["gemini-3.8-flash-low"]).toMatchObject({
      used: 650,
      total: 1000,
      remainingPercentage: 35,
    });
  });
});

