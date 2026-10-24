import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("usage registry flags", () => {
  it("includes opencode-go and commandcode in usage-supported apikey providers", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("opencode-go");
    expect(USAGE_APIKEY_PROVIDERS).toContain("opencode-go");
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("commandcode");
    expect(USAGE_APIKEY_PROVIDERS).toContain("commandcode");
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("glm");
    expect(USAGE_APIKEY_PROVIDERS).toContain("glm");
  });
});

describe("GLM usage parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses CREDIT_LIMIT quotas from GLM usage response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 200,
        data: {
          limits: [
            {
              type: "CREDIT_LIMIT",
              unit: 3,
              number: 5,
              percentage: 100,
              nextResetTime: 1786749523649,
            },
            {
              type: "CREDIT_LIMIT",
              unit: 6,
              number: 1,
              percentage: 20,
              nextResetTime: 1787336073998,
            },
          ],
          level: "lite",
        },
      })
    );

    const usage = await getUsageForProvider({
      provider: "glm",
      apiKey: "glm-key",
    });

    expect(usage.plan).toBe("Lite");
    // upstream glm.js parser keys quotas by unit: 3 → "Session (5h)", 6 → "Weekly (7d)"
    expect(usage.quotas["Session (5h)"]).toBeDefined();
    expect(usage.quotas["Session (5h)"].used).toBe(100);
    expect(usage.quotas["Weekly (7d)"]).toBeDefined();
    expect(usage.quotas["Weekly (7d)"].used).toBe(20);

    const parsed = parseQuotaData("glm", usage);
    expect(parsed.length).toBe(2);
    expect(parsed[0].name).toBe("Session (5h)");
    expect(parsed[1].name).toBe("Weekly (7d)");
  });
});

describe("OpenCode Go usage parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches and parses OpenCode Go rolling and monthly limits", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 15, resetsAt: "2026-08-15T02:08:13.245Z" },
          weekly: { status: "ok", percent: 40, resetsAt: "2026-08-17T00:00:00.245Z" },
          monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-08-26T09:20:20.245Z" },
        },
      })
    );

    const usage = await getUsageForProvider({
      provider: "opencode-go",
      apiKey: "ocg-key",
    });

    expect(usage.plan).toBe("OpenCode Go");
    expect(usage.quotas["Rolling (5h)"].used).toBe(15);
    expect(usage.quotas["Weekly"].used).toBe(40);
    expect(usage.quotas["Monthly"].used).toBe(100);

    const parsed = parseQuotaData("opencode-go", usage);
    expect(parsed.length).toBe(3);
    expect(parsed.find((q) => q.name === "Monthly").used).toBe(100);
  });
});

describe("Command Code usage parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches and parses Command Code 5-hour and weekly limits", async () => {
    // Upstream 4a76b8de: whoami + credits + subscriptions (план из подписки)
    proxyAwareFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/alpha/whoami")) return jsonResponse({ user: { name: "U" }, org: { id: "org_1", name: "personal" } });
      if (u.includes("/alpha/billing/credits")) return jsonResponse({
        credits: { monthlyCredits: 12.5, purchasedCredits: 1, freeCredits: 0.5 },
        windowLimits: {
          limited: true,
          fiveHour: { used: 5, cap: 14, resetAt: Date.now() + 3_600_000 },
          weekly: { used: 35, cap: 35, resetAt: Date.now() + 86_400_000 },
        },
      });
      if (u.includes("/alpha/billing/subscriptions")) return jsonResponse({ data: { planId: "individual-goat", currentPeriodStart: "2026-09-01T00:00:00.000Z", currentPeriodEnd: "2026-10-01T00:00:00.000Z" } });
      return jsonResponse({ error: "unexpected " + u }, 404);
    });

    const usage = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "user_xxx",
    });

    expect(usage.plan).toBe("GOAT");
    expect(usage.quotas["Session (5h)"]).toMatchObject({ used: 5, total: 14 });
    expect(usage.quotas.Weekly).toMatchObject({ used: 35, total: 35, percentage: 100 });

    const parsed = parseQuotaData("commandcode", usage);
    expect(parsed.length).toBe(3);  // Credits + Session (5h) + Weekly
  });
});
