import { makeKv } from "../db/helpers/kvStore.js";
import { catalogMetadata } from "../providerCatalog/metadata.js";
import { createModelMatcher } from "./identity.js";
import { MANUFACTURER_MODELS } from "./manufacturer.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const TTL_MS = 12 * 60 * 60 * 1000;
const kv = makeKv("modelSources");
let pending;

export async function getSupplementaryCatalog() {
  if (pending) return pending;
  pending = (async () => {
    const stored = await kv.get("openrouter");
    if (stored?.models?.length && Date.now() - stored.fetchedAt < TTL_MS) return { ...stored, stale: false };
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
      if (stored?.models?.length) return { ...stored, stale: true };
      throw error;
    }
  })();
  try { return await pending; } finally { pending = undefined; }
}

export function supplementaryMetadata(ids, catalog) {
  const result = {};
  const matchCatalog = createModelMatcher(catalog?.models || []);
  const matchDocuments = createModelMatcher(MANUFACTURER_MODELS);
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
    if (documented) for (const document of documented.model.documents) {
      Object.assign(caps, document.caps);
      for (const field of Object.keys(document.caps)) sources[field] = {
        source: "manufacturer-docs", url: document.url, modelId: documented.model.id, match: documented.match,
        updatedAt: document.reviewedAt, snapshot: true, verified: false,
      };
    }
    if (Object.keys(caps).length) result[id] = { caps, sources };
  }
  return result;
}

export async function getSupplementaryMetadata(ids) {
  let catalog, warning;
  try { catalog = await getSupplementaryCatalog(); }
  catch (error) { warning = error.message; }
  return { models: supplementaryMetadata(ids, catalog), warning };
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

