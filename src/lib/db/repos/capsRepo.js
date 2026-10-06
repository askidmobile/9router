import { makeKv } from "../helpers/kvStore.js";

// modelCaps: key=`${provider}|${model}`, value=capabilities override object.
// Overrides are merged over static capabilities in catalogs. Reasoning metadata
// also reaches the request pipeline; other runtime caps retain their static policy.
const capsKv = makeKv("modelCaps");

export function capsKey(provider, model) {
  return `${provider}|${model}`;
}

export async function getCapsOverrides() {
  return await capsKv.getAll();
}

export async function getCapsOverride(provider, model) {
  return await capsKv.get(capsKey(provider, model));
}

export async function setCapsOverride(provider, model, caps) {
  await capsKv.set(capsKey(provider, model), caps);
}

export async function deleteCapsOverride(provider, model) {
  await capsKv.remove(capsKey(provider, model));
}

// entries: { [modelId]: caps } for one provider — single transaction
export async function setCapsOverridesBulk(provider, entries) {
  const existing = await capsKv.getAll();
  const obj = {};
  for (const [model, caps] of Object.entries(entries)) {
    const key = capsKey(provider, model);
    const previous = existing[key];
    // models.dev imports refresh catalog metadata, not the user's explicit
    // effort choices (including an empty list or a reset to automatic).
    const reasoning = previous && Object.hasOwn(previous, "reasoningLevels") ? {
      reasoningLevels: previous.reasoningLevels,
      ...(typeof previous.reasoning === "boolean" ? { reasoning: previous.reasoning } : {}),
    } : {};
    obj[key] = { ...caps, ...reasoning };
  }
  await capsKv.setMany(obj);
}
