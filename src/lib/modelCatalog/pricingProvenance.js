// Price extraction rules for the dashboard.
//
// A price shown in the catalog must answer three questions: what it is, where it
// came from and how trustworthy it is. The runtime already has a resolution
// order — user overrides win over static tables — but it throws the provenance
// away. This module keeps it.
//
// Order (first match wins):
//   1. user edit            → "manual"
//   2. provider's own catalog → "provider"
//   3. models.dev            → "models.dev"
//   4. static tables         → "provider-table" | "model-table" | "pattern" | "free"
//
// Rule of thumb: the provider's own catalog is the rate actually charged on this
// key; a pattern match is a guess from the model name and must say so. Missing
// fields stay missing — an unpublished cache rate is NOT $0.

import { resolvePricing } from "open-sse/providers/pricing.js";

export const PRICE_FIELDS = ["input", "output", "cached", "cache_creation"];
const CACHE_FIELDS = ["cached", "cache_creation"];

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Keep only usable rates; drop nulls, strings and negatives. */
export function normalizeRates(pricing) {
  const out = {};
  if (!pricing || typeof pricing !== "object") return out;
  for (const field of PRICE_FIELDS) {
    if (finite(pricing[field])) out[field] = pricing[field];
  }
  return out;
}

/** $/1M values rendered in a message; keeps warnings readable. */
function money(value) {
  return `$${Number(value).toString()}`;
}

/**
 * Flags that make a rate untrustworthy or misleading. Only actionable ones:
 * anything a user could act on by editing the price or contacting the provider.
 *
 * @param {object} rates - normalized rates
 * @param {{source?: string|null, model?: string}} [context]
 * @returns {{code: string, message: string}[]}
 */
export function priceWarnings(rates, context = {}) {
  const warnings = [];
  const { input, output, cached, cache_creation: cacheCreation } = rates || {};

  if (input === undefined && output === undefined) {
    return warnings;
  }

  if (cached === undefined) {
    warnings.push({
      code: "cache-not-published",
      message: input !== undefined
        ? `Cache read is not published; cost is computed at the input rate (${money(input)}/1M).`
        : "Cache read is not published; cost falls back to the input rate.",
    });
  }
  if (cacheCreation === undefined) {
    warnings.push({
      code: "cache-write-not-published",
      message: input !== undefined
        ? `Cache write is not published; cost is computed at the input rate (${money(input)}/1M).`
        : "Cache write is not published; cost falls back to the input rate.",
    });
  }

  const freeLane = context.source === "free" || String(context.model || "").endsWith(":free");
  if (freeLane) return warnings;

  if (input === 0 && output === 0) {
    warnings.push({
      code: "zero-price",
      message: "Both rates are zero for a paid model — the source may be incomplete.",
    });
  }
  if (finite(input) && finite(output) && output > 0 && output < input) {
    warnings.push({
      code: "output-below-input",
      message: `Output (${money(output)}) is cheaper than input (${money(input)}); check the unit — rates must be per 1M tokens.`,
    });
  }
  if (finite(input) && finite(cached) && cached > input) {
    warnings.push({
      code: "cache-above-input",
      message: `Cache read (${money(cached)}) costs more than input (${money(input)}).`,
    });
  }

  return warnings;
}

/**
 * Resolve the rate set for one provider|model together with its provenance.
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.model
 * @param {object|null} [params.stored] - rates from the `pricing` kv scope
 * @param {object|null} [params.meta] - record from the `pricingMeta` kv scope
 * @returns {{
 *   pricing: object, source: string|null, updatedAt: string|null, url: string|null,
 *   verified: boolean, missing: string[], fallbacks: object, warnings: object[]
 * }}
 */
export function resolveRateSet({ provider, model, stored, meta }) {
  const storedRates = normalizeRates(stored);
  const hasStored = Object.keys(storedRates).length > 0;

  let rates = storedRates;
  let source = meta?.source || (hasStored ? "stored" : null);
  let updatedAt = meta?.updatedAt || null;
  let url = meta?.url || null;
  let verified = meta?.verified === true;

  if (!hasStored) {
    const resolved = resolvePricing(provider, model);
    rates = normalizeRates(resolved.pricing);
    source = resolved.source;
    updatedAt = null;
    url = null;
    verified = false;
  }

  const missing = PRICE_FIELDS.filter((field) => rates[field] === undefined);
  // Mirrors calculateCostFromTokens(): an absent cache rate is billed at input.
  const fallbacks = {};
  for (const field of CACHE_FIELDS) {
    if (rates[field] === undefined && rates.input !== undefined) fallbacks[field] = "input";
  }

  return {
    pricing: rates,
    source,
    updatedAt,
    url,
    verified,
    missing,
    fallbacks,
    warnings: priceWarnings(rates, { source, model }),
  };
}

/**
 * Compare two independently sourced rate sets. Used to surface a provider
 * catalog that disagrees with models.dev — the dashboard shows the provider
 * value (it is what gets charged) but says the sources disagree.
 *
 * @returns {{field: string, primary: number, secondary: number, deltaPct: number}[]}
 */
export function compareRateSources(primary, secondary, { tolerance = 0.2 } = {}) {
  const mismatches = [];
  for (const field of PRICE_FIELDS) {
    const a = primary?.[field];
    const b = secondary?.[field];
    if (!finite(a) || !finite(b)) continue;
    if (a === 0 && b === 0) continue;
    const base = Math.max(a, b);
    if (base === 0) continue;
    const delta = Math.abs(a - b) / base;
    if (delta > tolerance) {
      mismatches.push({ field, primary: a, secondary: b, deltaPct: Math.round(delta * 100) });
    }
  }
  return mismatches;
}

export const __test__ = { finite, money };