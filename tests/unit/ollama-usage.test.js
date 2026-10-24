import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const URL = "https://ollama.com/api/balance";
const BALANCE = {
  included: { balance_usd: 72.5, allowance_usd: 100, period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" } },
  purchased: { balance_usd: 25 },
};
const LEGACY = {
  included: {
    session: { remaining_percent: 75, resets_at: "2026-10-01T07:00:00Z" },
    weekly: { remaining_percent: 40, resets_at: "2026-10-05T00:00:00Z" },
  }, purchased: { balance_usd: 0 },
};
let key;
let sequence = 0;
const read = (overrides = {}, options = {}) => getUsageForProvider({ provider: "ollama", apiKey: key, ...overrides }, null, options);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  key = `fixture-${++sequence}`;
});
afterEach(() => vi.useRealTimers());

describe("Ollama official balance API", () => {
  it("supports API-key quota tracking", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("ollama");
    expect(USAGE_APIKEY_PROVIDERS).toContain("ollama");
  });

  it("reads monthly credits and purchased balance using only the API key", async () => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json(BALANCE));
    const result = await read({ providerSpecificData: { ollamaUsageCookie: "obsolete-cookie" } });
    expect(proxyAwareFetch).toHaveBeenCalledOnce();
    expect(proxyAwareFetch).toHaveBeenCalledWith(URL, expect.objectContaining({
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: expect.any(AbortSignal),
    }), null);
    expect(result.cookieHint).toBeUndefined();
    expect(result.quotas["Monthly credits (USD)"]).toMatchObject({
      used: 27.5, total: 100, remainingPercentage: 72.5, resetAt: new Date(BALANCE.included.period.until).toISOString(), unit: "USD",
    });
    expect(result.quotas["Purchased credits (USD)"]).toMatchObject({ total: 25, used: 0, isCreditBalance: true, currency: "USD" });
    const rows = parseQuotaData("ollama", result);
    expect(rows.find(r => r.name === "Purchased credits (USD)")).toMatchObject({ total: 25, isCreditBalance: true, currency: "USD" });
    expect(rows.find(r => r.name === "Monthly credits (USD)")).toMatchObject({ unit: "USD", remainingPercentage: 72.5 });
  });

  it("maps legacy remaining percentages without a cookie or guessed reset dates", async () => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json(LEGACY));
    const result = await read();
    expect(result.quotas["Session (5h)"]).toEqual({ used: 25, total: 100, remainingPercentage: 75, resetAt: new Date(LEGACY.included.session.resets_at).toISOString(), unlimited: false });
    expect(result.quotas["Weekly (7d)"]).toMatchObject({ used: 60, remainingPercentage: 40, resetAt: new Date(LEGACY.included.weekly.resets_at).toISOString() });
    expect(result.quotas["Session (5h)"].remaining).toBeUndefined();
    expect(result.quotas["Purchased credits (USD)"].total).toBe(0);
    expect(proxyAwareFetch).toHaveBeenCalledOnce();
  });

  it("preserves zero balances and clamps exhausted credits to zero percent", async () => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ included: { balance_usd: 0, allowance_usd: 60 }, purchased: { balance_usd: 0 } }));
    const result = await read();
    expect(result.quotas["Monthly credits (USD)"]).toMatchObject({ used: 60, remainingPercentage: 0 });
    expect(result.quotas["Purchased credits (USD)"].total).toBe(0);
  });

  it("coalesces parallel refreshes and caches reads for one minute, including force refresh", async () => {
    proxyAwareFetch.mockResolvedValue(Response.json(BALANCE));
    const [a,b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b);
    await read({}, { force: true });
    expect(proxyAwareFetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_001);
    proxyAwareFetch.mockResolvedValueOnce(Response.json(BALANCE));
    await read();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("does not share cached balances between credentials", async () => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json(BALANCE)).mockResolvedValueOnce(Response.json(LEGACY));
    expect((await read()).quotas["Monthly credits (USD)"]).toBeDefined();
    expect((await read({ apiKey: key + '-other' })).quotas["Session (5h)"]).toBeDefined();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After without fabricating chat quotas", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("too many requests", { status: 429, headers: { "Retry-After": "120" } }));
    const result = await read();
    expect(result.message).toContain("balance API rate limited");
    expect(result.quotas).toBeUndefined();
    expect(result.retryAfter).toBe("2026-10-01T00:02:00.000Z");
    await vi.advanceTimersByTimeAsync(61_000);
    await read();
    expect(proxyAwareFetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    proxyAwareFetch.mockResolvedValueOnce(Response.json(LEGACY));
    expect((await read()).quotas["Session (5h)"]).toBeDefined();
  });

  it.each([401, 403, 500])("reports HTTP %s safely", async status => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("private upstream data", { status }));
    const result = await read();
    expect(result.message).toMatch(status === 500 ? /balance API error/ : /invalid or expired/);
    expect(result.message).not.toContain("private upstream data");
  });

  it("does not invent limits from an unrelated or malformed response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(Response.json({ activity: {}, limits: {} }));
    expect((await read()).quotas).toEqual({});
    proxyAwareFetch.mockResolvedValueOnce(new Response("not JSON"));
    expect((await read()).message).toContain("Unable to fetch");
  });

  it("does not fetch without credentials", async () => {
    expect((await read({ apiKey: null })).message).toMatch(/API key/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });


});
