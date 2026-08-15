export default {
  id: "zai",
  alias: "zai",
  uiAlias: "zai",
  display: {
    name: "Z.AI Coding",
    icon: "bolt",
    color: "#6366f1",
    textIcon: "ZAI",
    website: "https://z.ai",
    notice: {
      apiKeyUrl: "https://z.ai",
      text: "Z.AI Coding plan. Claude-compatible endpoint (Anthropic format).",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.z.ai/api/anthropic/v1/messages?beta=true",
    format: "claude",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "output-128k-2025-02-19,prompt-caching-2024-07-31",
    },
  },
  models: [
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
    { id: "glm-4.7-flash", name: "GLM 4.7 Flash" },
    { id: "glm-4.7", name: "GLM 4.7" },
  ],
  serviceKinds: ["llm"],
};
