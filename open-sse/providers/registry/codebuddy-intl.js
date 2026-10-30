// CodeBuddy international (codebuddy.ai) — mirrors codebuddy-cn registry shape,
// swapping the Tencent CN domain for the .ai endpoint set. All OAuth/plugin URLs
// use the /v2/plugin prefix with platform=ide (CN uses platform=CLI).
export default {
  id: "codebuddy-intl",
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      signupUrl: "https://www.codebuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  // The gateway publishes no model catalog: /v2/models (and every plausible
  // variant) answers 404 on both www.codebuddy.ai and www.workbuddy.ai, while
  // chat and billing work on either host. Without this flag the models route
  // derives `<baseUrl>/models`, so the dashboard showed an "Import Models"
  // button that could only ever fail. The static `models` list below is the
  // contract.
  noModelsList: true,
  transport: {
    // Chat gateway is OpenAI-compatible SSE (same /v2/chat/completions path as CN).
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    // CodeBuddy intl speaks the same unified OpenAI reasoning_effort shape as CN.
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "IDE",
      "X-IDE-Name": "IDE",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      // Channel check requires the plugin's request/conversation ids — without
      // them upstream rejects with 400 / 11128 "request illegal".
      hooks: ["codebuddyHeaders"],
    },
    // Intl billing endpoint mirrors CN shape (data.Response.Data.Accounts[]).
    usage: {
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  // Same model lineup exposed by the CN gateway — intl backend is the same catalog.
  // Verified live against https://www.workbuddy.ai/v2/chat/completions (the same
  // backend as codebuddy.ai — both hosts answer identically) on 2026-10-30.
  // Working ids return a real SSE stream; the ones dropped below answer
  // 11102 "model service info not found" and would only produce dead cards.
  models: [
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM-5.1" },
    { id: "glm-5.0", name: "GLM-5.0" },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "minimax-m3", name: "MiniMax-M3" },
    { id: "kimi-k2.5", name: "Kimi-K2.5" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview" },
    { id: "hy3", name: "Hy3" },
    { id: "hy4-preview", name: "Hy4-Preview" },
    // Drop log (11102 "model service info not found" on the live gateway):
    // glm-5.0-turbo, glm-4.7, minimax-m2.7, kimi-k3-1, hy3-preview,
    // deepseek-v4-pro, deepseek-v4-flash, deepseek-v3-2-volc.
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
  ],
  oauth: {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
