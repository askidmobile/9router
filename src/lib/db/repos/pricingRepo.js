import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { bumpCatalogRevision } from "../helpers/revision.js";
import { setPricingMeta, getPricingMeta, clearPricingMeta, pricingSourceRank } from "./pricingMetaRepo.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  if (provider) {
    // Saved prices are keyed by the ALIAS the dashboard writes (see
    // getProviderAlias() consumers), while callers hand us the registry id the
    // request pipeline uses — `requesty` vs `req`, `github` vs `gh`. Without
    // this second lookup a saved price is invisible to exactly the providers
    // whose id and alias differ, and the journal falls back to a static rate.
    const { PROVIDER_ID_TO_ALIAS } = await import("open-sse/config/providerModels.js");
    const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
    if (userPricing[provider]?.[model]) return userPricing[provider][model];
    if (alias !== provider && userPricing[alias]?.[model]) return userPricing[alias][model];
  }
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  return resolveConst(provider, model);
}

// Atomic merge inside transaction (per-provider read-modify-write).
//
// `options` records provenance for every model written in this batch
// (`{ source, updatedAt, url }`). It is optional so the existing call sites keep
// working; without it the numbers are still stored, they just stay unattributed.
export async function updatePricing(pricingData, options = {}) {
  const db = await getAdapter();

  // Provenance ranks gate the numbers too, not just the label: a models.dev
  // import must not replace rates a provider's own catalog published, or the
  // dashboard would show provider numbers under a models.dev label (or worse,
  // models.dev numbers labelled as the provider's).
  let data = pricingData;
  if (options.source) {
    const existing = await getPricingMeta();
    data = {};
    for (const [provider, models] of Object.entries(pricingData)) {
      const kept = {};
      for (const [model, pricing] of Object.entries(models || {})) {
        const previous = existing[provider]?.[model];
        if (previous && pricingSourceRank(previous.source) > pricingSourceRank(options.source)) continue;
        kept[model] = pricing;
      }
      if (Object.keys(kept).length) data[provider] = kept;
    }
    if (Object.keys(data).length === 0) {
      invalidate();
      return await getUserPricing();
    }
  }

  db.transaction(() => {
    for (const [provider, models] of Object.entries(data)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  if (options.source) {
    // Only models that actually landed get a new provenance record.
    for (const [provider, models] of Object.entries(data)) {
      await setPricingMeta(provider, Object.keys(models || {}), options);
    }
  }
  bumpCatalogRevision();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  await clearPricingMeta(provider || null, model || null);
  bumpCatalogRevision();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  await clearPricingMeta();
  bumpCatalogRevision();
  return {};
}
