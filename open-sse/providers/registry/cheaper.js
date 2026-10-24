// Cheaper Inference — wallet-backed aggregator in front of many upstream vendors,
// OpenAI-compatible on one base URL. Two wire surfaces matter here: /chat/completions
// for chat clients and a stateless /responses layer for Codex. Their Anthropic-compatible
// /messages surface is deliberately not declared: it is documented for Claude Code with
// Claude model ids, and routing an arbitrary model id there is unverified.
//
// Their edge refuses any request body over 4.5 MB *before* the API runs ("413 Request body
// or vision payload is too large ... rejected before it reaches the API, so it is not
// billed"), which is why the cap is declared and enforced locally instead of surfacing as
// an opaque Vercel FUNCTION_PAYLOAD_TOO_LARGE blob.
const MAX_REQUEST_BODY_BYTES = 4_500_000;

export default {
  id: "cheaper",
  features: { usage: true, usageApikey: true },
  priority: 120,
  alias: "cheaper",
  aliases: [
    "ci",
    "cheaper-inference",
    "cheaperinference",
  ],
  uiAlias: "cheaper",
  display: {
    name: "Cheaper Inference",
    icon: "savings",
    color: "#16A34A",
    textIcon: "CI",
    website: "https://www.cheaperinference.com",
    notice: {
      text: "Wallet-backed aggregator: one key reaches Claude, GPT, Gemini, GLM, Kimi and DeepSeek at the cheapest available route. Model ids are bare (e.g. claude-opus-5.5, glm-5.3). Request bodies over 4.5 MB are refused by their edge before the API runs — send images with POST /v1/uploads or split the document.",
      apiKeyUrl: "https://www.cheaperinference.com/dashboard",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.cheaperinference.com/v1/chat/completions",
    validateUrl: "https://api.cheaperinference.com/v1/models",
    retry: {
      429: 2,
    },
    // Enforced in BaseExecutor.execute: the serialized body, not the client body.
    quirks: { maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES, reasoningAliasFields: true },
  },
  // Responses clients keep their own wire format: the compatibility layer is
  // stateless (store is accepted and ignored), so no translation is needed.
  // Retry/quirks stay on the entry above — a runtime transport only carries the
  // endpoint, its headers and its auth.
  transports: [
    { format: "openai", baseUrl: "https://api.cheaperinference.com/v1/chat/completions" },
    { format: "openai-responses", baseUrl: "https://api.cheaperinference.com/v1/responses" },
  ],
  // Curated seed only; the live catalogue is fetched per connection from
  // GET /v1/models (key required) and any other id passes through untouched.
  models: [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  ],
  passthroughModels: true,
};
