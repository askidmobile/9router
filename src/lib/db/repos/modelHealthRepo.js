// Rolling per provider|model outcome counters.
//
// usageHistory only records successful requests, so "how often does this model
// fail?" had no answer anywhere: failures lived in requestDetails (capped at 200
// rows) and in per-connection cooldowns. A status view needs a cheap, durable
// counter instead.
//
// Hot path rules: recordModelOutcome() is synchronous, never throws and never
// awaits — it only bumps in-memory counters and schedules a flush. Writes are
// batched into SQLite every few seconds, the same pattern requestDetailsRepo
// uses for request details.

import { makeKv } from "../helpers/kvStore.js";

const modelHealthKv = makeKv("modelHealth");

export const HOUR_MS = 60 * 60 * 1000;
export const RETENTION_HOURS = 168; // 7 days
const FLUSH_INTERVAL_MS = 5000;

const COUNTER_FIELDS = [
  "ok", "err", "client",
  "e401", "e402", "e403", "e404", "e408", "e429", "e5xx", "timeout",
  "latSum", "latCount", "outputTokens", "generationMs", "speedSamples", "ttftSum", "ttftCount",
];

let buffer = new Map(); // "provider|model" -> { provider, model, buckets: Map<hourKey, counters> }
let flushTimer = null;
let isFlushing = false;

export function hourKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 13);
}

/**
 * Map a request outcome onto the counter it increments.
 * Exported for tests and for the catalog builder, which must agree with it.
 */
export function classifyOutcome(status, { timeout = false, cancelled = false } = {}) {
  if (cancelled || status === 499) return "client";
  if (timeout) return "timeout";
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "e401";
  if (status === 402) return "e402";
  if (status === 403) return "e403";
  if (status === 404) return "e404";
  if (status === 408) return "e408";
  if (status === 429) return "e429";
  if (status >= 500) return "e5xx";
  return "err";
}

function emptyCounters() {
  return Object.fromEntries(COUNTER_FIELDS.map((field) => [field, 0]));
}

function addCounters(target, source) {
  const out = { ...(target || emptyCounters()) };
  for (const field of COUNTER_FIELDS) {
    if (source?.[field]) out[field] = (out[field] || 0) + source[field];
  }
  if (source?.lastError) {
    // Keep the newest error text only; older details live in requestDetails.
    if (!out.lastErrorAt || String(source.lastErrorAt) >= String(out.lastErrorAt)) {
      out.lastError = source.lastError;
      out.lastErrorAt = source.lastErrorAt;
    }
  }
  return out;
}

function pruneBuckets(buckets, now = Date.now()) {
  const cutoff = hourKey(now - RETENTION_HOURS * HOUR_MS);
  const out = {};
  for (const [hour, counters] of Object.entries(buckets || {})) {
    if (hour >= cutoff) out[hour] = counters;
  }
  return out;
}

/**
 * Record one finished request. Synchronous by design: callers sit in the proxy
 * hot path and must not pay for a database round trip.
 *
 * @param {{provider: string, model: string, status: number, latencyMs?: number,
 *          error?: string|null, timeout?: boolean, cancelled?: boolean}} outcome
 */
export function recordModelOutcome(outcome) {
  try {
    const counters = getCounters(outcome?.provider, outcome?.model);
    if (!counters) return;

    const bucket = classifyOutcome(outcome.status, {
      timeout: outcome.timeout === true,
      cancelled: outcome.cancelled === true,
    });
    counters[bucket] = (counters[bucket] || 0) + 1;
    if (bucket !== "ok" && bucket !== "client") {
      if (bucket !== "err") counters.err = (counters.err || 0) + 1;
      if (outcome.error) {
        counters.lastError = String(outcome.error).slice(0, 400);
        counters.lastErrorAt = new Date().toISOString();
      }
    }
    const latency = Number(outcome.latencyMs);
    if (Number.isFinite(latency) && latency >= 0) {
      counters.latSum = (counters.latSum || 0) + latency;
      counters.latCount = (counters.latCount || 0) + 1;
    }

    scheduleFlush();
  } catch {
    // Health accounting must never break a request.
  }
}

function getCounters(provider, model) {
  provider = String(provider || "").trim();
  model = String(model || "").trim();
  if (!provider || !model) return null;
  const key = `${provider}|${model}`;
  const hour = hourKey();
  if (!buffer.has(key)) buffer.set(key, { provider, model, buckets: new Map() });
  const entry = buffer.get(key);
  if (!entry.buckets.has(hour)) entry.buckets.set(hour, emptyCounters());
  return entry.buckets.get(hour);
}

