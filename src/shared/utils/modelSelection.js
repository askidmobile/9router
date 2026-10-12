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
