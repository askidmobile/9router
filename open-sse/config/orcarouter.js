export const ORCAROUTER_MODELS_URL = "https://api.orcarouter.ai/v1/models";
export const ORCAROUTER_FREE_ROUTER = "orcarouter/free";
export const ORCAROUTER_NON_CHAT_KINDS = [
  { pattern: /(?:^|\/)(?:gpt-image-|imagen-)|(?:flash|pro|imagine)-image/i, kind: "image" },
  { pattern: /^kling\//i, kind: "video" },
  { pattern: /^orca\/dub$/i, kind: "audio" },
];
export const ORCAROUTER_ENDPOINT_KINDS = {
  embeddings: "embedding", "image-generation": "image", "openai-video": "video", systemone: "systemone",
};
export const ORCAROUTER_FREE_ERROR_CODE = "free_rate_limited";
