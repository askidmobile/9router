// APInex Bond — wallet-backed aggregator: OpenAI Chat Completions, Anthropic
// Messages and the Responses API on one base URL (all three verified live).
// Prices are flat USD per 1M tokens for input and output alike, published on
// /api/public/models together with a context window; the authenticated
// /v1/models returns the same ids without any metadata.
export default {
  id: "apinex",
  priority: 120,
  alias: "apinex",
  aliases: [
    "apx",
    "apinex-bond",
  ],
  uiAlias: "apinex",
  display: {
    name: "APInex Bond",
    icon: "token",
    color: "#8B5E34",
    textIcon: "AX",
    website: "https://apinex.bond",
    notice: {
      text: "Prepaid token balance across chat models plus /v1/tools (web search, Twitter/X, voice). Billing is a flat price per 1M tokens, the same for input and output; free/* ids cost nothing and share a daily allowance. Model ids are bare (claude-opus-5.5) or free/<model>, and the catalog carries each price and context window.",
      apiKeyUrl: "https://apinex.bond/keys",
      signupUrl: "https://apinex.bond/register",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.apinex.bond/v1/chat/completions",
    validateUrl: "https://api.apinex.bond/v1/models",
    retry: {
      429: 2,
    },
  },
  transports: [
    { format: "openai", baseUrl: "https://api.apinex.bond/v1/chat/completions" },
    { format: "openai-responses", baseUrl: "https://api.apinex.bond/v1/responses" },
    { format: "claude", baseUrl: "https://api.apinex.bond/v1/messages" },
  ],
  // Curated seed of ids verified in the live catalog (both paid and free).
  models: [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "free/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (Free)" },
    { id: "free/kimi-k3", name: "Kimi K3 (Free)" },
    { id: "free/minimax-m3.1", name: "MiniMax M3.1 (Free)" },
    { id: "free/mimo-v2.6-pro", name: "MiMo V2.6 Pro (Free)" },
    { id: "free/muse-spark-1.3", name: "Muse Spark 1.3 (Free)" },
  ],
  // Their /v1/models carry no metadata, so the catalog the importer reads is
  // the public one (see providerCatalog/sources.js).
  modelsFetcher: { url: "https://apinex.bond/api/public/models", type: "apinex" },
  passthroughModels: true,
};
