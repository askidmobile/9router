/**
 * Misc usage handlers (iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * Ollama Cloud Usage
 * Primary: GET https://ollama.com/api/usage — session (5h) + weekly (7d) `usage`
 *   is a 0..1 ratio (1.0 = limit reached). No reset timestamps exposed.
 * Optional precise reset dates: scrape https://ollama.com/settings with the
 *   browser `__Secure-session` cookie (set via OLLAMA_USAGE_COOKIE env or the
 *   connection's ollamaUsageCookie) — the page embeds per-track usage % and
 *   reset times. Same approach as OmniRoute.
 * POST https://ollama.com/api/me — plan label (fail-open).
 */
const OLLAMA_SETTINGS_URL = "https://ollama.com/settings";
const OLLAMA_SESSION_COOKIE = "__Secure-session";

function resolveOllamaUsageCookie(providerSpecificData) {
  const env = process.env.OLLAMA_USAGE_COOKIE?.trim()
    || process.env.OLLAMA_CLOUD_USAGE_COOKIE?.trim() || "";
  if (env) return env.replace(new RegExp(`^${OLLAMA_SESSION_COOKIE}=`), "").trim();
  const raw = providerSpecificData?.ollamaUsageCookie
    || providerSpecificData?.usageCookie || "";
  return String(raw).trim().replace(new RegExp(`^${OLLAMA_SESSION_COOKIE}=`), "").trim();
}

function parseOllamaSettingsHtml(html) {
  const parts = html.split(/\bdata-usage-track\b/);
  if (parts.length < 2) return null;
  const extractPct = (seg) => {
    const header = seg.match(/^[^>]*/)?.[0] ?? "";
    const aria = header.match(/(\d+(?:\.\d+)?)%\s*used/);
    if (aria) {
      const pct = Number(aria[1]);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
    }
    const style = header.match(/style="([^"]*)"/)?.[1] ?? "";
    const w = Number(style.match(/(?:^|;)\s*width\s*:\s*([0-9.]+)%/)?.[1]);
    return Number.isFinite(w) && w >= 0 && w <= 100 ? w : null;
  };
  const extractTime = (seg) => seg.match(/class="[^"]*local-time[^"]*"[^>]*data-time="([^"]*)"/)?.[1] || null;
  const sessionPercent = extractPct(parts[1]);
  const weeklyPercent = parts[2] ? extractPct(parts[2]) : null;
  if (sessionPercent === null && weeklyPercent === null) return null;
  return {
    session: sessionPercent !== null ? { percent: sessionPercent, resetAt: extractTime(parts[1]) } : null,
    weekly: weeklyPercent !== null ? { percent: weeklyPercent, resetAt: extractTime(parts[2]) } : null,
    planTier: html.match(/class="[^"]*capitalize[^"]*"[^>]*>([^<]*)</)?.[1]?.trim() || null,
  };
}

