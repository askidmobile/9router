// Experiential Labs — OpenAI-compatible gateway in front of an org's model
// catalog: hosted provider rungs, the org's own BYOK keys and Experiential
// Cloud. A request names a bare catalog slug (`deepseek-v4.1-flash-1017`) and
// the gateway resolves it through the model's provider waterfall, failing over
// on capacity/transport errors. Zero markup on either billing lane.
export default {
  id: "experiential",
  features: { usage: true, usageApikey: true },
  priority: 130,
  alias: "experiential",
  // NOTE: no "experientiallabs" alias. It looks like a natural spelling (the
  // vendor-prefixed ids from /api/v1/models use it), but a user-defined
  // provider NODE already carries that prefix, and getModelInfo() checks
  // reserved prefixes before looking nodes up — adding it here makes the node
  // unroutable and every `<prefix>/model` request lands on this provider
  // instead. Migrate such a node to this provider rather than shadowing it.
  aliases: ["exp", "xpl"],
  uiAlias: "experiential",
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  display: {
    name: "Experiential Labs",
    icon: "blur_on",
    color: "#0A0A0A",
    textIcon: "EX",
    website: "https://platform.experientiallabs.ai",
    notice: {
      text: "One gateway in front of Anthropic, OpenAI, Gemini, DeepSeek and more, with a per-model provider waterfall and zero markup: BYOK keys bill through the provider, platform credits at catalog price. Free core covers GPT-6 Luna, DeepSeek V4.1 Flash and Clef at 10 requests/min and 250k tokens/min per model. Model ids are catalog slugs (bare or vendor-prefixed); /v1/models lists this org's callable set.",
      apiKeyUrl: "https://platform.experientiallabs.ai/settings/api-keys",
      signupUrl: "https://platform.experientiallabs.ai",
    },
  },
  transport: {
    baseUrl: "https://api.experientiallabs.ai/v1/chat/completions",
    validateUrl: "https://api.experientiallabs.ai/v1/models",
    // 429 org_rate_limit / org_token_rate_limit clears on its own and carries
    // Retry-After; retrying in place beats failing the request over.
    retry: { 429: 2 },
  },
  passthroughModels: true,
  // Plan ceilings from the account's plan page (Settings > Plans, "Rate limits
  // by plan"). They are ORGANIZATION-wide requests/min and tokens/min, so the
  // presets meter the whole connection (perModel:false) — a single key is the
  // whole org for most setups. Model-specific allowances sit on top and remain
  // the platform's business; they are not additive to these ceilings.
  rateLimitPresets: [
    {
      id: "free",
      label: "Free",
      rpm: 240,
      tpm: 4_000_000,
      perModel: false,
      note: "Free base ceiling: 240 requests/min, 4M tokens/min. Free-core models (GPT-6 Luna, DeepSeek V4.1 Flash, Clef) are additionally capped at 10 requests/min and 250k tokens/min PER MODEL with 1M tokens/day shared.",
    },
    {
      id: "pro",
      label: "Pro (Tier 2)",
      rpm: 1500,
      tpm: 25_000_000,
      perModel: false,
      note: "Pro Tier 2: 1,500 requests/min, 25M tokens/min. Organization-wide.",
    },
    {
      id: "max",
      label: "Max (Tier 3)",
      rpm: 6000,
      tpm: 100_000_000,
      perModel: false,
      note: "Max Tier 3: 6,000 requests/min, 100M tokens/min. Organization-wide.",
    },
    {
      id: "ultra",
      label: "Ultra (Tier 4)",
      rpm: 10_000,
      tpm: 150_000_000,
      perModel: false,
      note: "Ultra Tier 4: 10,000 requests/min, 150M tokens/min. Organization-wide.",
    },
    { id: "off", label: "No local limit", rpm: 0, perModel: false },
  ],
  // Seed list; the gateway's own catalog is larger and every id is forwarded
  // as-is. Prices are the platform-funded catalog rates (USD per 1M tokens).
  models: [
    { id: "gpt-6-luna", name: "GPT-6 Luna", contextLength: 1050000, maxOutputTokens: 128000 },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", contextLength: 1050000, maxOutputTokens: 128000 },
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", contextLength: 1048576, maxOutputTokens: 393216 },
    { id: "deepseek-v4.1-flash-uncensored", name: "DeepSeek V4.1 Flash 1017 Uncensored", contextLength: 1048576, maxOutputTokens: 393216 },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", contextLength: 1000000, maxOutputTokens: 128000 },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", contextLength: 1000000, maxOutputTokens: 128000 },
    { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", contextLength: 1000000, maxOutputTokens: 128000 },
    { id: "gemini-4-argon", name: "Gemini 4 Argon", contextLength: 1048576, maxOutputTokens: 32768 },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextLength: 1048576, maxOutputTokens: 65536 },
    { id: "glm-5.3", name: "GLM 5.3", contextLength: 1048576, maxOutputTokens: 131072 },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextLength: 1048576, maxOutputTokens: 131072 },
    { id: "kimi-k3", name: "Kimi K3", contextLength: 1048576 },
    { id: "clef", name: "Clef", contextLength: 262144 },
    { id: "clef-flash", name: "Clef Flash", contextLength: 65536 },
    { id: "muse-wonder-1.0", name: "Muse Wonder", contextLength: 1048576, maxOutputTokens: 1048576 },
  ],
};
