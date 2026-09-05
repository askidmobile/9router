import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { TTS_PROVIDER_CONFIG } from "@/shared/constants/ttsProviders";

// Voice/language-only providers have no separate model to rename or select.
export function getTtsModels(providerId) {
  const config = TTS_PROVIDER_CONFIG[providerId];
  if (config?.hasModelSelector === false) return [];
  const registered = getModelsByProviderId(providerId).filter((model) => getModelKind(model) === "tts");
  const configured = AI_PROVIDERS[providerId]?.ttsConfig?.models || [];
  const models = registered.length ? registered : configured.length ? configured : getModelsByProviderId(config?.modelKey);
  return models.map((model) => ({ ...model, kind: "tts" }));
}
