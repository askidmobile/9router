import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/providerQuotaSnapshots.js", () => ({ saveQuotaSnapshot: vi.fn(), getQuotaSnapshot: vi.fn() }));
vi.mock("../../src/shared/utils/ssrfGuard.js", () => ({ fetchPublic: vi.fn() }));
import { saveQuotaSnapshot, getQuotaSnapshot } from "@/lib/providerQuotaSnapshots.js";
import { captureProviderQuota, getObservedUsage, parseRateLimitHeaders } from "../../open-sse/services/usage/rateLimits.js";
import { isUsageEligible, getQuotaProvider } from "../../src/shared/utils/providerQuota.js";
import { fetchPublic } from "../../src/shared/utils/ssrfGuard.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import brave from "../../open-sse/providers/registry/brave-search.js";

beforeEach(() => vi.clearAllMocks());

describe("rate-limit observations", () => {
  it("reads Groq's day requests and minute tokens with duration resets", async () => {
    const headers = new Headers({ "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "980", "x-ratelimit-reset-requests": "2m30s", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "2000", "x-ratelimit-reset-tokens": "7.5s" });
    const quotas = parseRateLimitHeaders("groq", headers, 1000000);
    expect(quotas["requests/day"]).toMatchObject({ used: 20, total: 1000, resetAt: new Date(1150000).toISOString() });
    expect(quotas["tokens/min"].remainingPercentage).toBe(25);
    await captureProviderQuota("groq", "connection", "model", headers);
    expect(saveQuotaSnapshot).toHaveBeenCalledWith("groq", "connection", "model", expect.objectContaining({ "tokens/min": expect.any(Object) }));
  });

  it("keeps Brave's second and monthly windows separate", () => {
    const quotas = parseRateLimitHeaders("brave-search", new Headers({ "x-ratelimit-limit": "1,15000", "x-ratelimit-remaining": "0,1000", "x-ratelimit-reset": "1,123456", "x-ratelimit-policy": "1;w=1, 15000;w=2592000" }));
    expect(quotas["Requests/second"].remainingPercentage).toBe(0);
    expect(quotas["Requests/month"]).toMatchObject({ used: 14000, total: 15000, remainingPercentage: 7 });
  });

  it("captures Brave headers on the actual search handler path", async () => {
    fetchPublic.mockResolvedValue(new Response(JSON.stringify({ web: { results: [] } }), { headers: { "content-type": "application/json", "x-ratelimit-limit": "1,15000", "x-ratelimit-remaining": "0,1000", "x-ratelimit-reset": "1,123456", "x-ratelimit-policy": "1;w=1,15000;w=2592000" } }));
    const result = await handleSearchCore({ provider: brave, providerConfig: brave.searchConfig, body: { query: "fixture search" }, credentials: { apiKey: "fixture", connectionId: "brave-connection" } });
    expect(result.success).toBe(true);
    expect(saveQuotaSnapshot).toHaveBeenCalledWith("brave-search", "brave-connection", "default", expect.objectContaining({ "Requests/month": expect.objectContaining({ total: 15000 }) }));
  });

  it("reads Anthropic timestamps and omits absent or malformed headers", () => {
    const quotas = parseRateLimitHeaders("anthropic", new Headers({ "anthropic-ratelimit-input-tokens-limit": "1000", "anthropic-ratelimit-input-tokens-remaining": "300", "anthropic-ratelimit-input-tokens-reset": "2030-01-01T00:00:00Z", "anthropic-ratelimit-requests-limit": "100" }));
    expect(Object.keys(quotas)).toEqual(["input-tokens/min"]);
    expect(quotas["input-tokens/min"].remainingPercentage).toBe(30);
    expect(parseRateLimitHeaders("nebius", new Headers({ "x-ratelimit-limit-requests": "bad", "x-ratelimit-remaining-requests": "5" }))).toEqual({});
  });

  it("doesn't fabricate quotas from /models or write snapshots for unsupported providers", async () => {
    await captureProviderQuota("groq", "connection", "model", new Headers());
    await captureProviderQuota("unrelated", "connection", "model", new Headers({ "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0" }));
    expect(saveQuotaSnapshot).not.toHaveBeenCalled();
  });

  it("loads a persisted snapshot and keeps its model and observation time", async () => {
    const observedAt = new Date().toISOString();
    getQuotaSnapshot.mockResolvedValue({ provider: "groq", models: { model: { observedAt, quotas: { "tokens/min": { used: 5, total: 10, remainingPercentage: 50, resetAt: new Date(Date.now() + 60000).toISOString() } } } } });
    const usage = await getObservedUsage("groq", "connection");
    expect(usage.quotas["model · tokens/min"]).toMatchObject({ total: 10, observedAt });
  });

  it("does not reset old snapshots to 100% or reuse another provider's data", async () => {
    getQuotaSnapshot.mockResolvedValue({ provider: "groq", models: { model: { observedAt: new Date().toISOString(), quotas: { Tokens: { used: 5, total: 10, resetAt: new Date(Date.now() - 1000).toISOString() } } } } });
    expect((await getObservedUsage("groq", "connection")).quotas).toBeUndefined();
    expect((await getObservedUsage("anthropic", "connection")).quotas).toBeUndefined();
  });
});

describe("quota eligibility", () => {
  it("accepts the confirmed API-key and OAuth providers", () => {
    for (const provider of ["apinex", "requesty", "cheaper", "jina-ai", "jina-reader", "anthropic", "brave-search", "nebius", "cerebras"]) expect(isUsageEligible({ provider, authType: "apikey" })).toBe(true);
    expect(isUsageEligible({ provider: "kilocode", authType: "oauth" })).toBe(true);
    expect(isUsageEligible({ provider: "kiro", authType: "api_key" })).toBe(true);
  });
  it("recognizes only the trusted custom origin", () => {
    const c = { provider: "openai-compatible-fixture", authType: "apikey", providerSpecificData: { baseUrl: "https://kenari.id/v1" } };
    expect(getQuotaProvider(c)).toBe("kenari");
    expect(isUsageEligible(c)).toBe(true);
    for (const baseUrl of ["http://kenari.id/v1", "https://kenari.id.evil.test/v1", "https://user:pass@kenari.id/v1", "bad"]) expect(isUsageEligible({ ...c, providerSpecificData: { baseUrl } })).toBe(false);
  });
});
