import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getAccountUsage } from "../../open-sse/services/usage/accounts.js";

const UNOROUTER_USAGE_URL = "https://api.unorouter.com/api/usage/token/";
const UNOROUTER_SUBSCRIPTION_URL = "https://api.unorouter.com/api/subscription/self";

// Живой ответ /api/subscription/self (2026-11-20): 5 000 000 единиц = $10.00,
// использовано 86 785 = $0.17, недельный сброс next_reset_time.
const SUBSCRIPTION_PAYLOAD = {
  success: true,
  message: "",
  data: {
    billing_preference: "subscription_first",
    subscriptions: [
      {
        subscription: {
          id: 953, user_id: 117133, plan_id: 1,
          amount_total: 5000000, amount_used: 86785,
          start_time: 1794565179, end_time: 1797157179,
          status: "active", source: "order",
          last_reset_time: 1795169979, next_reset_time: 1795774779,
          allow_wallet_overflow: true,
        },
        plan_title: "20$ 1 Month",
      },
    ],
    all_subscriptions: [],
  },
};

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

  it("adds the subscription window when the access token + user id are configured", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation((url, opts) => {
      if (String(url).includes("/api/subscription/self")) {
        const headers = opts?.headers || {};
        expect(headers["New-Api-User"]).toBe("117133");
        expect(headers.Authorization).toBe("Bearer site-access-token");
        return Promise.resolve(jsonResponse(SUBSCRIPTION_PAYLOAD));
      }
      return Promise.resolve(jsonResponse(REAL_PAYLOAD));
    });

    const usage = await getAccountUsage(
      { ...connection, providerSpecificData: { unorouterAccessToken: "site-access-token", unorouterUserId: "117133" } },
      null,
    );

    // Баланс на месте, подписка — рядом с ним отдельной строкой-окном.
    expect(usage.quotas["Available (USD)"].total).toBeCloseTo(5.03, 2);
    const sub = usage.quotas["Subscription · 20$ 1 Month"];
    expect(sub).toBeDefined();
    expect(sub.total).toBeCloseTo(10, 6);
    expect(sub.used).toBeCloseTo(0.17357, 4);
    expect(sub.unit).toBe("USD");
    expect(sub.remainingPercentage).toBe(98);
    expect(sub.resetAt).toBe(new Date(1795774779 * 1000).toISOString());
    expect(sub.recurring).toBe(true);
  });

  it("skips the subscription call without credentials and survives its failure", async () => {
    // Без токена — один запрос, только баланс.
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse(REAL_PAYLOAD));
    let usage = await getAccountUsage(connection, null);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(usage.quotas)).toEqual(["Available (USD)"]);

    // Подписочный роут недоступен (истёкший токен) — баланс не глушится.
    vi.mocked(proxyAwareFetch).mockImplementation((url) =>
      String(url).includes("/api/subscription/self")
        ? Promise.resolve(new Response("{}", { status: 401 }))
        : Promise.resolve(jsonResponse(REAL_PAYLOAD)),
    );
    usage = await getAccountUsage(
      { ...connection, providerSpecificData: { unorouterAccessToken: "stale", unorouterUserId: "117133" } },
      null,
    );
    expect(usage.quotas["Available (USD)"].total).toBeCloseTo(5.03, 2);
    expect(usage.quotas["Subscription · 20$ 1 Month"]).toBeUndefined();
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
