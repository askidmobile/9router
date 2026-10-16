/**
 * Misc usage handlers (iFlow, Ollama, GLM re-export, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, creditBalance, toFiniteNumber, fetchWithTimeout } from "./shared.js";

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

const OLLAMA_LIMIT_WINDOWS = {
  session: "Session (5h)",
  weekly: "Weekly (7d)",
  monthly: "Monthly",
};

function addUtcMonths(date, months) {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ));
}

// Free plan: "usage resets monthly from the date you signed up" (ollama.com/pricing).
function nextMonthlyResetFromSignup(createdAt, now = new Date()) {
  const anchor = new Date(createdAt);
  if (Number.isNaN(anchor.getTime())) return null;
  const elapsedMonths = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + (now.getUTCMonth() - anchor.getUTCMonth());
  for (let i = Math.max(0, elapsedMonths); i <= elapsedMonths + 1; i++) {
    const candidate = addUtcMonths(anchor, i);
    if (candidate > now) return candidate.toISOString();
  }
  return null;
}

/**
 * Ollama Cloud Usage
 * GET https://ollama.com/api/usage — `limits.<window>.usage` is a 0..1 ratio
 *   (1.0 = limit reached). Paid plans report session (5h) + weekly (7d); the
 *   free plan reports a single monthly window. No reset timestamp exposed;
 *   the free monthly reset is derived from the account's signup date.
 * POST https://ollama.com/api/me — plan label + CreatedAt (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 * Optional exact reset dates come from the settings page with a saved session cookie.
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
    function ratioQuota(usageRatio, resetAt = null) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
    }

    const monthlyResetAt = planRaw.toLowerCase() === "free" && me?.CreatedAt
      ? nextMonthlyResetFromSignup(me.CreatedAt)
      : null;

    const quotas = {};
    for (const [key, label] of Object.entries(OLLAMA_LIMIT_WINDOWS)) {
      const raw = limits[key]?.usage;
      if (raw === undefined || raw === null) continue;
      const ratio = Number(raw);
      if (Number.isNaN(ratio)) continue;
      quotas[label] = ratioQuota(ratio, key === "monthly" ? monthlyResetAt : null);
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan,
        message: "Ollama Cloud did not report subscription limits. Usage statistics do not represent remaining quota.",
        quotas: {},
      };
    }

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

export { getGlmUsage } from "./glm.js";

// Preserve the original export while sharing the stricter quota parser.
export { getOpenCodeGoUsage as getOpencodeGoUsage } from "./opencode-go.js";

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
    const creditValues = ["monthlyCredits", "purchasedCredits", "freeCredits"].map(key => toFiniteNumber(json?.credits?.[key], null));
    if (creditValues.every(value => value !== null)) quotas["Credit balance"] = creditBalance(creditValues.reduce((sum, value) => sum + value, 0), "credits");

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

// OpenRouter's period counters reset on UTC calendar boundaries.
function openRouterResetAt(limitReset) {
  const now = new Date();
  const nextDay = limitReset === "weekly" ? 7 - ((now.getUTCDay() + 6) % 7) : 1;
  if (limitReset === "daily" || limitReset === "weekly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + nextDay)).toISOString();
  if (limitReset === "monthly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return null;
}

export async function getOpenRouterUsage(apiKey, proxyOptions = null) {
  if (typeof apiKey !== "string" || !apiKey.trim()) return { message: "OpenRouter API key not available. Add a key to view usage." };
  const headers = { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" };
  try {
    const keyRes = await fetchWithTimeout(OPENROUTER_KEY_URL, { method: "GET", headers }, 10000, proxyOptions);
    if (keyRes.status === 401 || keyRes.status === 403) return { plan: "OpenRouter", message: "OpenRouter authentication failed. Check the API key." };
    if (!keyRes.ok) return { plan: "OpenRouter", message: `OpenRouter key API error (${keyRes.status}).` };
    const keyData = (await keyRes.json().catch(() => null))?.data;
    if (!keyData || typeof keyData !== "object") return { message: "OpenRouter key data unavailable." };
    const quotas = {};
    const keyLimit = toFiniteNumber(keyData.limit, null);
    if (keyLimit !== null && keyLimit >= 0) {
      const period = ["daily", "weekly", "monthly"].includes(keyData.limit_reset) ? `_${keyData.limit_reset}` : "";
      const usage = toFiniteNumber(keyData[`usage${period}`], null);
      const byok = keyData.include_byok_in_limit ? toFiniteNumber(keyData[`byok_usage${period}`], 0) : 0;
      const remaining = toFiniteNumber(keyData.limit_remaining, null);
      const used = remaining !== null ? Math.max(0, keyLimit - remaining) : usage === null ? null : usage + byok;
      if (used !== null) quotas["Key limit (USD)"] = { used, total: keyLimit, unit: "USD", remainingPercentage: keyLimit > 0 ? Math.max(0, Math.min(100, Math.round((keyLimit - used) / keyLimit * 100))) : 0, resetAt: openRouterResetAt(keyData.limit_reset) };
    }
    const free = keyData.free_model_daily_requests;
    const freeLimit = toFiniteNumber(free?.limit, null);
    const freeUsed = toFiniteNumber(free?.used, null);
    const freeRemaining = toFiniteNumber(free?.remaining, null);
    if (freeLimit !== null && freeUsed !== null && freeRemaining !== null) quotas["Free requests/day"] = { used: freeUsed, total: freeLimit, remainingPercentage: freeLimit > 0 ? Math.max(0, Math.min(100, Math.round(freeRemaining / freeLimit * 100))) : 0, resetAt: openRouterResetAt("daily") };
    let notice;
    const creditsRes = await fetchWithTimeout(OPENROUTER_CREDITS_URL, { method: "GET", headers }, 10000, proxyOptions).catch(() => null);
    if (creditsRes?.ok) {
      const data = (await creditsRes.json().catch(() => null))?.data;
      const total = toFiniteNumber(data?.total_credits, null);
      const used = toFiniteNumber(data?.total_usage, null);
      if (total !== null && used !== null) quotas["Balance (USD)"] = creditBalance(Math.round((total - used) * 100) / 100, "USD");
      else notice = "Account balance unavailable.";
    } else notice = creditsRes?.status === 403 ? "Account balance requires reporting permission; key limits remain available." : "Account balance unavailable; key limits remain available.";
    // Put the available funds first, matching the other account cards.
    const balance = quotas["Balance (USD)"];
    if (balance) { delete quotas["Balance (USD)"]; return { plan: "OpenRouter", quotas: { "Balance (USD)": balance, ...quotas }, ...(notice ? { notice } : {}) }; }
    return Object.keys(quotas).length ? { plan: "OpenRouter", quotas, ...(notice ? { notice } : {}) } : { plan: "OpenRouter", message: notice || "No spend limits reported." };
  } catch { return { message: "OpenRouter quota data unavailable. Try refreshing later." }; }
}

export async function getQoderUsage(accessToken, proxyOptions = null, providerId = "qoder") {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U(providerId).url,
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
    // Add-on credits (free grants / promos). Qoder emits this block only when
    // the account actually holds a grant — an account that never redeemed one,
    // or consumed it, omits the key entirely. Verified against both regions:
    // qoder CN returns it (e.g. 2200 total) after redeeming the free-credit
    // promo, while an intl account without a grant has no such key. Gating on
    // total > 0 keeps the intl/no-grant shape byte-identical to before.
    const addOnQuota = body.addOnQuota || {};
    const addOnTotal = Number(addOnQuota.total) || 0;
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total. 253402214400000 (9999-12-31T00:00:00Z)
    // is Qoder's "never expires" sentinel, returned by both regions for
    // open-ended plans — rendering a reset date in the year 9999 is noise, so
    // flag it instead and let the tracker word it as "Never expires".
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const NO_RESET_SENTINEL_MS = 253402214400000;
    const neverExpires = expiresAtMs === NO_RESET_SENTINEL_MS;
    const resetAt = expiresAtMs && !neverExpires ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
        neverExpires,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
        neverExpires,
      },
    };
    if (addOnTotal > 0) {
      quotas.addOn = {
        total: addOnTotal,
        used: Number(addOnQuota.used) || 0,
        remaining: Number(addOnQuota.remaining) || 0,
        unit: addOnQuota.unit || "credits",
        // The add-on block carries no expiry of its own in this API. Qoder's
        // web console lists every redeemed resource package with its own
        // deadline (check-in bonuses do expire, typically ~30 days), but
        // openapi only exposes the account-level `expiresAt` sentinel above,
        // which describes the plan, not the grants — reusing it here would
        // advertise "never expires" for credits that actually expire. So
        // leave the reset date unset and let the row link to Qoder's own
        // usage page (detailUrl) where the per-package dates live.
        resetAt: null,
        neverExpires: false,
        detailUrl: addOnQuota.detailUrl || null,
      };
    }
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
