import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseQuotaData, getRemainingPercentage } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => vi.clearAllMocks());

describe("account quotas through dispatch and dashboard normalization", () => {
  it("renders OpenRouter balance separately from key and free-model limits", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({ data: { limit: 20, limit_remaining: 15, usage: 300, usage_monthly: 5, limit_reset: "monthly", is_free_tier: false, free_model_daily_requests: { used: 12, limit: 1000, remaining: 988 } } }))
      .mockResolvedValueOnce(json({ data: { total_credits: 100, total_usage: 82.52 } }));
    const usage = await getUsageForProvider({ provider: "openrouter", apiKey: "fixture-key" });
    const rows = parseQuotaData("openrouter", usage);
    expect(rows.find(r => r.name === "Balance (USD)")).toMatchObject({ used: 0, total: 17.48, isCreditBalance: true, currency: "USD" });
    expect(usage.quotas["Key limit (USD)"]).toMatchObject({ used: 5, total: 20, remainingPercentage: 75 });
    expect(usage.quotas["Free requests/day"]).toMatchObject({ used: 12, total: 1000 });
  });

  it("keeps zero/negative balances and does not fail on free-tier accounts", async () => {
    for (const balance of [0, -1.25]) {
      proxyAwareFetch.mockResolvedValueOnce(json({ data: { limit: null, is_free_tier: true, free_model_daily_requests: { used: 5, limit: 50, remaining: 45 } } }))
        .mockResolvedValueOnce(json({ data: { total_credits: 0, total_usage: -balance } }));
      const usage = await getUsageForProvider({ provider: "openrouter", apiKey: "fixture" });
      expect(usage.message).toBeUndefined();
      expect(usage.quotas["Balance (USD)"].total).toBe(balance);
      expect(usage.quotas["Free requests/day"].remainingPercentage).toBe(90);
    }
  });

  it("preserves key quotas when account balance is forbidden", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({ data: { limit: 10, limit_remaining: 4 } }))
      .mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    const usage = await getUsageForProvider({ provider: "openrouter", apiKey: "fixture" });
    expect(usage.quotas["Key limit (USD)"].remainingPercentage).toBe(40);
    expect(usage.quotas["Balance (USD)"]).toBeUndefined();
    expect(usage.notice).toMatch(/balance|permission/i);
  });

  it.each([
    ["apinex", { balance_usd: 2.8, reserved_usd: 0.3, rpm: 30 }, "Available (USD)", 2.5, "USD"],
    ["cheaper", { balance_usd: 10, available_usd: 8, reserved_usd: 2 }, "Available (USD)", 8, "USD"],
    ["kilocode", { balance: 12.5, isDepleted: false }, "Balance (USD)", 12.5, "USD"],
    ["jina-ai", { wallet: { total_balance: 12345, trial_balance: 12345, regular_balance: 0 }, email: "private@example.test", api_key: "DO_NOT_RETURN" }, "Balance (tokens)", 12345, "tokens"],
    ["jina-reader", { wallet: { total_balance: 0, trial_balance: 0, regular_balance: 0 } }, "Balance (tokens)", 0, "tokens"],
  ])("maps %s balance without leaking account data", async (provider, data, name, total, currency) => {
    proxyAwareFetch.mockResolvedValueOnce(json(data));
    const usage = await getUsageForProvider({ provider, apiKey: "fixture", accessToken: "fixture" });
    const row = parseQuotaData(provider, usage).find(r => r.name === name);
    expect(row).toMatchObject({ total, isCreditBalance: true, currency });
    expect(JSON.stringify(usage)).not.toMatch(/private@example|DO_NOT_RETURN/);
  });

  it("reads only Requesty's own monthly budget and treats zero as unlimited", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({ monthly_spend: "20.83", monthly_limit: "0" }));
    const usage = await getUsageForProvider({ provider: "requesty", apiKey: "fixture" });
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://api-v2.requesty.ai/v1/manage/apikey/self");
    expect(parseQuotaData("requesty", usage)[0]).toMatchObject({ used: 20.83, unlimited: true, unit: "USD" });
  });

  it("uses the fixed Kenari endpoints for an existing custom connection", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({ available_micro_idr: 2500000000, reserved_micro_idr: 1000000, currency: "IDR" }))
      .mockResolvedValueOnce(json({ plan: { name: "Indie", windows: { week: { budget_rp: 100, used_rp: 25, remaining_rp: 75, resets_at: "2030-01-01T00:00:00Z" } } }, coupon: { remaining_rp: 50, expires_at: "2030-02-01T00:00:00Z" } }));
    const provider = "openai-compatible-chat-fixture";
    const usage = await getUsageForProvider({ provider, apiKey: "fixture", providerSpecificData: { baseUrl: "https://kenari.id/v1/chat/completions" } });
    const rows = parseQuotaData(provider, usage);
    expect(rows.find(r => r.name === "Available (IDR)")).toMatchObject({ total: 2500, currency: "IDR", isCreditBalance: true });
    expect(rows.find(r => r.name === "Weekly")).toMatchObject({ used: 25, total: 100, remainingPercentage: 75 });
    expect(rows.find(r => r.name === "Coupon (IDR)")).toMatchObject({ recurring: false });
    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual(["https://kenari.id/v1/account/balance", "https://kenari.id/v1/account/quota"]);
  });

  it("does not send custom-provider credentials to an unrelated quota service", async () => {
    const usage = await getUsageForProvider({ provider: "openai-compatible-chat-fixture", apiKey: "fixture", providerSpecificData: { baseUrl: "https://kenari.id.evil.test/v1" } });
    expect(usage.message).toMatch(/not implemented/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("reports missing permission and malformed balances without zero quotas or secrets", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({ error: { code: "insufficient_scope", message: "fixture-key" } }, 403));
    const forbidden = await getUsageForProvider({ provider: "cheaper", apiKey: "fixture-key" });
    expect(forbidden.message).toMatch(/permission|access/i);
    expect(forbidden.message).not.toContain("fixture-key");
    proxyAwareFetch.mockResolvedValueOnce(json({ balance_usd: null }));
    const malformed = await getUsageForProvider({ provider: "apinex", apiKey: "fixture" });
    expect(malformed.quotas).toBeUndefined();
    expect(malformed.message).toMatch(/unavailable|invalid|missing/i);
  });

  it("does not turn a Cloudflare GraphQL error into a full quota", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({ errors: [{ message: 'unknown field "aiWorkersAiInvocationsAdaptiveGroups"' }], data: null }));
    const usage = await getUsageForProvider({ provider: "cloudflare-ai", apiKey: "fixture", providerSpecificData: { accountId: "fixture" } });
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toMatch(/analytics|unavailable/i);
  });

  it("shows Command Code credits separately from exhausted windows", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({ credits: { monthlyCredits: 10, purchasedCredits: 2, freeCredits: 1 }, windowLimits: { weekly: { used: 35, cap: 35 } } }));
    const usage = await getUsageForProvider({ provider: "commandcode", apiKey: "fixture" });
    const rows = parseQuotaData("commandcode", usage);
    expect(rows.find(r => r.name === "Credit balance")).toMatchObject({ total: 13, isCreditBalance: true });
    expect(getRemainingPercentage(rows.find(r => r.name === "Weekly"))).toBe(0);
  });
});
