import { makeKv } from "../db/helpers/kvStore.js";
import { catalogMetadata } from "../providerCatalog/metadata.js";
import { createModelMatcher } from "./identity.js";
import { getManufacturerCatalog } from "./manufacturer.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const kv = makeKv("modelSources");
let pending;

export async function getSupplementaryCatalog({ refresh = false } = {}) {
  if (!refresh) return await kv.get("openrouter") || { models: [] };
  if (pending) return pending;
  pending = (async () => {
    const stored = await kv.get("openrouter");
    try {
      const response = await fetch(OPENROUTER_MODELS_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`OpenRouter catalog responded ${response.status}`);
      const body = await response.json();
      const models = body.data?.filter(model => typeof model?.id === "string" && model.id.trim());
      if (!models?.length) throw new Error("OpenRouter catalog contains no models");
      const result = { models, fetchedAt: Date.now() };
      await kv.set("openrouter", result);
      return { ...result, stale: false };
    } catch (error) {
      if (stored?.models?.length) {
        const retained = { ...stored, stale: true };
        await kv.set("openrouter", retained);
        return retained;
      }
      throw error;
    }
  })();
  try { return await pending; } finally { pending = undefined; }
}

export function supplementaryMetadata(ids, catalog, manufacturer = { models: [] }) {
  const result = {};
  const matchCatalog = createModelMatcher(catalog?.models || []);
  const matchDocuments = createModelMatcher(manufacturer.models);
  for (const id of ids) {
    const caps = {}, sources = {};
    const matched = matchCatalog(id);
    if (matched) {
      const model = matched.model;
      Object.assign(caps, catalogMetadata(model)?.caps || {});
      for (const field of Object.keys(caps)) sources[field] = {
        source: "openrouter", url: `https://openrouter.ai/${model.id}`, modelId: model.id, match: matched.match,
        updatedAt: new Date(catalog.fetchedAt).toISOString(), stale: catalog.stale, verified: false,
      };
    }
    const documented = matchDocuments(id);
    if (documented) {
      Object.assign(caps, documented.model.caps);
      for (const [field, info] of Object.entries(documented.model.sources)) sources[field] = { ...info, match: documented.match };
    }
    if (Object.keys(caps).length) result[id] = { caps, sources };
  }
  return result;
}

export async function getSupplementaryMetadata(ids, { refresh = false } = {}) {
  let catalog, warning;
  try { catalog = await getSupplementaryCatalog({ refresh }); }
  catch (error) { warning = error.message; }
  const manufacturer = await getManufacturerCatalog({ refresh });
  return { models: supplementaryMetadata(ids, catalog, manufacturer), warning: [warning, manufacturer.warning].filter(Boolean).join("; ") || undefined };
}

export function mergeModelCapabilities(primary, supplemental, fallback, additional, alias, updatedAt) {
  const caps = { ...(additional?.caps || {}), ...(supplemental?.caps || {}) };
  const sources = { ...(additional?.sources || {}) };
  for (const field of Object.keys(supplemental?.caps || {})) sources[field] = {
    source: "models.dev", provider: supplemental.modelsDevId || fallback.modelsDevId,
    modelId: supplemental.id, url: "https://models.dev", match: supplemental.match || "exact",
    updatedAt: new Date(supplemental.fetchedAt || fallback.fetchedAt || Date.now()).toISOString(),
    stale: supplemental.stale ?? fallback.stale ?? false, verified: false,
  };
  for (const [field, info] of Object.entries(additional?.sources || {})) if (info.source === "manufacturer-docs") {
    caps[field] = additional.caps[field];
    sources[field] = info;
  }
  Object.assign(caps, primary || {});
  for (const field of Object.keys(primary || {})) sources[field] = { source: "provider", provider: alias, updatedAt, verified: true };
  return { caps, sources };
}

