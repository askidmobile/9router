import { getCapsOverrides, getCustomModels } from "@/lib/db/index.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { parseSuffix } from "open-sse/translator/concerns/thinkingUnified.js";

// Carry only reasoning metadata into the request pipeline. Transport format,
// context limits and other capabilities retain their existing runtime policy.
export function resolveModelReasoningCaps(provider, model, overrides = {}, customModels = []) {
  const { cleanModel } = parseSuffix(model);
  const alias = getProviderAlias(provider) || provider;
  const saved = customModels.find((entry) => entry.id === cleanModel
    && (entry.providerAlias === alias || entry.providerAlias === provider)
    && (entry.kind || entry.type || "llm") === "llm");
  const override = overrides[`${alias}|${cleanModel}`] || overrides[`${provider}|${cleanModel}`];
  const caps = { ...(saved?.caps || {}), ...(override || {}) };
  const reasoning = {};
  if (typeof caps.reasoning === "boolean") reasoning.reasoning = caps.reasoning;
  if (Object.hasOwn(caps, "reasoningLevels")) reasoning.reasoningLevels = caps.reasoningLevels;
  return reasoning;
}

export async function getModelReasoningCaps(provider, model) {
  const [overrides, customModels] = await Promise.all([getCapsOverrides(), getCustomModels()]);
  return resolveModelReasoningCaps(provider, model, overrides, customModels);
}
