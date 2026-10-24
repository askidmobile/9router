export default {
  id: "respan",
  alias: "respan",
  aliases: ["rs"],
  uiAlias: "rs",
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  display: {
    name: "Respan",
    icon: "alt_route",
    color: "#F55656",
    textIcon: "RS",
    website: "https://www.respan.ai",
    notice: {
      text: "Respan Gateway — OpenAI-compatible router across OpenAI, Anthropic, DeepSeek and more, with fallbacks, caching and load balancing. API key from the platform dashboard (Gateway › API keys).",
      apiKeyUrl: "https://platform.respan.ai",
    },
  },
  transport: {
    baseUrl: "https://api.respan.ai/api/chat/completions",
    validateUrl: "https://api.respan.ai/api/models/list/",
  },
  // Catalog spans hundreds of upstream models (`provider/model` ids, e.g.
  // azure/gpt-6-luna); any id is forwarded untouched, the list below is a UI seed.
  passthroughModels: true,
  models: [
    { id: "azure/gpt-6-luna", name: "GPT-6 Luna (Azure via Respan)", contextLength: 1050000 },
    { id: "azure/gpt-5.5", name: "GPT-5.5 (Azure via Respan)", contextLength: 1050000 },
    { id: "azure/gpt-5.4-pro", name: "GPT-5.4 Pro (Azure via Respan)", contextLength: 1050000 },
    { id: "azure/gpt-5.1-codex-max", name: "GPT-5.1 Codex Max (Azure via Respan)", contextLength: 400000 },
    { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5 (via Respan)", contextLength: 1000000 },
    { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5 (via Respan)", contextLength: 1000000 },
    { id: "anthropic/claude-haiku-5-5", name: "Claude Haiku 5.5 (via Respan)", contextLength: 1000000 },
    { id: "azure_deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (Azure via Respan)", contextLength: 1000000 },
  ],
};
