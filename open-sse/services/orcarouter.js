import { ORCAROUTER_FREE_ROUTER, ORCAROUTER_NON_CHAT_KINDS, ORCAROUTER_ENDPOINT_KINDS } from "../config/orcarouter.js";

export const isOrcaRouterFreeModel = (id) => typeof id === "string"
  && (id === ORCAROUTER_FREE_ROUTER || id.endsWith("-free"));

// Keep the complete authenticated catalog. Media entries remain visible, but
// cannot be imported as chat models through this provider's chat-only transport.
export function normalizeOrcaRouterModels(data) {
  const models = Array.isArray(data) ? data : data?.data;
  return (Array.isArray(models) ? models : [])
    .filter((model) => typeof model?.id === "string" && model.id.trim())
    .map((model) => {
      const endpoints = model.supported_endpoint_types;
      const kind = ORCAROUTER_NON_CHAT_KINDS.find(({ pattern }) => pattern.test(model.id))?.kind
        || (Array.isArray(endpoints) && endpoints.map((endpoint) => ORCAROUTER_ENDPOINT_KINDS[endpoint]).find(Boolean))
        || "llm";
      const chat = kind === "llm" && (!Array.isArray(endpoints) || endpoints.includes("openai"));
      const freeRequest = isOrcaRouterFreeModel(model.id) && model.pricing?.request != null
        && String(model.pricing.request).trim() !== "" && Number(model.pricing.request) === 0;
      return {
        ...model,
        id: model.id,
        name: model.name || (model.id === ORCAROUTER_FREE_ROUTER ? "OrcaRouter Free Router" : model.id),
        kind,
        type: kind,
        ...(freeRequest ? { pricing: { ...model.pricing, input_per_million: 0, output_per_million: 0 } } : {}),
        ...(chat ? {} : { available: false, unavailableReason: kind === "llm" ? "Chat Completions unavailable" : "Not a chat model" }),
      };
    });
}

// Free catalog stubs have null endpoint types and either a zero request price
// or zero prompt/completion prices. A suffix alone must not advertise paid IDs.
export function normalizeOrcaRouterFreeModels(data) {
  const models = Array.isArray(data) ? data : data?.data;
  return (Array.isArray(models) ? models : []).filter((model) => {
    if (!isOrcaRouterFreeModel(model?.id)) return false;
    if (Array.isArray(model.supported_endpoint_types)
      && !model.supported_endpoint_types.includes("openai")) return false;
    if (model.id === ORCAROUTER_FREE_ROUTER) return true;
    const pricing = model.pricing || {};
    const rates = [pricing.request, pricing.prompt, pricing.completion,
      pricing.prompt_per_million, pricing.completion_per_million].filter((rate) => rate != null);
    return (pricing.request != null || (pricing.prompt != null && pricing.completion != null))
      && rates.every((rate) => (typeof rate === "number" || typeof rate === "string")
        && String(rate).trim() !== "" && Number(rate) === 0);
  }).map((model) => ({
    id: model.id,
    name: model.name || (model.id === ORCAROUTER_FREE_ROUTER ? "OrcaRouter Free Router" : model.id),
    ...(model.context_length ? { contextLength: model.context_length } : {}),
  }));
}
