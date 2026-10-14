import { HEADER_QUOTA_PROVIDERS, QUOTA_SNAPSHOT_MAX_AGE_MS } from "../../config/quotaTracking.js";
import { getQuotaSnapshot, saveQuotaSnapshot } from "@/lib/providerQuotaSnapshots.js";

function resetTime(value, now) {
  if (!value) return null;
  const iso = timestamp => Number.isFinite(new Date(timestamp).getTime()) ? new Date(timestamp).toISOString() : null;
  if (/^\d+(\.\d+)?$/.test(value)) return iso(now + Number(value) * 1000);
  const duration = value.match(/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/);
  if (duration) {
    const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
    const ms = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)].reduce((sum, [, n, unit]) => sum + Number(n) * units[unit], 0);
    return iso(now + ms);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseRateLimitHeaders(provider, headers, now = Date.now()) {
  const quotas = {};
  const add = (name, limitRaw, remainingRaw, resetRaw, unit) => {
    if (limitRaw === null || remainingRaw === null || limitRaw === undefined || remainingRaw === undefined || limitRaw === "" || remainingRaw === "") return;
    const total = Number(limitRaw), remaining = Number(remainingRaw);
    if (!Number.isFinite(total) || !Number.isFinite(remaining) || total < 0 || remaining < 0) return;
    quotas[name] = { used: Math.max(0, total - remaining), total, remainingPercentage: total > 0 ? Math.max(0, Math.min(100, Math.round(remaining / total * 100))) : 0, resetAt: resetTime(resetRaw, now), unit };
  };
  if (provider === "brave-search") {
    const limits = headers.get("x-ratelimit-limit")?.split(",") || [];
    const remaining = headers.get("x-ratelimit-remaining")?.split(",") || [];
    const resets = headers.get("x-ratelimit-reset")?.split(",") || [];
    const policy = headers.get("x-ratelimit-policy")?.split(",") || [];
    for (let i = 0; i < limits.length; i++) {
      const seconds = Number(policy[i]?.match(/;\s*w=(\d+)/)?.[1]);
      if (!Number.isFinite(seconds) || Number(limits[i]) === 0) continue;
      add(seconds === 1 ? "Requests/second" : seconds === 2592000 ? "Requests/month" : `Requests/${seconds}s`, limits[i]?.trim(), remaining[i]?.trim(), resets[i]?.trim(), "requests");
    }
  } else if (provider === "anthropic") {
    for (const resource of ["requests", "tokens", "input-tokens", "output-tokens"]) {
      add(`${resource}/min`, headers.get(`anthropic-ratelimit-${resource}-limit`), headers.get(`anthropic-ratelimit-${resource}-remaining`), headers.get(`anthropic-ratelimit-${resource}-reset`), resource === "requests" ? "requests" : "tokens");
    }
  } else if (provider === "cerebras") {
    for (const resource of ["requests", "tokens"]) for (const period of ["minute", "hour", "day"]) {
      const suffix = `${resource}-${period}`;
      add(`${resource}/${period}`, headers.get(`x-ratelimit-limit-${suffix}`), headers.get(`x-ratelimit-remaining-${suffix}`), headers.get(`x-ratelimit-reset-${suffix}`), resource);
    }
  } else if (provider === "groq" || provider === "nebius") {
    for (const resource of ["requests", "tokens"]) {
      const period = provider === "groq" && resource === "requests" ? "day" : "min";
      add(`${resource}/${period}`, headers.get(`x-ratelimit-limit-${resource}`), headers.get(`x-ratelimit-remaining-${resource}`), headers.get(`x-ratelimit-reset-${resource}`), resource);
    }
  }
  return quotas;
}

export async function captureProviderQuota(provider, connectionId, model, headers) {
  if (!connectionId || !HEADER_QUOTA_PROVIDERS.includes(provider)) return;
  const quotas = parseRateLimitHeaders(provider, headers);
  if (Object.keys(quotas).length) await saveQuotaSnapshot(provider, connectionId, model || "default", quotas);
}

export async function getObservedUsage(provider, connectionId) {
  const snapshot = connectionId ? await getQuotaSnapshot(connectionId) : null;
  const quotas = {};
  if (snapshot?.provider === provider) for (const [model, entry] of Object.entries(snapshot.models || {})) {
    const observed = Date.parse(entry.observedAt);
    if (!Number.isFinite(observed) || Date.now() - observed > QUOTA_SNAPSHOT_MAX_AGE_MS) continue;
    for (const [name, quota] of Object.entries(entry.quotas || {})) {
      // A reset doesn't prove the bucket is full: another client can use the same account.
      if (quota.resetAt && Date.parse(quota.resetAt) <= Date.now()) continue;
      quotas[model === "default" ? name : `${model} · ${name}`] = { ...quota, observedAt: entry.observedAt };
    }
  }
  return Object.keys(quotas).length ? { quotas } : { message: "No current rate-limit snapshot. Limits appear after a real request through this connection." };
}
