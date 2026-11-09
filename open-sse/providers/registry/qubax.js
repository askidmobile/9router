import { QUBAX_BASE_URL, QUBAX_MODELS_URL, QUBAX_BALANCE_URL } from "../../config/qubax.js";
import { ANTHROPIC_API_VERSION } from "../shared.js";

export default {
  id: "qubax",
  alias: "qubax",
  aliases: ["qubaxai"],
  category: "apikey",
  authType: "apikey",
  features: { usage: true, usageApikey: true },
  display: {
    name: "Qubax AI",
    icon: "hub",
    color: "#00D4AA",
    textIcon: "QBX",
    website: "https://qubax.ai",
    notice: {
      text: "Qubax AI supports OpenAI Chat Completions, Responses and Anthropic Messages. Import Models loads the current chat catalog, published prices and capabilities. Prices vary with available offers and routing settings.",
      apiKeyUrl: "https://qubax.ai/app/api-keys",
    },
  },
  transport: {
    baseUrl: `${QUBAX_BASE_URL}/chat/completions`,
    validateUrl: QUBAX_BALANCE_URL,
  },
  transports: [
    { format: "openai", baseUrl: `${QUBAX_BASE_URL}/chat/completions` },
    { format: "openai-responses", baseUrl: `${QUBAX_BASE_URL}/responses` },
    {
      format: "claude",
      baseUrl: `${QUBAX_BASE_URL}/messages`,
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
      headers: { "anthropic-version": ANTHROPIC_API_VERSION },
    },
  ],
  // Offline seed only; /v1/models is the authority for this rotating catalog.
  models: [
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
  ],
  modelsFetcher: { url: QUBAX_MODELS_URL, type: "qubax" },
  passthroughModels: true,
};
