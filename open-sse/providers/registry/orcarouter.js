import { ORCAROUTER_FREE_ROUTER, ORCAROUTER_MODELS_URL } from "../../config/orcarouter.js";

export default {
  id: "orcarouter",
  alias: "orca",
  category: "freeTier",
  hasFree: true,
  authType: "apikey",
  authModes: ["apikey"],
  display: {
    name: "OrcaRouter",
    icon: "water_drop",
    color: "#2563EB",
    textIcon: "ORCA",
    website: "https://www.orcarouter.ai",
    notice: {
      text: "Free models require an OrcaRouter API key. Rate limits and prompt-size caps apply; an established GitHub account or sufficient paid usage may be required.",
      apiKeyUrl: "https://www.orcarouter.ai/console",
    },
  },
  transport: {
    baseUrl: "https://api.orcarouter.ai/v1/chat/completions",
    validateUrl: ORCAROUTER_MODELS_URL,
  },
  modelsFetcher: { url: ORCAROUTER_MODELS_URL, type: "orcarouter-free" },
  passthroughModels: true,
  // Public catalog verified 2026-10-18. Refresh suggestions for the rotating lineup.
  models: [
    { id: ORCAROUTER_FREE_ROUTER, name: "OrcaRouter Free Router" },
    { id: "deepseek/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash (Free)" },
    { id: "deepseek/deepseek-v4-flash-free", name: "DeepSeek V4 Flash (Free)" },
    { id: "z-ai/glm-5.3-flash-free", name: "GLM 5.3 Flash (Free)" },
    { id: "tencent/hy4-preview-free", name: "Tencent Hy4 Preview (Free)" },
    { id: "tencent/hy3-free", name: "Tencent Hy3 (Free)" },
    { id: "orca/orcaverify-text1.0-free", name: "OrcaVerify Text 1.0 (Free)" },
  ],
};
