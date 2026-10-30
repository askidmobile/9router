import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const KEY_URL = "https://api.experientiallabs.ai/api/v1/key";
const CREDITS_URL = "https://api.experientiallabs.ai/api/v1/credits";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Both reads run in parallel; answer by URL instead of call order.
function routeFetch({ key, credits }) {
  proxyAwareFetch.mockImplementation((url) => {
    if (url === KEY_URL) return Promise.resolve(key);
    if (url === CREDITS_URL) return Promise.resolve(credits);
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

describe("getUsageForProvider(experiential)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the wallet and the key cap with the org key", async () => {
    routeFetch({
      key: jsonResponse({ data: { usage: 3.25, limit: 10, limit_remaining: 6.75 } }),
      credits: jsonResponse({ data: { total_credits: 50, total_usage: 12.5 } }),
    });

    const usage = await getUsageForProvider({ provider: "experiential", apiKey: "xpl_test" });

    expect(usage.message).toBeUndefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    for (const [url, opts] of proxyAwareFetch.mock.calls) {
      expect([KEY_URL, CREDITS_URL]).toContain(url);
      expect(opts.method).toBe("GET");
      expect(opts.headers.Authorization).toBe("Bearer xpl_test");
    }

    // balance = total_credits - total_usage
    expect(usage.quotas["Balance (USD)"]).toMatchObject({
      used: 0,
      total: 37.5,
      isCreditBalance: true,
      currency: "USD",
    });
    // The key cap is a daily USD budget; used comes from limit_remaining.
    expect(usage.quotas["Daily key limit (USD)"]).toMatchObject({
      used: 3.25,
      total: 10,
      unit: "USD",
      remainingPercentage: 68,
    });
    expect(usage.quotas["Daily key limit (USD)"].resetAt).toMatch(/T00:00:00\.000Z$/);
    // Lifetime spend renders as an amount row, not a budget bar.
    expect(usage.quotas["Total spent (USD)"]).toMatchObject({
      total: 12.5,
      isAmount: true,
      amountLabel: "Spent",
      currency: "USD",
    });
  });

  it("omits the cap row for an uncapped key", async () => {
    routeFetch({
      key: jsonResponse({ data: { usage: 1.5, limit: null, limit_remaining: null } }),
      credits: jsonResponse({ data: { total_credits: 5, total_usage: 1.5 } }),
    });

    const usage = await getUsageForProvider({ provider: "experiential", apiKey: "xpl_test" });
    expect(usage.quotas["Daily key limit (USD)"]).toBeUndefined();
    expect(usage.quotas["Balance (USD)"].total).toBe(3.5);
  });

  it("accepts a bare payload and a reported plan", async () => {
    routeFetch({
      key: jsonResponse({ usage: 0, limit: 0, plan: "Pro" }),
      credits: jsonResponse({ total_credits: 700, total_usage: 0 }),
    });

    const usage = await getUsageForProvider({ provider: "experiential", apiKey: "xpl_test" });
    expect(usage.plan).toBe("Pro");
    expect(usage.quotas["Balance (USD)"].total).toBe(700);
  });

  it("reports a rejected key and a missing key without throwing", async () => {
    const missing = await getUsageForProvider({ provider: "experiential" });
    expect(missing.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch.mockReset();
    routeFetch({
      key: jsonResponse({ error: { code: "invalid_key" } }, 401),
      credits: jsonResponse({ error: "Unauthorized" }, 401),
    });
    const rejected = await getUsageForProvider({ provider: "experiential", apiKey: "xpl_bad" });
    expect(rejected.message).toMatch(/auth|key/i);
  });

  it("keeps the balance when only the key read fails", async () => {
    routeFetch({
      key: jsonResponse({ error: "boom" }, 500),
      credits: jsonResponse({ data: { total_credits: 20, total_usage: 2 } }),
    });

    const usage = await getUsageForProvider({ provider: "experiential", apiKey: "xpl_test" });
    expect(usage.quotas["Balance (USD)"].total).toBe(18);
    expect(usage.quotas["Daily key limit (USD)"]).toBeUndefined();
  });
});

describe("parseQuotaData(experiential)", () => {
  it("renders balance, key cap and spend through the generic path", () => {
    const rows = parseQuotaData("experiential", {
      quotas: {
        "Balance (USD)": { used: 0, total: 37.5, isCreditBalance: true, currency: "USD", resetAt: null },
        "Daily key limit (USD)": { used: 3.25, total: 10, unit: "USD", remainingPercentage: 68, resetAt: "2026-10-31T00:00:00.000Z" },
        "Total spent (USD)": { used: 0, total: 12.5, isAmount: true, amountLabel: "Spent", currency: "USD", resetAt: null },
      },
    });

    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName["Balance (USD)"]).toMatchObject({ isCreditBalance: true, currency: "USD", total: 37.5 });
    expect(byName["Daily key limit (USD)"]).toMatchObject({ remainingPercentage: 68, unit: "USD" });
    expect(byName["Total spent (USD)"]).toMatchObject({ isAmount: true, amountLabel: "Spent" });
  });
});
