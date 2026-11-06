// One server-side snapshot of every model, for both dashboard views.
//
// Before this module the models page issued eight parallel requests and merged
// them in the browser, while the provider page called a different, live endpoint.
// The two could disagree for as long as a resolver TTL. Everything here reads
// from SQLite and the static tables, so both views are built from the same bytes.
//
// No network calls: an upstream fetch on page load is exactly the hang this is
// meant to remove.

import { PROVIDER_MODELS, getModelKind } from "@/shared/constants/models";
import { getProviderAlias, getProviderByAlias, resolveProviderId } from "@/shared/constants/providers";
import {
  getCapsMetadata, getCapsOverrides, getCustomModels, getDisabledModels,
  getModelAliases, getModelNameOverrides, getPricing,
} from "@/lib/db/index.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getProviderNodes } from "@/lib/db/repos/nodesRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getPricingMeta } from "@/lib/db/repos/pricingMetaRepo.js";
import { getModelHealth, summarizeHealth } from "@/lib/db/repos/modelHealthRepo.js";
import { ALL_MODELS, getModelAvailability, indexAvailability } from "@/lib/modelAvailability.js";
import { groupLabel, modelGroupKey } from "./grouping.js";
import { normalizeModel as normalizeModelsDevModel, peekCatalog } from "@/lib/modelsDev/index.js";
import { resolveModelsDevProviderId } from "@/lib/modelsDev/providerMap.js";
import { resolveModelName } from "@/shared/utils/modelNames";
import { deriveModelStatus } from "@/shared/utils/modelStatus";
import { mergeCapsLayers, pickPublicCaps, resolveCapsCached } from "./capsResolver.js";
import { compareRateSources, resolveRateSet } from "./pricingProvenance.js";

export const HEALTH_WINDOW_HOURS = 24;
const RECENT_WINDOW_HOURS = 1;

function providerDisplay(providerId, alias) {
  const entry = getProviderByAlias(providerId) || getProviderByAlias(alias);
  return { name: entry?.name || alias || providerId, iconId: entry?.id || providerId };
}

function aliasFor(providerIdOrAlias) {
  return getProviderAlias(providerIdOrAlias) || providerIdOrAlias;
}

/**
 * Flatten the registry + saved custom models into comparable rows.
 * Pure: every input is a plain object, so tests can drive it directly.
 */
