import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveModelName } from "./modelNames";

/**
 * Build the record EditModelModal edits.
 *
 * Every call site used to assemble its own partial version, so the provider
 * pages opened the modal without the alias, the effective caps or the pricing
 * that were already configured on the Models page — and, because they passed
 * effective caps as `staticCaps`, saving computed an empty diff and dropped the
 * override. One builder, one shape.
 *
 * @param {object} params
 * @param {string} params.id - model id
 * @param {string} params.providerAlias - key overrides/pricing/custom models are stored under
 * @param {string} [params.providerId] - registry id for static caps; omit for custom models
 * @param {string} [params.alias] - configured routing alias
 * @param {string} [params.name] - display name, independent of the routing alias
 * @param {boolean} [params.isCustom] - whether the model was added manually
 * @param {object} [params.nameOverrides] - provider-scoped display names
 * @param {object} [params.overrides] - capsOverrides map from useModelCaps()
 * @param {Function} [params.getCaps] - getCaps from useModelCaps()
 * @param {Function} [params.getPricing] - getPricing from usePricing()
 */
export function buildEditModel({ id, providerAlias, providerId, alias = "", name, isCustom = false, nameOverrides = {}, overrides = {}, getCaps, getPricing }) {
  const registryId = providerId || providerAlias;
  const staticCaps = getCapabilitiesForModel(registryId, id) || {};
  const override = overrides[`${providerAlias}|${id}`] || overrides[`${registryId}|${id}`] || null;
  // Override last: getCaps() only reports the well-known cap keys, so a rarer
  // one (audioInput) would be lost between the two.
  const caps = { ...staticCaps, ...(getCaps?.(`${providerAlias}/${id}`) || {}), ...(override || {}) };

  return {
    id,
    name: resolveModelName(nameOverrides, providerAlias, id, name),
    defaultName: name || id,
    isCustom,
    providerId: registryId,
    providerAlias,
    aliasKey: `${registryId}/${id}`,
    alias: alias || "",
    staticCaps,
    caps,
    override,
    pricing: getPricing?.(providerAlias, id) || getPricing?.(registryId, id) || null,
  };
}
