import { getProviderNodes } from "@/models";
import { isReservedProviderPrefix } from "@/sse/services/model";

/**
 * A provider node is reachable only through its prefix, so the prefix must be
 * unique and must not collide with a built-in provider: the router resolves
 * built-in ids/aliases from the registry and never consults nodes for them,
 * which leaves a colliding node silently unroutable (every `<prefix>/model`
 * request lands on the built-in provider and fails with "no credentials").
 *
 * @param {string} prefix - the prefix being saved
 * @param {string|null} selfId - node being updated, excluded from the clash check
 * @returns {Promise<string|null>} error message, or null when the prefix is fine
 */
export async function validateProviderNodePrefix(prefix, selfId = null) {
  const value = String(prefix || "").trim();
  if (!value) return "Prefix is required";

  if (isReservedProviderPrefix(value)) {
    return `Prefix "${value}" belongs to a built-in provider — models under it would route to that provider instead of this node. Pick a different prefix.`;
  }

  const clash = (await getProviderNodes()).find((n) => n.prefix === value && n.id !== selfId);
  if (clash) {
    return `Prefix "${value}" is already used by "${clash.name}". Pick a different prefix.`;
  }

  return null;
}
