// UnoRouter — OpenAI-compatible router across 50+ vendors. The public catalog
// (`/api/pricing/catalog`) publishes the discounted per-1M price actually
// charged, plus tags (Reasoning/Tools/Vision/Cache) and endpoint support; the
// key-authenticated `/v1/models` adds context_length and max_output_tokens.
// Import Models merges both (open-sse/services/unorouter.js).
export default {
  id: "unorouter",
  priority: 120,
  alias: "unorouter",
  aliases: ["uno"],
  uiAlias: "uno",
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  hasFree: true,
  display: {
    name: "UnoRouter",
    icon: "route",
    color: "#6D5EFC",
    textIcon: "URO",
    website: "https://unorouter.com/en",
    notice: {
      text: "UnoRouter — one OpenAI-compatible endpoint over 50+ providers. Prices are live per-provider discounts (USD per 1M tokens); Import Models writes the current rates, context windows and capabilities. Ids ending in :free never charge but are capped at 1 request/min per model.",
      apiKeyUrl: "https://unorouter.com/en/token",
    },
  },
  transport: {
    baseUrl: "https://api.unorouter.com/v1/chat/completions",
    // /v1/models is public, so a models request cannot tell a bad key from a
    // good one. The token usage endpoint is key-scoped and answers 401 for a
    // missing/invalid credential.
    validateUrl: "https://api.unorouter.com/api/usage/token/",
    // Every model is served over the OpenAI wire; reasoning is reasoning_effort.
    thinkingFormat: "openai",
    // 503 get_channel_failed means every provider for the model is briefly
    // rate limited — documented as retryable. 429 on :free is per-model 1 rpm.
    retry: { 429: 2, 503: 2 },
  },
  // 239 models in the live catalog; any id is forwarded untouched and the list
  // below is a UI seed (limits read from /v1/models on 2026-11-05).
  passthroughModels: true,
  models: [
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", contextLength: 1000000, maxOutputTokens: 131072 },
    { id: "glm-5.3", name: "GLM 5.3", contextLength: 1000000, maxOutputTokens: 943718 },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash (Vision)", contextLength: 1000000, maxOutputTokens: 943718 },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro (Vision)", contextLength: 1000000, maxOutputTokens: 943718 },
    { id: "gemini-4-argon", name: "Gemini 4 Argon", contextLength: 1000000, maxOutputTokens: 943718 },
    { id: "gemini-3-pro", name: "Gemini 3 Pro", contextLength: 1000000, maxOutputTokens: 64000 },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextLength: 1000000, maxOutputTokens: 65536 },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextLength: 1000000, maxOutputTokens: 65535 },
    { id: "gpt-6-astra", name: "GPT-6 Astra", contextLength: 1100000, maxOutputTokens: 128000 },
    { id: "claude-opus-4-8-thinking", name: "Claude Opus 4.8 Thinking", contextLength: 1000000, maxOutputTokens: 128000 },
    { id: "claude-opus-5[1m]", name: "Claude Opus 5 (1M)" },
    { id: "claude-opus-4.7[1m]", name: "Claude Opus 4.7 (1M)" },
    { id: "grok-4.6", name: "Grok 4.6", contextLength: 500000, maxOutputTokens: 128000 },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", contextLength: 1000000, maxOutputTokens: 131072 },
    { id: "qwen2.5-vl-72b-instruct:free", name: "Qwen2.5 VL 72B (Free)", contextLength: 32000, maxOutputTokens: 32000 },
    { id: "agnes-2.5-flash:free", name: "Agnes 2.5 Flash (Free)", contextLength: 512000, maxOutputTokens: 65500 },
    { id: "glm-5.3-flash-think-search:free", name: "GLM 5.3 Flash Think+Search (Free)", contextLength: 1000000, maxOutputTokens: 943717 },
    { id: "minimax-m3.1-flash:free", name: "MiniMax M3.1 Flash (Free)", contextLength: 1000000 },
  ],
  features: { usage: true, usageApikey: true },
};
