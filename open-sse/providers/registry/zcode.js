const zcodeProvider = {
  id: "zcode",
  alias: "zc",
  uiAlias: "zc",
  display: {
    name: "ZCode CLI",
    icon: "terminal",
    color: "#3F74FB",
    textIcon: "ZC",
    website: "https://z.ai",
    notice: {
      apiKeyUrl: "https://console.z.ai/api-keys",
      text: "Runs the local ZCode CLI app-server (`zcode app-server`). Needs a Z.ai Coding Plan API key and the ZCode CLI installed; model traffic uses Coding Plan quotas.",
    },
  },
  category: "cli",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "zcode://app-server/stdio",
    format: "openai",
  },
  models: [
    { id: "glm-5.3", name: "GLM 5.3", contextLength: 1000000 },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextLength: 1000000 },
    { id: "glm-5.2", name: "GLM 5.2", contextLength: 200000 },
    { id: "glm-5.1", name: "GLM 5.1", contextLength: 204800 },
    { id: "glm-5", name: "GLM 5", contextLength: 128000 },
    { id: "glm-4.7", name: "GLM 4.7", contextLength: 200000 },
    { id: "glm-4.7-flash", name: "GLM 4.7 Flash", contextLength: 128000 },
  ],
  serviceKinds: ["llm"],
};

export default zcodeProvider;
