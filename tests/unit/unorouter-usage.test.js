import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getAccountUsage } from "../../open-sse/services/usage/accounts.js";

const UNOROUTER_USAGE_URL = "https://api.unorouter.com/api/usage/token/";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Реальный ответ прод-ключа 2026-11-20: верхний уровень — грант ключа
// (unlimited, granted=0 → available отрицательный по построению),
// деньги аккаунта — в user_quota (2 517 459 единиц = $5.03, ровно столько
// показывала страница Оплата; used 9 744 009 = $19.49).
const REAL_PAYLOAD = {
  success: true,
  message: "",
  data: {
    object: "token_usage",
    name: "9router",
    total_granted: 0,
    total_used: 9744009,
    total_available: -9744009,
    unlimited_quota: true,
    model_limits: {},
    model_limits_enabled: false,
    expires_at: 0,
    user_quota: { total_available: 2517459, total_used: 9744009 },
  },
};

const connection = { provider: "unorouter", apiKey: "sk-test" };

beforeEach(() => {
  vi.mocked(proxyAwareFetch).mockReset();
});

describe("unorouter usage parser", () => {
  it("takes the balance from user_quota, not the key grant (unlimited key)", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse(REAL_PAYLOAD));

    const usage = await getAccountUsage(connection, null);
    const quota = usage.quotas["Available (USD)"];

    expect(proxyAwareFetch).toHaveBeenCalledExactlyOnceWith(
      UNOROUTER_USAGE_URL,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sk-test" }) }),
      null,
    );
    expect(quota.total).toBeCloseTo(5.03, 2);
    expect(quota.isCreditBalance).toBe(true);
    expect(quota.currency).toBe("USD");
    expect(quota.detail).toContain("Used: $19.49");
    expect(quota.detail).toContain("API key: unlimited");
    // Отрицательный «доступный остаток ключа» не просачивается в баланс.
    expect(quota.total).toBeGreaterThanOrEqual(0);
  });

  it("falls back to the key view when the key holds a real grant", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(
      jsonResponse({
        data: {
          total_granted: 10000000, // $20
          total_used: 4000000, // $8
          total_available: 6000000, // $12
          unlimited_quota: false,
        },
      }),
    );

    const usage = await getAccountUsage(connection, null);
    const quota = usage.quotas["Available (USD)"];

    expect(quota.total).toBeCloseTo(12, 6);
    expect(quota.detail).toContain("Used: $8.00");
    expect(quota.detail).toContain("Key grant: $20.00");
  });

  it("refuses a meaningless negative key view without user_quota", async () => {
    // Unlimited key without a grant and without user_quota: the old parser
    // showed this as a negative balance and marked the provider depleted.
    vi.mocked(proxyAwareFetch).mockResolvedValue(
      jsonResponse({
        data: { total_granted: 0, total_used: 9744009, total_available: -9744009, unlimited_quota: true },
      }),
    );

    const usage = await getAccountUsage(connection, null);
    // На ошибке парсер возвращает { message } без quotas вовсе.
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toBe("Balance data unavailable.");
  });

  it("exposes the quota to the dashboard parser as a credit balance row", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse(REAL_PAYLOAD));

    const usage = await getAccountUsage(connection, null);
    const { parseQuotaData } = await import(
      "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );
    const parsed = parseQuotaData("unorouter", usage);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].isCreditBalance).toBe(true);
    expect(parsed[0].total).toBeCloseTo(5.03, 2);
    expect(parsed[0].currency).toBe("USD");
  });
});
