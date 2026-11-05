// Cached capability resolution.
//
// getCapabilitiesForModel() walks pattern tables, so resolving every row of an
// 800-model catalog on each request costs real time. Cache by metadata revision
// (see db/helpers/revision.js): every caps write bumps the revision, so an
// import or a manual edit is visible immediately instead of after a restart.

import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { catalogRevision } from "@/lib/db/helpers/revision.js";

let cache = { revision: 0, map: new Map() };

export function resolveCapsCached(provider, model) {
  const revision = catalogRevision();
  if (cache.revision !== revision) cache = { revision, map: new Map() };
  const key = `${provider}|${model}`;
  if (cache.map.has(key)) return cache.map.get(key);
  const caps = getCapabilitiesForModel(provider, model);
  cache.map.set(key, caps);
  return caps;
}

/** Fields the dashboard is allowed to see (mirrors /api/models). */
export const PUBLIC_CAPS_FIELDS = [
  "vision", "search", "reasoning", "tools", "pdf", "imageOutput", "audioInput",
  "contextWindow", "maxOutput",
];

export function pickPublicCaps(caps) {
  const out = {};
  for (const field of PUBLIC_CAPS_FIELDS) {
    if (caps?.[field] !== undefined) out[field] = caps[field];
  }
  return out;
}

/** `{ "provider|model": caps }` deep-merged in precedence order. */
export function mergeCapsLayers(...layers) {
  return layers.reduce((acc, layer) => ({ ...acc, ...(layer || {}) }), {});
}

export const __test__ = { reset: () => { cache = { revision: 0, map: new Map() }; } };