// Provenance for stored prices.
//
// The `pricing` scope holds bare numbers, which is enough to bill a request but
// not enough to answer "where did this rate come from, and when was it read?".
// The dashboard needs that answer: a provider's own catalog is the rate charged
// on this key, models.dev lags, and static tables are a guess from the model
// name. Without provenance all three look identical on screen.
//
// Stored shape (one kv key per provider, mirroring the `pricing` scope):
//   { "<model>": { source, updatedAt, url?, verified } }
//
// Rank guard mirrors capsRepo: an incomplete refresh must never overwrite a
// better-attested value with a weaker one.

import { makeKv } from "../helpers/kvStore.js";

const pricingMetaKv = makeKv("pricingMeta");

// Higher wins. A manual edit outranks every automated source; a provider's own
// catalog outranks third-party catalogs; static tables are the last resort.
export const PRICING_SOURCE_RANK = {
  manual: 5,
  provider: 4,
  "manufacturer-docs": 3,
  "models.dev": 2,
  static: 1,
};

/** Higher wins. Unknown/absent sources rank 0 so anything attested replaces them. */
export function pricingSourceRank(source) {
  return PRICING_SOURCE_RANK[source] || 0;
}

const rank = pricingSourceRank;

function newerThan(previous, incoming) {
  if (!previous?.updatedAt || !incoming?.updatedAt) return false;
  return String(previous.updatedAt) > String(incoming.updatedAt);
}

/**
 * Record where a batch of prices came from.
 *
 * @param {string} provider - provider alias/id the `pricing` scope is keyed by
 * @param {string[]} models - model ids written in the same transaction
 * @param {{source: string, updatedAt?: string, url?: string|null, verified?: boolean}} options
 */
export async function setPricingMeta(provider, models, options = {}) {
  const ids = (models || []).filter(Boolean);
  if (!provider || ids.length === 0) return;
  const incoming = {
    source: options.source || "models.dev",
    updatedAt: options.updatedAt || new Date().toISOString(),
    url: options.url || null,
    verified: options.verified === true,
  };
  await pricingMetaKv.updateMany([provider], (previous) => {
    const current = previous && typeof previous === "object" ? previous : {};
    const next = { ...current };
    for (const model of ids) {
      const existing = current[model];
      // Never downgrade: only a strictly better (or equally attested, newer)
      // observation replaces what is already stored.
      if (existing && rank(existing.source) > rank(incoming.source)) continue;
      if (existing && rank(existing.source) === rank(incoming.source) && newerThan(existing, incoming)) continue;
      next[model] = { ...incoming };
    }
    return next;
  });
}

/** All provenance records: `{ provider: { model: meta } }`. */
export async function getPricingMeta() {
  return await pricingMetaKv.getAll();
}

/** Provenance for one model, or null when the rate was never imported. */
export async function getPricingMetaForModel(provider, model) {
  if (!provider || !model) return null;
  const byProvider = await pricingMetaKv.get(provider);
  return byProvider?.[model] || null;
}

export async function clearPricingMeta(provider, model) {
  if (!provider) {
    await pricingMetaKv.clear();
    return;
  }
  if (!model) {
    await pricingMetaKv.remove(provider);
    return;
  }
  await pricingMetaKv.updateMany([provider], (previous) => {
    if (!previous || typeof previous !== "object") return null;
    const next = { ...previous };
    delete next[model];
    return Object.keys(next).length ? next : null;
  });
}

export const __test__ = { rank };