import { RESPAN_MODELS_URL } from "../config/respan.js";

// Respan's model catalog is a paginated POST listing, not an OpenAI-style
// GET /models: each page carries `results` with `model_name` ids (already
// `vendor/model` shaped) plus costs, context window and supported params.
// Rows are mapped into the generic catalog shapes consumed by
// catalogMetadata() (context_length / supported_parameters / pricing.*_per_million).

const ACTIVE_STATUSES = new Set(["active", "beta", "preview"]);

// Respan lists costs as dollars per 1M tokens (unit "token", "per 1M" on the
// pricing page) — the same unit the dashboard stores. Negative means "not
// offered" (e.g. cache costs on models without caching).
function perMillion(cost, unit) {
  const n = typeof cost === "string" ? Number(cost) : cost;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  if (unit && unit !== "token") return undefined;
  return n;
}

/**
 * Map one Respan listing row into the provider-catalog entry shape.
 * Returns null for rows that are not selectable chat models.
 */
export function normalizeRespanModel(row) {
  const id = typeof row?.model_name === "string" ? row.model_name.trim() : "";
  if (!id) return null;
  if (typeof row.status === "string" && !ACTIVE_STATUSES.has(row.status)) return null;
  if (row.model_type && !["text", "chat", "llm"].includes(String(row.model_type))) return null;

  const caps = {};
  if (row.capability?.function_call === true) caps.tools = true;
  if (row.image_support === true || row.capability?.vision === true) caps.vision = true;

  const pricing = {};
  const input = perMillion(row.input_cost, row.input_price_unit);
  const output = perMillion(row.output_cost, row.output_price_unit);
  const cached = perMillion(row.cache_hit_input_cost);
  const cacheCreation = perMillion(row.cache_creation_input_cost);
  if (input !== undefined) pricing.input_per_million = input;
  if (output !== undefined) pricing.output_per_million = output;
  if (cached !== undefined) pricing.cache_read_input_per_million = cached;
  if (cacheCreation !== undefined) pricing.cache_write_input_per_million = cacheCreation;

  const params = row.supported_params;
  const supported = params && typeof params === "object" && !Array.isArray(params)
    ? Object.keys(params)
    : [];

  return {
    id,
    name: id,
    ...(Number.isFinite(row.max_context_window) && row.max_context_window > 0
      ? { contextLength: Math.floor(row.max_context_window), context_length: Math.floor(row.max_context_window) }
      : {}),
    ...(supported.length ? { supported_parameters: supported } : {}),
    ...(Object.keys(caps).length ? { capabilities: caps } : {}),
    ...(Object.keys(pricing).length ? { pricing } : {}),
  };
}

/**
 * Fetch the full Respan catalog (all pages) and normalize it.
 *
 * The listing paginates through `next` links (GET): re-POSTing with page=N
 * silently returns page 1 again, so only the first page goes through POST.
 *
 * @param {{ apiKey?: string }} [connection] - provider connection (optional:
 *        the listing is public; a key widens it with org-custom models)
 * @returns {Promise<{ models: Array<object> }>}
 */
export async function resolveRespanModels(connection) {
  const headers = { "Content-Type": "application/json" };
  if (connection?.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;

  const byId = new Map();
  // 1500 rows today at 100 per page; a runaway catalog must not loop forever.
  const MAX_PAGES = 30;
  let url = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = page === 1
      ? await fetch(RESPAN_MODELS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ page: 1, page_size: 100, sort_by: "model_name" }),
        signal: AbortSignal.timeout(30000),
      })
      : await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`Respan models listing responded ${response.status}`);
    }
    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const row of results) {
      const normalized = normalizeRespanModel(row);
      if (normalized) byId.set(normalized.id, normalized);
    }
    url = data?.next;
    if (!url) break;
  }
  return { models: [...byId.values()] };
}
