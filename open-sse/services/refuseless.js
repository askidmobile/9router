// Refuseless publishes a small OpenAI-style catalog at /v1/models with context
// windows and reasoning levels, but no prices. The normalizer reshapes those
// rows for catalogMetadata() and attaches the static rates from
// PROVIDER_PRICING.refuseless (the public /pricing page keeps the same table:
// input / output / cached, USD per 1M) so Import Models writes them as editable
// overrides as well as feeding runtime cost accounting.

import { PROVIDER_PRICING } from "../providers/pricing.js";

const MODELS_URL = "https://api.refuseless.com/v1/models";

// The API uses "off" to disable reasoning; 9router's level enum spells it
// "none" and the wire normalizer converts it back. Leaving "off" here would make
// normalizeReasoningLevels() drop the whole set.
const LEVEL_ALIASES = { off: "none" };

function positiveInt(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Map one Refuseless /v1/models row into the generic catalog entry shape.
 * @param {object} row
 * @returns {object|null}
 */
export function normalizeRefuselessModel(row) {
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  if (!id) return null;

  const capabilities = {};
  if (row.vision === true) capabilities.vision = true;

  const levels = Array.isArray(row.reasoning_efforts)
    ? row.reasoning_efforts
      .filter((level) => typeof level === "string")
      .map((level) => LEVEL_ALIASES[level] || level)
    : [];

  const context = positiveInt(row.context_length);
  const maxOutput = positiveInt(row.max_output_tokens);

  const rate = PROVIDER_PRICING.refuseless?.[id];
  const pricing = {};
  if (rate) {
    if (Number.isFinite(rate.input)) pricing.input_per_million = rate.input;
    if (Number.isFinite(rate.output)) pricing.output_per_million = rate.output;
    if (Number.isFinite(rate.cached)) pricing.cache_read_input_per_million = rate.cached;
  }

  return {
    id,
    name: id,
    type: "text",
    ...(context ? { context_length: context, contextLength: context } : {}),
    ...(maxOutput ? { max_output_tokens: maxOutput } : {}),
    ...(levels.length ? { reasoning_efforts: levels } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    ...(Object.keys(pricing).length ? { pricing } : {}),
  };
}

/**
 * Fetch the Refuseless lineup. The app accepts the public listing without a
 * key, but Cloudflare's WAF in front of the host challenges anonymous requests
 * (403 HTML) — sending any Authorization header passes the WAF and the app
 * answers 401/200 JSON. In practice the import always has a connection key.
 *
 * @param {{ apiKey?: string, accessToken?: string }} [connection]
 * @returns {Promise<{ models: Array<object> }>}
 */
export async function resolveRefuselessModels(connection = {}) {
  const token = connection?.apiKey || connection?.accessToken;
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(MODELS_URL, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Refuseless models listing responded ${response.status}`);
  const data = await response.json();
  const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);

  const byId = new Map();
  for (const row of rows) {
    const normalized = normalizeRefuselessModel(row);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return { models: [...byId.values()] };
}