export function buildCatalogRows({
  providerModels = PROVIDER_MODELS,
  customModels = [],
  disabled = {},
  aliases = {},
  modelNames = {},
  capsOverrides = {},
  capsMetadata = {},
  pricing = {},
  pricingMeta = {},
} = {}) {
  // "alias|id" -> row. A Map (not an array) because custom models may replace a
  // built-in row with the same id, and indexOf() made that quadratic.
  const byKey = new Map();

  for (const [key, models] of Object.entries(providerModels)) {
    const alias = aliasFor(key);
    const providerId = getProviderByAlias(key)?.id || key;
    for (const model of models || []) {
      if (getModelKind(model, "llm") !== "llm") continue;
      const rowKey = `${alias}|${model.id}`;
      byKey.set(rowKey, {
        key: rowKey,
        providerId,
        providerAlias: alias,
        id: model.id,
        defaultName: model.name || model.id,
        name: resolveModelName(modelNames, providerId, model.id, model.name || model.id),
        isCustom: false,
        savedCaps: null,
      });
    }
  }

  for (const model of customModels) {
    if (!model?.id) continue;
    if (model.type && model.type !== "llm") continue;
    // Sync discoveries are not selectable models; showing them here would
    // advertise ids the router will not accept (same rule as /api/models).
    if (model.catalogOnly === true) continue;
    const alias = aliasFor(model.providerAlias);
    const providerId = getProviderByAlias(model.providerAlias)?.id || model.providerAlias;
    const rowKey = `${alias}|${model.id}`;
    const existing = byKey.get(rowKey);
    // An upstream catalog can acquire a saved custom model: keep the saved row
    // (it carries edit/delete actions) instead of duplicating the id.
    byKey.set(rowKey, {
      ...(existing || {}),
      key: rowKey,
      providerId,
      providerAlias: alias,
      id: model.id,
      defaultName: model.name || model.id,
      name: resolveModelName(modelNames, providerId, model.id, model.name || model.id),
      isCustom: true,
      savedCaps: model.caps || null,
    });
  }

  return [...byKey.values()].map((row) => {
    const { providerAlias: alias, providerId } = row;
    const keys = [`${alias}|${row.id}`, `${providerId}|${row.id}`];

    const override = keys.map((key) => capsOverrides[key]).find(Boolean) || null;
    const caps = mergeCapsLayers(resolveCapsCached(providerId, row.id), row.savedCaps, override);
    const sources = keys.map((key) => capsMetadata[key]).find(Boolean) || {};

    const stored = pricing[alias]?.[row.id] ?? pricing[providerId]?.[row.id] ?? null;
    const meta = pricingMeta[alias]?.[row.id] ?? pricingMeta[providerId]?.[row.id] ?? null;
    let rateSet = resolveRateSet({ provider: providerId, model: row.id, stored, meta });
    // Static tables sometimes key by alias (`gh`) while the registry uses an id.
    if (!Object.keys(rateSet.pricing).length && alias !== providerId) {
      rateSet = resolveRateSet({ provider: alias, model: row.id, stored, meta });
    }

    const disabledList = disabled[alias] || disabled[providerId] || [];

    return {
      key: row.key,
      providerId,
      providerAlias: alias,
      id: row.id,
      name: row.name,
      defaultName: row.defaultName,
      isCustom: row.isCustom,
      alias: aliases[`${providerId}/${row.id}`] || aliases[`${alias}/${row.id}`] || "",
      disabled: disabledList.includes(row.id),
      caps: pickPublicCaps(caps),
      capsSources: sources,
      pricing: rateSet.pricing,
      pricingSource: {
        source: rateSet.source,
        updatedAt: rateSet.updatedAt,
        url: rateSet.url,
        verified: rateSet.verified,
        missing: rateSet.missing,
        fallbacks: rateSet.fallbacks,
        warnings: rateSet.warnings,
      },
    };
  });
}

/**
 * Group rows by the model they represent, as the user reads it.
 *
 * The key is the display name (see grouping.js), because the same model arrives
 * under different ids — "deepseek-ai/DeepSeek-V4.1-Flash-1017" and
 * "deepseek-v4.1-flash-1017" are one model to anyone comparing prices.
 */
