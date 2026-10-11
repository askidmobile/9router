// Import a provider's own model catalog into the local overrides.
//
// Shared by the dashboard button (POST /api/providers/import-models) and the
// scheduled sync, so both write the same shapes and report the same source.
// The provider's /v1/models is the authority: it carries the price actually
// charged on this key (aggregator discounts included) plus per-model limits and
// capabilities. models.dev lags behind and does not list every aggregator.

import {
  getProviderConnectionById, getProviderConnections,
  addCustomModelsBulk, updatePricing, setCapsOverridesBulk,
} from "@/lib/db/index.js";
import { getProviderModels as getModelsDevProviderModels } from "@/lib/modelsDev/index.js";
import {
  getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";
import { getRegistryEntry, deriveModelsEndpoint, parseOpenAIStyleModels } from "@/lib/providerModels/deriveModelsEndpoint.js";
import { catalogMetadata } from "./metadata.js";

export const VALID_TARGETS = ["pricing", "caps"];
// Same ceiling the bulk-add route enforces; a runaway catalog must not write
// thousands of rows in one pass.
const MAX_REGISTERED_MODELS = 500;

function catalogRequest(connection) {
  if (isOpenAICompatibleProvider(connection.provider)) {
    const baseUrl = connection.providerSpecificData?.baseUrl;
    if (!baseUrl) return null;
    return { url: `${baseUrl.replace(/\/$/, "")}/models`, headers: { Authorization: `Bearer ${connection.apiKey}` } };
  }
  if (isAnthropicCompatibleProvider(connection.provider)) {
    const baseUrl = (connection.providerSpecificData?.baseUrl || "").replace(/\/$/, "").replace(/\/messages$/, "");
    if (!baseUrl) return null;
    return {
      url: `${baseUrl}/models`,
      headers: { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", Authorization: `Bearer ${connection.apiKey}` },
    };
  }
  const endpoint = deriveModelsEndpoint(getRegistryEntry(connection.provider));
  if (!endpoint) return null;
  const token = connection.accessToken || connection.apiKey;
  return { url: endpoint.url, headers: token ? { Authorization: `Bearer ${token}` } : {} };
}

/** Fetch the provider's own listing, or null when it publishes none. */
export async function resolveProviderCatalog(connection) {
  const request = catalogRequest(connection);
  if (!request) return null;
  const res = await fetch(request.url, {
    headers: { "Content-Type": "application/json", Accept: "application/json", ...request.headers },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Provider /models responded ${res.status}`);
  const models = parseOpenAIStyleModels(await res.json());
  return models.length ? { models, source: "provider" } : null;
}

/**
 * Write one provider's catalog as overrides (and optionally register every
 * imported id as a selectable model).
 *
 * @param {object} params
 * @param {object} params.connection - provider connection (apiKey/accessToken)
 * @param {string[]} [params.targets] - "pricing" | "caps"
 * @param {boolean} [params.registerModels] - also add ids to the model list
 * @returns {Promise<{provider: string, source: string, models?: number, pricing?: object, caps?: object, registered?: object, warning?: string}>}
 */
export async function importProviderCatalog({ connection, targets = VALID_TARGETS, registerModels = false }) {
  const alias = getProviderAlias(connection.provider) || connection.provider;
  const wanted = targets.filter((t) => VALID_TARGETS.includes(t));
  if (wanted.length === 0) throw new Error("No valid targets; expected pricing and/or caps");

  let entries = null;
  let source = null;
  let warning = null;
  try {
    const catalog = await resolveProviderCatalog(connection);
    if (catalog) {
      entries = catalog.models;
      source = catalog.source;
    }
  } catch (error) {
    // A provider that refuses its own listing is not a failure of the import:
    // fall through to models.dev and say why.
    warning = error.message;
  }

  if (!entries) {
    const fallback = await getModelsDevProviderModels([alias, connection.provider]);
    if (!fallback.modelsDevId || !fallback.models) {
      // Name the provider's own failure too: "not on models.dev" alone hides a
      // 401 from an expired key behind a catalog that was never the problem.
      const why = warning ? `the provider catalog failed (${warning})` : "the provider publishes none";
      throw Object.assign(
        new Error(`No model catalog available for ${alias}: ${why} and it is not on models.dev`),
        { notFound: true }
      );
    }
    const response = { provider: alias, source: "models.dev", modelsDevId: fallback.modelsDevId, stale: fallback.stale };
    if (warning) response.warning = warning;
    if (wanted.includes("pricing")) {
      const pricing = {};
      for (const [id, model] of Object.entries(fallback.models)) if (model.pricing) pricing[id] = model.pricing;
      if (Object.keys(pricing).length) await updatePricing({ [alias]: pricing });
      response.pricing = { imported: Object.keys(pricing).length };
    }
    if (wanted.includes("caps")) {
      const caps = {};
      for (const [id, model] of Object.entries(fallback.models)) caps[id] = model.caps;
      if (Object.keys(caps).length) await setCapsOverridesBulk(alias, caps);
      response.caps = { imported: Object.keys(caps).length };
    }
    if (registerModels) {
      const ids = Object.keys(fallback.models).slice(0, MAX_REGISTERED_MODELS);
      response.registered = await addCustomModelsBulk({ providerAlias: alias, type: "llm", ids });
    }
    return response;
  }

  const pricing = {};
  const caps = {};
  const ids = [];
  for (const entry of entries) {
    const meta = catalogMetadata(entry);
    if (!meta) continue;
    ids.push(meta.id);
    if (meta.pricing) pricing[meta.id] = meta.pricing;
    if (meta.caps) caps[meta.id] = meta.caps;
  }
  if (wanted.includes("pricing") && Object.keys(pricing).length) {
    await updatePricing({ [alias]: pricing });
  }
  if (wanted.includes("caps") && Object.keys(caps).length) {
    await setCapsOverridesBulk(alias, caps);
  }
  const response = {
    provider: alias,
    source,
    models: entries.length,
    ...(warning ? { warning } : {}),
    ...(wanted.includes("pricing") ? { pricing: { imported: Object.keys(pricing).length } } : {}),
    ...(wanted.includes("caps") ? { caps: { imported: Object.keys(caps).length } } : {}),
  };
  if (registerModels) {
    response.registered = await addCustomModelsBulk({
      providerAlias: alias, type: "llm", ids: ids.slice(0, MAX_REGISTERED_MODELS),
    });
  }
  return response;
}

/** Resolve a connection by id, by provider id/alias, or a no-auth registry entry. */
export async function findImportConnection({ connectionId, provider }) {
  if (connectionId) {
    const byId = await getProviderConnectionById(connectionId);
    if (byId) return byId;
  }
  if (!provider) return null;
  const alias = getProviderAlias(provider) || provider;
  const connections = await getProviderConnections();
  const active = connections.find((c) =>
    (c.provider === provider || c.provider === alias
      || getProviderAlias(c.provider) === alias || c.providerSpecificData?.prefix === provider)
    && c.isActive !== false
  );
  if (active) return active;
  // Only a no-auth provider can be listed without a connection: for anything
  // else the request would go out unauthenticated and come back 401.
  const entry = getRegistryEntry(alias);
  if (entry?.transport?.noAuth) {
    return { id: null, provider: alias, apiKey: null, accessToken: null, providerSpecificData: {} };
  }
  return null;
}
