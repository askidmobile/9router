import { GEMINI_FLEX_MODELS, GEMINI_FLEX_SUFFIX, GEMINI_SERVICE_TIERS } from "../config/gemini.js";

// Google's Models API returns resource names. Router IDs omit the resource
// prefix; other providers' slash-separated model namespaces must stay intact.
export function normalizeGeminiModelId(id) {
  return typeof id === "string" ? id.trim().replace(/^\/?models\//, "") : "";
}

export function splitGeminiModelId(id) {
  const normalized = normalizeGeminiModelId(id);
  const match = normalized.match(/^(.*?)(\([^()]+\))?$/);
  const base = (match?.[1] || normalized).trim();
  const thinkingSuffix = match?.[2] || "";
  const flex = base.endsWith(GEMINI_FLEX_SUFFIX);
  const baseModelId = flex ? base.slice(0, -GEMINI_FLEX_SUFFIX.length) : base;
  return {
    modelId: baseModelId + thinkingSuffix,
    baseModelId,
    serviceTier: flex ? GEMINI_SERVICE_TIERS.flex : undefined,
  };
}

export function withGeminiFlexModels(models) {
  const existing = new Set(models.map((model) => model.id));
  return models.flatMap((model) => {
    if ((model.kind && model.kind !== "llm") || !GEMINI_FLEX_MODELS.has(model.id)) return [model];
    const id = model.id + GEMINI_FLEX_SUFFIX;
    if (existing.has(id)) return [model];
    existing.add(id);
    return [model, {
      ...model, id, name: `${model.name || model.id} (Flex)`,
      upstreamModelId: model.id, serviceTier: GEMINI_SERVICE_TIERS.flex,
    }];
  });
}

// Resolve before translation so Chat, Responses, Claude and native Gemini
// clients all retain the explicit billing tier. Never silently upgrade Flex.
export function resolveGeminiServiceTier(model, body = {}) {
  const variant = splitGeminiModelId(model).serviceTier;
  const values = [body.service_tier, body.serviceTier].filter((value) => value != null);
  const tiers = [];
  for (const value of values) {
    if (typeof value !== "string" || !Object.hasOwn(GEMINI_SERVICE_TIERS, value)) {
      return { error: "Unsupported AI Studio service tier. Use default, standard, flex or priority." };
    }
    tiers.push(GEMINI_SERVICE_TIERS[value]);
  }
  if (new Set(tiers).size > 1 || (variant && tiers.some((tier) => tier !== variant))) {
    return { error: "Conflicting AI Studio service tiers. A :flex model requires service_tier: flex (or omit the parameter)." };
  }
  return { serviceTier: variant || tiers[0] };
}
