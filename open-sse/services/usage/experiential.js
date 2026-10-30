/**
 * Experiential Labs usage — wallet balance, the key's daily spend cap and
 * lifetime spend. Both reads take the same org-level xpl_ key as inference:
 *   GET https://api.experientiallabs.ai/api/v1/credits
 *       → { data: { total_credits, total_usage } } (USD)
 *   GET https://api.experientiallabs.ai/api/v1/key
 *       → { data: { usage, limit, limit_remaining } }; limit is a DAILY USD cap
 * Docs: https://platform.experientiallabs.ai/docs (Cost API / Account API).
 */

import { fetchWithTimeout, toFiniteNumber, creditBalance } from "./shared.js";

const CREDITS_URL = "https://api.experientiallabs.ai/api/v1/credits";
const KEY_URL = "https://api.experientiallabs.ai/api/v1/key";

// The key cap is a daily USD budget; a fresh one starts at 00:00 UTC.
function nextUtcMidnight() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

// Every documented Cost/Account reply wraps its payload in `data`; tolerate a
// bare payload too so a shape change degrades to "no rows" instead of a throw.
function payload(body) {
  if (!body || typeof body !== "object") return null;
  const data = body.data ?? body;
  return data && typeof data === "object" ? data : null;
}

function readPlan(...sources) {
  for (const source of sources) {
    if (!source) continue;
    for (const value of [source.plan, source.tier, source.plan_name, source.subscription?.plan]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function readKeyCap(keyData) {
  const limit = toFiniteNumber(keyData?.limit, null);
  if (limit === null || limit <= 0) return null;
  const remaining = toFiniteNumber(keyData?.limit_remaining, null);
  const reportedUsage = toFiniteNumber(keyData?.usage, null);
  const used = remaining !== null
    ? Math.max(0, limit - remaining)
    : Math.max(0, reportedUsage ?? 0);
  return { limit, used, remaining };
}

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 */
export async function getExperientialUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Experiential Labs API key not available. Add a key to view usage." };
  }

  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    Accept: "application/json",
  };

  try {
    const [keyRes, creditsRes] = await Promise.all([
      fetchWithTimeout(KEY_URL, { method: "GET", headers }, 10000, proxyOptions).catch(() => null),
      fetchWithTimeout(CREDITS_URL, { method: "GET", headers }, 10000, proxyOptions).catch(() => null),
    ]);

    // A rejected key is the one answer worth surfacing verbatim: the route's
    // force-refresh path keys off this wording, and nothing else can be read.
    if (keyRes?.status === 401 || keyRes?.status === 403) {
      return { message: "Experiential Labs authentication failed. Check the API key." };
    }

    const keyData = keyRes?.ok ? payload(await keyRes.json().catch(() => null)) : null;
    const creditsData = creditsRes?.ok ? payload(await creditsRes.json().catch(() => null)) : null;

    const quotas = {};

    // Wallet: balance = credits granted - usage, both already in USD.
    const totalCredits = toFiniteNumber(creditsData?.total_credits, null);
    const totalUsage = toFiniteNumber(creditsData?.total_usage, null);
    if (totalCredits !== null && totalUsage !== null) {
      quotas["Balance (USD)"] = creditBalance(roundCents(totalCredits - totalUsage), "USD");
    }

    // Daily spend cap of the presented key, when the platform enforces one.
    const cap = readKeyCap(keyData);
    if (cap) {
      quotas["Daily key limit (USD)"] = {
        used: roundCents(cap.used),
        total: roundCents(cap.limit),
        unit: "USD",
        remainingPercentage: Math.max(0, Math.min(100, Math.round((cap.remaining / cap.limit) * 100))),
        resetAt: nextUtcMidnight(),
      };
    }

    // Lifetime spend as reported by the wallet — an amount row, not a budget.
    if (totalUsage !== null) {
      quotas["Total spent (USD)"] = {
        used: 0,
        total: roundCents(totalUsage),
        isAmount: true,
        amountLabel: "Spent",
        currency: "USD",
        resetAt: null,
      };
    }

    const plan = readPlan(keyData, creditsData);
    const notice = !creditsData && keyData
      ? "Usage reads are available; the wallet balance endpoint did not answer."
      : undefined;

    if (Object.keys(quotas).length === 0) {
      const status = keyRes && !keyRes.ok ? ` (${keyRes.status})` : "";
      return {
        ...(plan ? { plan } : {}),
        message: `Experiential Labs usage data unavailable${status}. Try refreshing later.`,
      };
    }

    return {
      ...(plan ? { plan } : {}),
      quotas,
      ...(notice ? { notice } : {}),
    };
  } catch {
    return { message: "Experiential Labs usage data unavailable. Try refreshing later." };
  }
}
