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
  // `experientiallabs` keeps the vendor-prefixed ids a tool may have learned
  // from /api/v1/models (`experientiallabs/<slug>`) routable: the prefix
  // resolves to this provider and the slug is forwarded untouched.
  aliases: ["exp", "xpl", "experientiallabs"],
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
  // Plan presets for the RPM picker in Edit Connection. Only the free core
  // allowance is published by the platform (10 requests/min and 250k tokens/min
  // PER MODEL, 1M tokens/day shared), so paid plans are the user's own value.
  rateLimitPresets: [
    {
      id: "free-core",
      label: "Free core — 10 rpm per model",
      rpm: 10,
      perModel: true,
      note: "Published free allowance: 10 requests/min and 250k tokens/min per model, 1M tokens/day shared across them.",
    },
    { id: "off", label: "No local limit", rpm: 0, perModel: true },
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
