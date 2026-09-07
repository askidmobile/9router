// https://ai.google.dev/gemini-api/docs/flex-inference (2026-09-07).
// Only these documented text models get a selectable Flex variant. New or
// custom models can still opt in explicitly with service_tier in the request.
export const GEMINI_FLEX_MODELS = new Set([
  "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash",
  "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview", "gemini-3-flash-preview",
  "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
]);

export const GEMINI_FLEX_SUFFIX = ":flex";
export const GEMINI_SERVICE_TIERS = Object.freeze({
  default: "standard", standard: "standard", flex: "flex",
  priority: "priority", unspecified: "unspecified",
});
export const GEMINI_MODELS_PAGE_SIZE = 1000;
export const GEMINI_MODELS_MAX_PAGES = 10;
export const GEMINI_MODELS_TIMEOUT_MS = 30_000;
export const GEMINI_FLEX_TIMEOUT_MS = 15 * 60 * 1000;
