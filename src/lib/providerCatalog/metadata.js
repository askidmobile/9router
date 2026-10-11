import { REASONING_EFFORT_LEVELS } from "open-sse/providers/thinkingLevels.js";

// Map a provider's own /v1/models entry into 9router's caps + pricing shapes.
//
// Aggregators publish everything the dashboard needs in one listing: token
// limits (context_length / max_output_tokens), capabilities (vision, video,
// reasoning, image_generation) and the price actually charged
// (pricing.*_per_million, as strings). models.dev lags behind these numbers and
// does not list every aggregator at all, so the provider's own catalog wins
// when it carries this metadata.
//
// Field names mirror open-sse/providers/capabilities.js and
// open-sse/providers/pricing.js: caps are booleans/ints, pricing is $ per 1M.
const CAP_SOURCES = [
  ["vision", "vision"],
  ["pdf", "pdf"],
  ["reasoning", "reasoning"],
  ["audio", "audioInput"],
  ["video", "videoInput"],
  ["image_generation", "imageOutput"],
  // Flat-only: Requesty spells these supports_tool_calling / supports_web_search.
  ["tools", "tools", "tool_calling"],
  ["search", "search", "web_search"],
];

// "1.650000" → 1.65. Anything non-finite or negative is treated as absent so a
// broken listing can never publish a bogus price.
function toNumber(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function positiveInt(value) {
  const n = toNumber(value);
  return n !== undefined && n > 0 ? Math.floor(n) : undefined;
}

/**
 * @param {object} entry - one model from GET /v1/models
 * @returns {{ id: string, caps: object|null, pricing: object|null }|null}
 */
// Each provider names the same numbers differently. All three known catalogs
// are handled here by detection rather than configuration, so a new provider
// only needs its own field names added to the candidate lists below.
//   limits   CheapInference/APInex/Requesty
//   prices   `pricing.*_per_million` (per 1M), `dollarsPer1M` (per 1M, flat),
//            `input_price`/`output_price`/`cached_price` (per token)
const PER_MILLION = 1_000_000;

// "1M" / "500K" / 200000 → tokens
export function parseTokenCount(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  if (typeof value !== "string") return undefined;
  const m = value.trim().match(/^([\d.]+)\s*([MK])?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] || "").toUpperCase();
  return Math.round(n * (unit === "M" ? 1_000_000 : unit === "K" ? 1_000 : 1));
}

function perToken(value) {
  const n = toNumber(value);
  return n === undefined ? undefined : n * PER_MILLION;
}

/**
 * @param {object} entry - one model from a provider's catalog
 * @returns {{ id: string, caps: object|null, pricing: object|null }|null}
 */
export function catalogMetadata(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  // Media entries (video/image generation) bill per unit, carry no context
  // window, and would otherwise land in the LLM list with invented caps.
  if (typeof entry.type === "string" && !["text", "llm"].includes(entry.type)) return null;

  const caps = {};
  const context = parseTokenCount(
    entry.context_length ?? entry.context_window ?? entry.contextWindow ?? entry.limit?.context ?? entry.limits?.context,
  );
  const output = parseTokenCount(
    entry.max_output_tokens ?? entry.maxOutputTokens ?? entry.max_completion_tokens ?? entry.top_provider?.max_completion_tokens ?? entry.limit?.output ?? entry.limits?.output,
  );
  if (context) caps.contextWindow = context;
  if (output) caps.maxOutput = output;

  // Nested `capabilities` booleans (CheapInference/APInex) or Requesty's flat
  // `supports_*` flags. Absent flags stay absent: a false must not be invented.
  const declared = entry.capabilities;
  for (const [from, to, flatName] of CAP_SOURCES) {
    const nested = declared && typeof declared === "object" ? declared[from] : undefined;
    const flat = entry[`supports_${flatName || from}`];
    if (typeof nested === "boolean") caps[to] = nested;
    else if (typeof flat === "boolean") caps[to] = flat;
  }

  const rawLevels = entry.reasoning_levels ?? entry.reasoningLevels ?? entry.supported_reasoning_levels
    ?? entry.reasoning_effort_options ?? entry.supported_reasoning_efforts ?? entry.reasoning_efforts
    ?? entry.parameters?.reasoning_effort?.enum ?? declared?.reasoning_levels ?? declared?.reasoning?.efforts
    ?? (entry.reasoningEfforts && typeof entry.reasoningEfforts === "object" ? Object.keys(entry.reasoningEfforts) : undefined);
  const levels = normalizeReasoningLevels(rawLevels);
  if (levels !== undefined) {
    caps.reasoningLevels = levels;
    if (caps.reasoning === undefined && levels.length) caps.reasoning = true;
  }
  const format = entry.thinking_format ?? declared?.thinking_format;
  if (typeof format === "string" && format.trim()) caps.thinkingFormat = format.trim();

  const pricing = {};
  const price = entry.pricing;
  if (price && typeof price === "object") {
    const input = toNumber(price.input_per_million ?? price.input);
    const outputPrice = toNumber(price.output_per_million ?? price.output);
    const cached = toNumber(price.cache_read_input_per_million ?? price.cached);
    const cacheCreation = toNumber(price.cache_write_input_per_million ?? price.cache_creation);
    if (input !== undefined) pricing.input = input;
    if (outputPrice !== undefined) pricing.output = outputPrice;
    if (cached !== undefined) pricing.cached = cached;
    if (cacheCreation !== undefined) pricing.cache_creation = cacheCreation;
  }
  // A single published rate covers both directions (APInex: "flat price … the
  // same rate for input and output").
  const flat = toNumber(entry.dollarsPer1M);
  if (Object.keys(pricing).length === 0 && flat !== undefined) {
    pricing.input = flat;
    pricing.output = flat;
  }
  // Bare per-token rates (Requesty).
  if (Object.keys(pricing).length === 0) {
    const input = perToken(entry.input_price);
    const outputPrice = perToken(entry.output_price);
    const cached = perToken(entry.cached_price);
    if (input !== undefined) pricing.input = input;
    if (outputPrice !== undefined) pricing.output = outputPrice;
    if (cached !== undefined) pricing.cached = cached;
  }

  return {
    id,
    caps: Object.keys(caps).length ? caps : null,
    pricing: Object.keys(pricing).length ? pricing : null,
  };
}

export function normalizeReasoningLevels(value) {
  if (!Array.isArray(value)) return undefined;
  const levels = value.map(level => typeof level === "string" ? level : level?.effort);
  if (levels.some(level => !REASONING_EFFORT_LEVELS.includes(level))) return undefined;
  return REASONING_EFFORT_LEVELS.filter(level => levels.includes(level));
}
