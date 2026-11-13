const BASE_URL = "https://api.numes.ai/api/v1";
const MODELS_URL = `${BASE_URL}/models?output_modalities=text`;

export default {
  id: "numes",
  category: "apikey",
  authType: "apikey",
  display: {
    name: "Numes",
    icon: "hub",
    color: "#475569",
    textIcon: "NU",
    website: "https://numes.ai",
    notice: {
      text: "After connecting an inference key, use Import Models to load the chat catalog available to that key.",
      apiKeyUrl: "https://numes.ai/dashboard/keys",
    },
  },
  transport: {
    baseUrl: `${BASE_URL}/chat/completions`,
    validateUrl: MODELS_URL,
    thinkingFormat: "openai",
    quirks: { unlabelledCostCurrency: true },
  },
  modelsFetcher: { url: MODELS_URL, type: "openai" },
  passthroughModels: true,
};
