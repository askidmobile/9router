// Requesty — OpenAI-compatible gateway in front of 780+ models with
// pass-through pricing (their docs: "you pay provider prices") and per-request
// cost in the response body. Wire surfaces:
//   /v1/chat/completions  OpenAI Chat Completions
//   /v1/responses         OpenAI Responses
//   /v1/messages          Anthropic Messages, on the /v1 base (the docs' bare
//                         /anthropic/v1/messages path answers 404, verified).
// EU residency customers use router.eu.requesty.ai; the environment cannot know
// which data residency the key belongs to, so the default stays the global host.
export default {
  id: "requesty",
  priority: 120,
  alias: "req",
  aliases: [
    "requesty",
    "requesty-ai",
  ],
  uiAlias: "req",
  display: {
    name: "Requesty",
    icon: "hub",
    color: "#2563EB",
    textIcon: "RQ",
    website: "https://requesty.ai",
    notice: {
      text: "OpenAI-compatible gateway over 780 models with provider pass-through pricing and automatic caching (up to 80% off repeated prompts). Model ids are vendor-qualified (openai/gpt-4o, anthropic/claude-opus-5-5); the live catalog supplies each model's price and limits. EU accounts use router.eu.requesty.ai — set a connection override if your key belongs there.",
      apiKeyUrl: "https://app.requesty.ai/api-keys",
      signupUrl: "https://app.requesty.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://router.requesty.ai/v1/chat/completions",
    validateUrl: "https://router.requesty.ai/v1/models",
    retry: {
      429: 2,
    },
  },
  // Multi-endpoint: no lossy translation when the client already speaks one of
  // these. Retry stays on the entry above — a runtime transport only carries
  // the endpoint, its headers and its auth.
  transports: [
    { format: "openai", baseUrl: "https://router.requesty.ai/v1/chat/completions" },
    { format: "openai-responses", baseUrl: "https://router.requesty.ai/v1/responses" },
    { format: "claude", baseUrl: "https://router.requesty.ai/v1/messages" },
  ],
  // Curated seed of ids verified in the live catalog; anything else passes
  // through and the scheduled catalog import supplies its price and limits.
  models: [
    { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "openai/gpt-6-astra", name: "GPT-6 Astra" },
    { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "vertex/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "sference/kimi-k3", name: "Kimi K3" },
    { id: "runware/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  ],
  modelsFetcher: { url: "https://router.requesty.ai/v1/models", type: "requesty" },
  passthroughModels: true,
};
