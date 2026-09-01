// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getProviderConnections } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

/**
 * Provider-node prefixes are user-defined and must never shadow a built-in
 * provider id/alias: getModelInfo() resolves those straight to the registry,
 * so a colliding node is unroutable — every `<prefix>/model` request lands on
 * the built-in provider instead. Exported so the dashboard can refuse such a
 * prefix up front rather than creating a dead provider.
 */
export function isReservedProviderPrefix(prefix) {
  return RESERVED_PROVIDER_PREFIXES.has(String(prefix || "").trim());
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    const isUsable = await buildComboMemberFilter();
    return isUsable ? combo.models.filter(isUsable) : combo.models;
  }
  return null;
}

/**
 * Members the user switched off must not be routed to: a model disabled in the
 * dashboard, or a provider whose every connection is disabled. Combo members
 * name compatible nodes by their display prefix while the disabled list and
 * connections key on the node id, so both spellings are matched.
 * @returns {Promise<((member: string) => boolean)|null>} null when nothing is off
 */
async function buildComboMemberFilter() {
  const [disabled, connections] = await Promise.all([getDisabledModels(), getProviderConnections()]);

  // "Off" = has connections and none of them active. A provider with no
  // connection at all may still be a no-auth free provider — leave it alone.
  const offProviders = new Set();
  for (const c of connections) {
    if (c.isActive === false) offProviders.add(c.provider);
  }
  for (const c of connections) {
    if (c.isActive !== false) offProviders.delete(c.provider);
  }
  if (offProviders.size === 0 && Object.keys(disabled).length === 0) return null;

  const nodeIdsByPrefix = new Map();
  for (const node of await getProviderNodes()) {
    if (!node.prefix) continue;
    if (!nodeIdsByPrefix.has(node.prefix)) nodeIdsByPrefix.set(node.prefix, []);
    nodeIdsByPrefix.get(node.prefix).push(node.id);
  }

  return (member) => {
    if (typeof member !== "string" || !member.includes("/")) return true; // nested combo name
    const { provider, providerAlias, model } = parseModel(member);
    const keys = [providerAlias, provider, ...(nodeIdsByPrefix.get(providerAlias) || [])].filter(Boolean);
    if (keys.some((k) => offProviders.has(k))) return false;
    return !keys.some((k) => Array.isArray(disabled[k]) && disabled[k].includes(model));
  };
}
