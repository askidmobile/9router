// Collapsed-row numbers for a model group ("3 providers, from $0.11").
// Shared with the page so sorting by a group column matches what is displayed.

export const STATUS_RANK = { ok: 0, unknown: 1, degraded: 2, cooldown: 3, down: 4 };

function minDefined(values) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return numbers.length ? Math.min(...numbers) : null;
}

function maxDefined(values) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return numbers.length ? Math.max(...numbers) : null;
}

export function summarizeGroup(group) {
  const providers = group?.providers || [];
  const fastest = providers.reduce((best, row) => {
    const speed = row.health?.tokensPerSecond;
    return typeof speed === "number" && Number.isFinite(speed) && (!best || speed > best.health.tokensPerSecond) ? row : best;
  }, null);

  const pricing = {
    input: minDefined(providers.map((row) => row.pricing?.input)),
    output: minDefined(providers.map((row) => row.pricing?.output)),
    cached: minDefined(providers.map((row) => row.pricing?.cached)),
    cache_creation: minDefined(providers.map((row) => row.pricing?.cache_creation)),
  };

  let statusState = "ok";
  let requests = 0;
  for (const row of providers) {
    const state = row.status?.state || "unknown";
    if ((STATUS_RANK[state] ?? 0) > (STATUS_RANK[statusState] ?? 0)) statusState = state;
    requests += row.health?.requests || 0;
  }

  return {
    providers: providers.length,
    pricing,
    contextWindow: maxDefined(providers.map((row) => row.caps?.contextWindow)),
    maxOutput: maxDefined(providers.map((row) => row.caps?.maxOutput)),
    statusState,
    requests,
    tokensPerSecond: fastest?.health.tokensPerSecond ?? null,
    avgTtft: fastest?.health.avgTtft ?? null,
    speedSamples: fastest?.health.speedSamples ?? 0,
    speedProvider: fastest?.providerAlias,
    hasFreeProvider: providers.some((row) => row.pricingSource?.source === "free"),
    missingPrices: providers.filter((row) => !row.pricing || Object.keys(row.pricing).length === 0).length,
  };
}
