import { getProviderAlias } from "@/shared/constants/providers";

// All explicitly configured connections contribute their selected models.
// A connection with no allowlist retains the existing unrestricted behavior.
export function selectedModelIds(connections, aliases = []) {
  if (!connections.length || connections.some(connection => !Array.isArray(connection.providerSpecificData?.enabledModels))) return null;
  return new Set(connections.flatMap(connection => connection.providerSpecificData.enabledModels)
    .filter(id => typeof id === "string" && id.trim())
    .map(id => {
      const trimmed = id.trim();
      const alias = aliases.find(alias => trimmed.startsWith(`${alias}/`));
      return alias ? trimmed.slice(alias.length + 1) : trimmed;
    }));
}

export function existingProviderModelIds({ models = [], customModels = [], modelAliases = {}, providerAlias, disabledIds = [], connections = [] }) {
  const canonical = getProviderAlias(providerAlias);
  const registered = customModels.filter(model => getProviderAlias(model.providerAlias) === canonical && (model.kind || model.type || "llm") === "llm");
  const catalogIds = new Set(registered.filter(model => model.catalogOnly === true).map(model => model.id));
  const ids = new Set(models.map(model => model.id));
  for (const model of registered) if (!model.catalogOnly) ids.add(model.id);
  for (const target of Object.values(modelAliases)) {
    if (typeof target !== "string") continue;
    const slash = target.indexOf("/");
    if (slash > 0 && getProviderAlias(target.slice(0, slash)) === canonical) {
      const id = target.slice(slash + 1);
      if (!catalogIds.has(id)) ids.add(id);
    }
  }
  for (const id of disabledIds) ids.delete(id);
  const selected = selectedModelIds(connections.filter(connection => connection.isActive !== false), [providerAlias, canonical]);
  return selected ? new Set([...ids].filter(id => selected.has(id))) : ids;
}
