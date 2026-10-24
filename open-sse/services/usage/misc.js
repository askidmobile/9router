/**
 * Misc usage handlers (iFlow, Ollama, GLM re-export, Vercel AI Gateway, Qoder)
 */

import { createHash } from "node:crypto";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../../config/errorConfig.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, creditBalance, toFiniteNumber, fetchWithTimeout, parseResetTime } from "./shared.js";

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

// The balance endpoint is limited per user across keys/devices; coalesce reads
// and follow the documented once-per-minute polling recommendation per key.
const ollamaUsageCache = new Map();

export async function getOllamaUsage(apiKey, proxyOptions = null) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Ollama Cloud API key not available." };
  }
  const token = apiKey.trim();
  const cacheKey = createHash("sha256").update(token).digest("hex");
  const cached = ollamaUsageCache.get(cacheKey);
  if (cached?.promise) return cached.promise;
  if (cached?.expiresAt > Date.now()) return cached.result;
  const config = U("ollama");
  const task = (async () => {
    let ttlMs = 0;
    let result;
    try {
      const response = await fetchWithTimeout(config.url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      }, undefined, proxyOptions);
      if (!response.ok) await response.body?.cancel();
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const seconds = retry?.trim() ? Number(retry) : NaN;
        const deadline = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry || "");
        ttlMs = Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Math.max(config.cacheTtlMs, Number.isFinite(deadline) ? deadline - Date.now() : 0));
        result = { message: "Ollama Cloud balance API rate limited. Try again after the retry time.", retryAfter: new Date(Date.now() + ttlMs).toISOString() };
      } else if (response.status === 401 || response.status === 403) {
        result = { message: "Ollama Cloud API key invalid or expired." };
      } else if (!response.ok) {
        result = { message: `Ollama Cloud balance API error (${response.status}).` };
      } else {
        const data = await response.json();
        const included = data?.included;
        const quotas = {};
        const balance = toFiniteNumber(included?.balance_usd, null);
        const allowance = toFiniteNumber(included?.allowance_usd, null);
        if (balance !== null && allowance !== null && allowance >= 0) {
          quotas["Monthly credits (USD)"] = {
            used: Math.max(0, allowance - balance), total: allowance, unit: "USD",
            remainingPercentage: allowance > 0 ? Math.max(0, Math.min(100, balance / allowance * 100)) : 0,
            resetAt: parseResetTime(included?.period?.until), unlimited: false,
            detail: `Remaining: ${balance.toFixed(2)} USD`,
          };
        }
        for (const [name, label] of [["session", "Session (5h)"], ["weekly", "Weekly (7d)"]]) {
          const remaining = toFiniteNumber(included?.[name]?.remaining_percent, null);
          if (remaining === null) continue;
          const percent = Math.max(0, Math.min(100, remaining));
          quotas[label] = { used: 100 - percent, total: 100, remainingPercentage: percent,
            resetAt: parseResetTime(included[name].resets_at), unlimited: false };
        }
        const purchased = toFiniteNumber(data?.purchased?.balance_usd, null);
        if (purchased !== null) quotas["Purchased credits (USD)"] = creditBalance(purchased, "USD");
        result = Object.keys(quotas).length
          ? { plan: "Ollama Cloud", quotas }
          : { message: "Ollama Cloud did not report balance or subscription limits.", quotas: {} };
        if (Object.keys(quotas).length) ttlMs = config.cacheTtlMs;
      }
    } catch {
      result = { message: "Unable to fetch Ollama Cloud balance. Try refreshing later." };
    }
    if (ttlMs > 0) ollamaUsageCache.set(cacheKey, { result, expiresAt: Date.now() + ttlMs });
    else ollamaUsageCache.delete(cacheKey);
    return result;
  })();
  if (!ollamaUsageCache.has(cacheKey) && ollamaUsageCache.size >= config.maxCacheEntries) {
    ollamaUsageCache.delete(ollamaUsageCache.keys().next().value);
  }
  ollamaUsageCache.set(cacheKey, { promise: task });
  return task;
}

export { getGlmUsage } from "./glm.js";

// Preserve the original export while sharing the stricter quota parser.
export { getOpenCodeGoUsage as getOpencodeGoUsage } from "./opencode-go.js";

/**
 * Command Code credits and 5-hour / weekly usage limits
 * GET https://api.commandcode.ai/alpha/billing/credits
 */

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
