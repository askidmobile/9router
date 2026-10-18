// The catalog ID may be routed (provider/vendor/model) for chat selectors.
// Persist the explicit upstream ID so importing never adds the provider twice.
export function normalizeProviderImportModels(models, transformId) {
  const seen = new Set();
  const normalized = [];
  for (const model of models || []) {
    let id = model?.upstreamModelId || model?.id || model?.name || model?.model;
    if (typeof id !== "string" || !id) continue;
    if (transformId) id = transformId(id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      name: model.name && model.name !== model.id && model.name !== id ? model.name : null,
      available: model.available !== false,
      ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}),
    });
  }
  return normalized;
}
