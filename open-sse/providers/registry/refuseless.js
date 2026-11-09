// Refuseless — OpenAI-compatible hosted lineup of refusal-removed
// ("abliterated") open-weight models. The API publishes context windows and
// reasoning levels but no prices, so the rates below come from the public
// /pricing page (Wayback snapshot 2026-10-20) and feed PROVIDER_PRICING;
// Import Models writes them as editable overrides together with caps.
export default {
  id: "refuseless",
  priority: 120,
  alias: "refuseless",
  aliases: ["rfl"],
  uiAlias: "rfl",
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  hasFree: true,
  display: {
    name: "Refuseless",
    icon: "shield",
    color: "#F43F5E",
    textIcon: "RFL",
    website: "https://refuseless.com",
    notice: {
      text: "Refuseless — a named lineup of abliterated open-weight models on one OpenAI-compatible endpoint. Keys start with abl_. Model ids are catalog names (the -free suffix marks the free variant); reasoning_effort accepts off, low, high and max, and which levels a model offers is listed by /v1/models.",
      apiKeyUrl: "https://refuseless.com/console/models",
    },
  },
  transport: {
    baseUrl: "https://api.refuseless.com/v1/chat/completions",
    // /v1/models is public (it cannot validate a key); the credits endpoint
    // answers 401 for a missing/invalid credential.
    validateUrl: "https://api.refuseless.com/v1/credits",
    thinkingFormat: "refuseless",
    // 429 model_busy / model_warming carries retry-after (15s / 30s).
    retry: { 429: 2 },
  },
  // Private models granted to an account surface in /v1/models; forward them.
  passthroughModels: true,
  models: [
    { id: "glm-5.3-abliterated", name: "GLM 5.3 Abliterated", contextLength: 1048576 },
    { id: "glm-5.3-flash-abliterated", name: "GLM 5.3 Flash Abliterated", contextLength: 1048576 },
    { id: "deepseek-v4.1-flash-abliterated", name: "DeepSeek V4.1 Flash Abliterated", contextLength: 1048576 },
    { id: "deepseek-v4.1-flash-fast", name: "DeepSeek V4.1 Flash 1017 (Safeguards)", contextLength: 1048576 },
    { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash", contextLength: 1048576 },
    { id: "deepseek-v4.1-flash-abliterated-free", name: "DeepSeek V4.1 Flash Abliterated (Free)", contextLength: 524288 },
  ],
  features: { usage: true, usageApikey: true },
};