async function fetchOllamaSettingsUsage(cookie, proxyOptions) {
  const response = await proxyAwareFetch(OLLAMA_SETTINGS_URL, {
    redirect: "manual",
    headers: {
      Accept: "text/html",
      Cookie: `${OLLAMA_SESSION_COOKIE}=${cookie}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/152.0",
    },
  }, proxyOptions);
  if (response.status >= 300 && response.status < 400) {
    return { error: "Ollama Cloud cookie expired — copy a fresh __Secure-session cookie from ollama.com/settings." };
  }
  if (!response.ok) {
    return { error: `Ollama Cloud settings error (${response.status}).` };
  }
  const parsed = parseOllamaSettingsHtml(await response.text());
  if (!parsed) return { error: "Ollama Cloud settings page had no usage tracks." };
  return { parsed };
}

export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://ollama.com/api/usage", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch("https://ollama.com/api/me", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};

    // Ollama `usage` is a 0..1 ratio (1.0 = limit reached). Convert to a 0..100
    // bar. Do NOT set absolute `remaining` — QuotaTable reads remainingPercentage.
    // The API exposes no reset timestamp: both windows are ROLLING (usage frees
    // up as requests age out), so any "resets at" date would be fabricated.
    function ratioQuota(usageRatio) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, unlimited: false };
    }

    const sessionRaw = limits.session?.usage;
    const weeklyRaw = limits.weekly?.usage;
    const sessionNum = Number(sessionRaw);
    const weeklyNum = Number(weeklyRaw);
    const hasSession = sessionRaw !== undefined && sessionRaw !== null && !Number.isNaN(sessionNum);
    const hasWeekly = weeklyRaw !== undefined && weeklyRaw !== null && !Number.isNaN(weeklyNum);

    if (!hasSession && !hasWeekly) {
      return {
        plan,
        message: "Ollama Cloud connected. No usage limits reported.",
        quotas: {},
      };
    }

    const quotas = {};
    if (hasSession) quotas["Session (5h)"] = ratioQuota(sessionNum);
    if (hasWeekly) quotas["Weekly (7d)"] = ratioQuota(weeklyNum);

    // Optional precision layer: scrape the settings page with the browser
    // session cookie for exact reset dates. Fail-open — ratios above remain.
    const cookie = resolveOllamaUsageCookie(providerSpecificData);
    if (cookie) {
      const scraped = await fetchOllamaSettingsUsage(cookie, proxyOptions).catch(() => ({ error: "Ollama settings fetch failed" }));
      if (scraped.parsed) {
        for (const [name, win] of Object.entries(scraped.parsed)) {
          if (name === "planTier") continue;
          if (!win || !win.resetAt) continue;
          const key = name === "session" ? "Session (5h)" : "Weekly (7d)";
          if (quotas[key]) quotas[key].resetAt = win.resetAt;
        }
      }
    }

    return { plan, quotas, ...(cookie ? {} : { cookieHint: "Set OLLAMA_USAGE_COOKIE (or connection ollamaUsageCookie) for exact reset dates" }) };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}

/**
 * GLM Coding Plan usage (international + China regions)
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region] || "https://api.z.ai/api/monitor/usage/quota/limit";

  try {
    const response = await proxyAwareFetch(quotaUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    for (const limit of limits) {
      if (!limit) continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);
      const unit = Number(limit.unit);
      const name = unit === 3 ? "5-Hour Limit" : unit === 6 ? "Monthly Limit" : `Limit (${limit.type || "Quota"})`;

      quotas[name] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "GLM Coding";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

/**
 * OpenCode Go usage (Rolling, Weekly, Monthly limits)
 * GET https://opencode.ai/zen/go/v1/usage
 */
export async function getOpencodeGoUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "OpenCode Go API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://opencode.ai/zen/go/v1/usage", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { message: "OpenCode Go API key invalid or expired." };
      }
      return { message: `OpenCode Go usage error (${response.status}).` };
    }

    const json = await response.json();
    const usage = json?.usage || {};
    const quotas = {};

    if (usage.rolling) {
      const p = Math.min(100, Math.max(0, Number(usage.rolling.percent) || 0));
      quotas["Rolling (5h)"] = {
        used: p,
        total: 100,
        remaining: Math.max(0, 100 - p),
        remainingPercentage: Math.max(0, 100 - p),
        resetAt: usage.rolling.resetsAt || null,
        unlimited: false,
      };
    }
    if (usage.weekly) {
      const p = Math.min(100, Math.max(0, Number(usage.weekly.percent) || 0));
      quotas["Weekly"] = {
        used: p,
        total: 100,
        remaining: Math.max(0, 100 - p),
        remainingPercentage: Math.max(0, 100 - p),
        resetAt: usage.weekly.resetsAt || null,
        unlimited: false,
      };
    }
    if (usage.monthly) {
      const p = Math.min(100, Math.max(0, Number(usage.monthly.percent) || 0));
      quotas["Monthly"] = {
        used: p,
        total: 100,
        remaining: Math.max(0, 100 - p),
        remainingPercentage: Math.max(0, 100 - p),
        resetAt: usage.monthly.resetsAt || null,
        unlimited: false,
      };
    }

    return { plan: "OpenCode Go", quotas };
  } catch (error) {
    return { message: `OpenCode Go error: ${error.message}` };
  }
}

/**
 * Command Code credits and 5-hour / weekly usage limits
 * GET https://api.commandcode.ai/alpha/billing/credits
 */
export async function getCommandCodeUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Command Code API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://api.commandcode.ai/alpha/billing/credits", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-cli-environment": "cli",
        "x-command-code-version": "1.25.0",
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { message: "Command Code API key invalid or expired." };
      }
      return { message: `Command Code usage error (${response.status}).` };
    }

    const json = await response.json();
    const limits = json?.windowLimits || {};
    const quotas = {};

    if (limits.fiveHour) {
      const used = Number(limits.fiveHour.used) || 0;
      const cap = Number(limits.fiveHour.cap) || 100;
      const resetAt = limits.fiveHour.resetAt ? new Date(limits.fiveHour.resetAt).toISOString() : null;
      const remaining = Math.max(0, cap - used);
      const remainingPercentage = Math.round((remaining / cap) * 100);
      quotas["Session (5h)"] = {
        used: Math.round(used * 100) / 100,
        total: cap,
        remaining: Math.round(remaining * 100) / 100,
        remainingPercentage,
        resetAt,
        unlimited: false,
      };
    }

    if (limits.weekly) {
      const used = Number(limits.weekly.used) || 0;
      const cap = Number(limits.weekly.cap) || 100;
      const resetAt = limits.weekly.resetAt ? new Date(limits.weekly.resetAt).toISOString() : null;
      const remaining = Math.max(0, cap - used);
      const remainingPercentage = Math.round((remaining / cap) * 100);
      quotas["Weekly"] = {
        used: Math.round(used * 100) / 100,
        total: cap,
        remaining: Math.round(remaining * 100) / 100,
        remainingPercentage,
        resetAt,
        unlimited: false,
      };
    }

    return { plan: "Command Code", quotas };
  } catch (error) {
    return { message: `Command Code error: ${error.message}` };
  }
}

/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

/**
 * OpenRouter usage — per-key limits + account credits.
 *   GET https://openrouter.ai/api/v1/key     → { data: { usage, limit,
 *   limit_reset, limit_remaining, is_free_tier, ... } }
 *   GET https://openrouter.ai/api/v1/credits → { data: { total_credits, total_usage } }
 * Docs: https://openrouter.ai/docs/api_reference/limits
 */
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

// Approximate the next reset instant for a rolling limit_reset period.
function openRouterResetAt(limitReset) {
  const now = new Date();
  if (limitReset === "daily") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  if (limitReset === "weekly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7)).toISOString();
  if (limitReset === "monthly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return null;
}

export async function getOpenRouterUsage(apiKey, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "OpenRouter API key not available. Add a key to view usage." };
  }
  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    Accept: "application/json",
  };

  try {
    const keyRes = await proxyAwareFetch(OPENROUTER_KEY_URL, { method: "GET", headers }, proxyOptions);
    if (keyRes.status === 401 || keyRes.status === 403) {
      return { plan: "OpenRouter", message: "OpenRouter authentication failed. Check the API key." };
    }
    if (!keyRes.ok) {
      return { plan: "OpenRouter", message: `OpenRouter key API error (${keyRes.status}).` };
    }
    const keyData = (await keyRes.json().catch(() => null))?.data;
    if (!keyData || typeof keyData !== "object") {
      return { plan: "OpenRouter", message: "OpenRouter key response was not JSON." };
    }

    const quotas = {};
    let plan = "OpenRouter";
    if (keyData.is_free_tier) plan += " (Free tier)";

    // Per-key spend cap — the hard 402 boundary for this connection.
    const keyLimit = Number(keyData.limit);
    if (Number.isFinite(keyLimit) && keyLimit > 0) {
      const used = Number(keyData.usage) || 0;
      const remainingPct = Math.max(0, Math.round(((keyLimit - used) / keyLimit) * 100));
      quotas["Key limit (USD)"] = {
        used,
        total: keyLimit,
        remainingPercentage: remainingPct,
        resetAt: openRouterResetAt(keyData.limit_reset),
        unlimited: false,
      };
    }

    // Account-level balance (credits purchased vs spent across all keys).
    const creditsRes = await proxyAwareFetch(OPENROUTER_CREDITS_URL, { method: "GET", headers }, proxyOptions).catch(() => null);
    if (creditsRes?.ok) {
      const creditsData = (await creditsRes.json().catch(() => null))?.data;
      const totalCredits = Number(creditsData?.total_credits);
      const totalUsage = Number(creditsData?.total_usage);
      if (Number.isFinite(totalCredits) && totalCredits > 0) {
        const balance = Math.max(0, totalCredits - (Number.isFinite(totalUsage) ? totalUsage : 0));
        const balancePct = Math.round((balance / totalCredits) * 100);
        // Show the CURRENT BALANCE as the headline number, as an unlimited
        // row (no total denominator) — the user cares only about what's left.
        quotas["Balance (USD)"] = {
          used: Math.round(balance * 100) / 100,
          total: 0,
          remainingPercentage: 100,
          unlimited: true,
        };
        if (balance <= 0) plan += " (Insufficient Balance)";
      }
    }

    // Free-tier daily request caps depend on lifetime credits (< $10 → 50/day).
    if (keyData.is_free_tier) {
      quotas["Free requests/day"] = {
        used: 0,
        total: Number.isFinite(totalCredits) && totalCredits >= 10 ? 1000 : 50,
        remainingPercentage: 100,
        unlimited: false,
      };
    }

    if (Object.keys(quotas).length === 0) {
      return { plan, message: "OpenRouter connected. No spend limits configured." };
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `OpenRouter error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U("qoder").url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total.
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}