export function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const identity = modelGroupKey(row);
    if (!groups.has(identity)) {
      groups.set(identity, { id: row.id, identity, name: row.name, providers: [] });
    }
    groups.get(identity).providers.push(row);
  }
  const list = [...groups.values()];
  for (const group of list) {
    // One label for the whole group, not whichever row happened to arrive first.
    group.name = groupLabel(group.providers);
    // The shortest id reads best as the representative (no vendor prefix).
    group.id = group.providers
      .map((row) => row.id)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }
  for (const group of list) {
    group.providers.sort((a, b) => {
      const pa = a.pricing?.input ?? Number.POSITIVE_INFINITY;
      const pb = b.pricing?.input ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return a.providerAlias.localeCompare(b.providerAlias);
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return list;
}

function summarizeSources(pricingMeta, capsMetadata, health) {
  let lastPricing = null;
  let pricingCount = 0;
  for (const models of Object.values(pricingMeta || {})) {
    for (const meta of Object.values(models || {})) {
      pricingCount += 1;
      if (meta?.updatedAt && (!lastPricing || meta.updatedAt > lastPricing)) lastPricing = meta.updatedAt;
    }
  }

  let lastCaps = null;
  let capsCount = 0;
  for (const fields of Object.values(capsMetadata || {})) {
    for (const meta of Object.values(fields || {})) {
      if (!meta) continue;
      capsCount += 1;
      if (meta.updatedAt && (!lastCaps || meta.updatedAt > lastCaps)) lastCaps = meta.updatedAt;
    }
  }

  let healthModels = 0;
  for (const models of Object.values(health || {})) healthModels += Object.keys(models || {}).length;

  return {
    pricing: { imported: pricingCount, lastUpdated: lastPricing },
    caps: { tracked: capsCount, lastUpdated: lastCaps },
    health: { windowHours: HEALTH_WINDOW_HOURS, models: healthModels },
  };
}

/** models.dev prices, only when the catalog is already cached. */
function modelsDevPricing(catalog) {
  if (!catalog) return null;
  const providerIds = Object.keys(catalog);
  const cache = new Map();
  return {
    forProvider(providerId, alias) {
      const key = `${providerId}|${alias}`;
      if (cache.has(key)) return cache.get(key);
      let entry = null;
      for (const candidate of [providerId, alias]) {
        const id = resolveModelsDevProviderId(candidate, providerIds);
        if (id) {
          entry = { id, models: catalog[id]?.models || {} };
          break;
        }
      }
      cache.set(key, entry);
      return entry;
    },
  };
}

function findModelsDevRate(entry, modelId) {
  if (!entry) return null;
  const raw = entry.models?.[modelId];
  if (!raw) return null;
  const normalized = normalizeModelsDevModel({ id: modelId, ...raw });
  return normalized?.pricing || null;
}

function attachHealth(rows, { health, locks, modelsDev }) {
  return rows.map((row) => {
    const providerId = row.providerId;
    const alias = row.providerAlias;
    const healthEntry = health[providerId]?.[row.id] || health[alias]?.[row.id] || null;
    const summary = summarizeHealth(healthEntry, { hours: HEALTH_WINDOW_HOURS });
    const recent = summarizeHealth(healthEntry, { hours: RECENT_WINDOW_HOURS });
    const providerLocks = locks.get(providerId) || locks.get(alias) || null;
    const lock = providerLocks?.get(row.id) || providerLocks?.get(ALL_MODELS) || null;
    const status = deriveModelStatus({ summary, recent, lock });

    // A provider catalog that disagrees with models.dev is worth flagging: the
    // number we show is the one that gets charged, but it may simply be wrong.
    let warnings = row.pricingSource.warnings;
    if (modelsDev && row.pricingSource.source === "provider") {
      const entry = modelsDev.forProvider(providerId, alias);
      const published = findModelsDevRate(entry, row.id);
      const mismatches = published ? compareRateSources(row.pricing, published) : [];
      if (mismatches.length) {
        warnings = [
          ...warnings,
          {
            code: "source-mismatch",
            message: `Provider catalog and models.dev disagree: ${mismatches
              .map((m) => `${m.field} $${m.primary} vs $${m.secondary} (${m.deltaPct}%)`)
              .join(", ")}.`,
          },
        ];
      }
    }

    return {
      ...row,
      pricingSource: { ...row.pricingSource, warnings },
      health: summary,
      status,
    };
  });
}

function buildProviderDirectory({ rows, connections, nodes, activeAliases }) {
  const directory = {};
  const nodeNames = new Map();
  for (const node of nodes || []) {
    if (node?.id && node?.name) nodeNames.set(node.id, node.name);
    if (node?.prefix && node?.name) nodeNames.set(node.prefix, node.name);
  }
  const connectionNames = new Map();
  for (const connection of connections || []) {
    const alias = aliasFor(connection.provider);
    if (!connectionNames.has(alias) && (connection.name || connection.email)) {
      connectionNames.set(alias, connection.name || connection.email);
    }
  }

  const seen = new Set([...rows.map((row) => row.providerAlias), ...Object.keys(PROVIDER_MODELS)]);
  for (const alias of seen) {
    const providerId = resolveProviderId(alias) || alias;
    const display = providerDisplay(providerId, alias);
    directory[alias] = {
      id: providerId,
      // A user-defined node names its own group; built-in providers keep the
      // registry label. The icon always comes from the registry entry.
      name: nodeNames.get(alias) || nodeNames.get(providerId) || display.name,
      iconId: display.iconId,
      active: activeAliases.has(alias) || activeAliases.has(providerId),
      connectionName: connectionNames.get(alias) || null,
    };
  }
  return directory;
}

/**
 * Assemble the whole dashboard snapshot.
 *
 * @param {{ includeHealth?: boolean }} [options]
 */
export async function buildModelCatalog(options = {}) {
  const includeHealth = options.includeHealth !== false;
  const [
    customModels, disabled, aliases, modelNames, capsOverrides, capsMetadata,
    pricing, pricingMeta, health, connections, nodes, settings, availability, modelsDevPeek,
  ] = await Promise.all([
    getCustomModels().catch(() => []),
    getDisabledModels().catch(() => ({})),
    getModelAliases().catch(() => ({})),
    getModelNameOverrides().catch(() => ({})),
    getCapsOverrides().catch(() => ({})),
    getCapsMetadata().catch(() => ({})),
    getPricing().catch(() => ({})),
    getPricingMeta().catch(() => ({})),
    includeHealth ? getModelHealth().catch(() => ({})) : Promise.resolve({}),
    getProviderConnections().catch(() => []),
    getProviderNodes().catch(() => []),
    getSettings().catch(() => ({})),
    getModelAvailability().catch(() => ({ models: [], comboCircuits: [] })),
    peekCatalog().catch(() => ({ catalog: null, fetchedAt: 0 })),
  ]);

  const activeAliases = new Set();
  for (const connection of connections) {
    if (connection.isActive === false) continue;
    const alias = aliasFor(connection.provider);
    if (alias) activeAliases.add(alias);
    if (connection.provider) activeAliases.add(connection.provider);
  }

  let rows = buildCatalogRows({
    customModels, disabled, aliases, modelNames, capsOverrides, capsMetadata, pricing, pricingMeta,
  });
  rows = rows.map((row) => ({
    ...row,
    active: activeAliases.has(row.providerAlias) || activeAliases.has(row.providerId),
  }));
  rows = attachHealth(rows, {
    health,
    locks: indexAvailability(availability),
    modelsDev: modelsDevPricing(modelsDevPeek.catalog),
  });

  const models = groupRows(rows);
  const sources = summarizeSources(pricingMeta, capsMetadata, health);
  sources.modelsDev = {
    fetchedAt: modelsDevPeek.fetchedAt || null,
    stale: modelsDevPeek.fetchedAt ? Date.now() - modelsDevPeek.fetchedAt > 24 * 60 * 60 * 1000 : null,
    providers: modelsDevPeek.catalog ? Object.keys(modelsDevPeek.catalog).length : 0,
  };

  const syncProviders = Array.isArray(settings?.catalogSyncProviders)
    ? settings.catalogSyncProviders.filter((provider) => typeof provider === "string" && provider.trim())
    : [];

  return {
    asOf: new Date().toISOString(),
    sources,
    catalogSync: { providers: syncProviders },
    providers: buildProviderDirectory({ rows, connections, nodes, activeAliases }),
    models,
    totals: {
      models: models.length,
      pairs: rows.length,
      disabled: rows.filter((row) => row.disabled).length,
      missingPrices: rows.filter((row) => !Object.keys(row.pricing).length).length,
      missingCachePrices: rows.filter((row) => row.pricingSource.fallbacks.cached === "input").length,
      withWarnings: rows.filter((row) => row.pricingSource.warnings.length > 0).length,
    },
  };
}

export const __test__ = { providerDisplay, summarizeSources, findModelsDevRate };