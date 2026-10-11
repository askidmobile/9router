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
export function catalogMetadata(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  // Media entries (video/image generation) bill per unit, carry no context
  // window, and would otherwise land in the LLM list with invented caps.
  if (typeof entry.type === "string" && !["text", "llm"].includes(entry.type)) return null;

  const caps = {};
  const context = positiveInt(entry.context_length ?? entry.limit?.context ?? entry.limits?.context);
  const output = positiveInt(entry.max_output_tokens ?? entry.limit?.output ?? entry.limits?.output);
  if (context) caps.contextWindow = context;
  if (output) caps.maxOutput = output;
  const declared = entry.capabilities;
  if (declared && typeof declared === "object") {
    for (const [from, to] of CAP_SOURCES) {
      if (typeof declared[from] === "boolean") caps[to] = declared[from];
    }
  }

  const price = entry.pricing;
  const pricing = {};
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

  return {
    id,
    caps: Object.keys(caps).length ? caps : null,
    pricing: Object.keys(pricing).length ? pricing : null,
  };
}