// Usage arrives after lifecycle accounting; this must not increment request counts again.
export function recordModelPerformance({ provider, model, outputTokens, generationMs, ttftMs, estimated } = {}) {
  try {
    const tokens = Number(outputTokens);
    const duration = Number(generationMs);
    if (estimated || !Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(duration) || duration <= 0) return;
    const counters = getCounters(provider, model);
    if (!counters) return;
    counters.outputTokens += tokens;
    counters.generationMs += duration;
    counters.speedSamples++;
    const ttft = Number(ttftMs);
    if (Number.isFinite(ttft) && ttft >= 0) { counters.ttftSum += ttft; counters.ttftCount++; }
    scheduleFlush();
  } catch { /* telemetry must never fail a request */ }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDatabase().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export async function flushToDatabase() {
  if (isFlushing || buffer.size === 0) return;
  isFlushing = true;
  try {
    while (buffer.size > 0) {
      const entries = [...buffer.entries()];
      buffer = new Map();

      const byProvider = new Map();
      for (const [, item] of entries) {
        if (!byProvider.has(item.provider)) byProvider.set(item.provider, {});
        const models = byProvider.get(item.provider);
        if (!models[item.model]) models[item.model] = {};
        for (const [hour, counters] of item.buckets) {
          models[item.model][hour] = addCounters(models[item.model][hour], counters);
        }
      }

      await modelHealthKv.updateMany([...byProvider.keys()], (previous, provider) => {
        const current = previous && typeof previous === "object" ? previous : {};
        const incoming = byProvider.get(provider) || {};
        const next = { ...current };
        for (const [model, buckets] of Object.entries(incoming)) {
          const existing = current[model]?.buckets || {};
          const merged = { ...existing };
          for (const [hour, counters] of Object.entries(buckets)) {
            merged[hour] = addCounters(merged[hour], counters);
          }
          const pruned = pruneBuckets(merged);
          if (Object.keys(pruned).length) next[model] = { buckets: pruned };
          else delete next[model];
        }
        return Object.keys(next).length ? next : null;
      });
    }
  } catch (error) {
    console.error("[modelHealthRepo] flush failed:", error?.message || error);
  } finally {
    isFlushing = false;
  }
}

/** All stored counters, merged with anything still buffered. */
export async function getModelHealth() {
  await flushToDatabase().catch(() => {});
  return await modelHealthKv.getAll();
}

/**
 * Aggregate one model's buckets into the numbers a status view shows.
 * Pure function so tests can pin the thresholds' inputs exactly.
 *
 * @param {{buckets?: object}|null} entry
 * @param {{hours?: number, now?: number}} [options]
 */
export function summarizeHealth(entry, options = {}) {
  const hours = options.hours ?? 24;
  const now = options.now ?? Date.now();
  const cutoff = hourKey(now - hours * HOUR_MS);
  const total = emptyCounters();
  let lastError = null;
  let lastErrorAt = null;

  for (const [hour, counters] of Object.entries(entry?.buckets || {})) {
    if (hour < cutoff) continue;
    for (const field of COUNTER_FIELDS) {
      if (counters?.[field]) total[field] += counters[field];
    }
    if (counters?.lastErrorAt && (!lastErrorAt || counters.lastErrorAt > lastErrorAt)) {
      lastError = counters.lastError || null;
      lastErrorAt = counters.lastErrorAt;
    }
  }

  const requests = total.ok + total.err;
  return {
    requests,
    ok: total.ok,
    err: total.err,
    errorRate: requests > 0 ? total.err / requests : null,
    avgLatency: total.latCount > 0 ? Math.round(total.latSum / total.latCount) : null,
    tokensPerSecond: total.generationMs > 0 ? Math.round(total.outputTokens * 10000 / total.generationMs) / 10 : null,
    avgTtft: total.ttftCount > 0 ? Math.round(total.ttftSum / total.ttftCount) : null,
    speedSamples: total.speedSamples,
    rateLimited: total.e429,
    serverErrors: total.e5xx,
    timeouts: total.timeout,
    authErrors: total.e401 + total.e402 + total.e403,
    lastError,
    lastErrorAt,
  };
}

export async function clearModelHealth(provider) {
  if (!provider) {
    await modelHealthKv.clear();
    buffer = new Map();
    return;
  }
  await modelHealthKv.remove(provider);
}

export const __test__ = {
  reset() {
    buffer = new Map();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  },
  bufferSize: () => buffer.size,
  /** Buffered counters in the stored shape: `{ provider|model: { buckets } }`. */
  snapshot() {
    const out = {};
    for (const [key, entry] of buffer) {
      out[key] = { buckets: Object.fromEntries(entry.buckets) };
    }
    return out;
  },
  addCounters,
  pruneBuckets,
};
