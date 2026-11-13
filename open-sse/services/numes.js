export function normalizeNumesModels(payload) {
  if (!Array.isArray(payload?.data)) return [];
  return payload.data
    .filter(model => typeof model?.id === "string" && model.id.trim())
    .map(model => ({
      ...model,
      max_output_tokens: model.maximum_output_length,
      // Numes returns per-token rates in the key's currency; 9router stores USD.
      pricing: model.billing_currency === "USD" ? model.pricing : undefined,
    }));
}
