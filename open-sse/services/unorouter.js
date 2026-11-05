// UnoRouter catalog: the public pricing endpoint carries the rates actually
// charged (USD per 1M, already discounted) plus capability tags and endpoint
// support; the OpenAI-style /v1/models adds context_length / max_output_tokens.
// Neither listing is complete on its own, so both are fetched and merged.
// Rows are normalized into the generic provider-catalog shape consumed by
// catalogMetadata(): pricing.*_per_million, context_length,
// max_output_tokens, capabilities.*.

const CATALOG_URL = "https://api.unorouter.com/api/pricing/catalog";
const MODELS_URL = "https://api.unorouter.com/v1/models";

// Capability tags used by the pricing catalog.
const TAG_CAPABILITIES = {
  Reasoning: "reasoning",
  Tools: "tools",
  Vision: "vision",
  Audio: "audioInput",
  Video: "videoInput",
  Files: "pdf",
};

// "1M" / "1.0M" / "262.1K" → tokens (the catalog repeats context as a tag).
const CONTEXT_TAG = /^(\d+(?:\.\d+)?)([MK])$/i;

function dollarsPerMillion(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function positiveInt(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function tagList(tags) {
  if (Array.isArray(tags)) return tags;
  return typeof tags === "string" ? tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
}

function contextFromTags(tags) {
  for (const tag of tagList(tags)) {
    const match = tag.match(CONTEXT_TAG);
    if (!match) continue;
    const size = Number(match[1]);
    const unit = match[2].toUpperCase();
    if (Number.isFinite(size) && size > 0) return Math.round(size * (unit === "M" ? 1_000_000 : 1_000));
  }
  return undefined;
}

/**
 * Map one UnoRouter pricing-catalog row into the generic catalog entry shape.
 * Returns null for rows that are not selectable chat models reachable over the
 * OpenAI wire (image/video/embedding, per-call billing, anthropic-only ids).
 *
 * @param {object} row - one entry from /api/pricing/catalog
 * @param {object|null} [limit] - the matching /v1/models entry, if any
 */
export function normalizeUnorouterModel(row, limit = null) {
  const id = typeof row?.model_name === "string" ? row.model_name.trim() : "";
  if (!id) return null;
  if (row.type && row.type !== "text") return null;
  if (row.chat === false) return null;
  // Flat per-call billing (image/video) has no per-token rate to import.
  if (row.is_fixed_price === true) return null;
  const endpoints = row.supported_endpoint_types;
  if (Array.isArray(endpoints) && endpoints.length && !endpoints.includes("openai")) return null;

  const capabilities = {};
  for (const tag of tagList(row.tags)) {
    const capability = TAG_CAPABILITIES[tag];
    if (capability) capabilities[capability] = true;
  }

  const pricing = {};
  const input = dollarsPerMillion(row.input_price);
  const output = dollarsPerMillion(row.output_price);
  if (input !== undefined) pricing.input_per_million = input;
  if (output !== undefined) pricing.output_per_million = output;

  const context = positiveInt(limit?.context_length) ?? contextFromTags(row.tags);
  const maxOutput = positiveInt(limit?.max_output_tokens);

  return {
    id,
    name: id,
    type: "text",
    ...(context ? { context_length: context, contextLength: context } : {}),
    ...(maxOutput ? { max_output_tokens: maxOutput } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    ...(Object.keys(pricing).length ? { pricing } : {}),
  };
}

/**
 * Fetch the UnoRouter catalog (prices + limits) and normalize it.
 *
 * The pricing catalog is public; a key widens /v1/models (which is also public
 * today) but is not required for the rates. A failure of the limits listing is
 * tolerated — prices still import — while a failure of the pricing catalog is
 * the import's failure.
 *
 * @param {{ apiKey?: string, accessToken?: string }} [connection]
 * @returns {Promise<{ models: Array<object> }>}
 */
export async function resolveUnorouterModels(connection = {}) {
  const token = connection?.apiKey || connection?.accessToken;
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const [catalogResponse, modelsResponse] = await Promise.all([
    fetch(CATALOG_URL, { headers, signal: AbortSignal.timeout(30000) }),
    fetch(MODELS_URL, { headers, signal: AbortSignal.timeout(30000) }).catch(() => null),
  ]);
  if (!catalogResponse.ok) {
    throw new Error(`UnoRouter pricing catalog responded ${catalogResponse.status}`);
  }
  const catalog = await catalogResponse.json();

  const limits = new Map();
  if (modelsResponse?.ok) {
    const data = await modelsResponse.json().catch(() => null);
    for (const model of data?.data || []) {
      if (typeof model?.id === "string") limits.set(model.id, model);
    }
  }

  const rows = Array.isArray(catalog?.models) ? catalog.models : (Array.isArray(catalog?.data?.models) ? catalog.data.models : []);
  const byId = new Map();
  for (const row of rows) {
    const normalized = normalizeUnorouterModel(row, limits.get(row?.model_name));
    if (normalized) byId.set(normalized.id, normalized);
  }
  return { models: [...byId.values()] };
}
