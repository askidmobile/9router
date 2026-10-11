import { makeKv } from "../helpers/kvStore.js";

const capsKv = makeKv("modelCaps");
export const capsKey = (provider, model) => `${provider}|${model}`;

function layers(record) {
  if (record?.version === 1 && record.manual && record.automatic) return record;
  // Old imports and hand edits shared one bucket; preserve them without inventing provenance.
  return { version: 1, manual: record || {}, automatic: {}, sources: {}, manualSources: {} };
}
function effective(record) {
  const { manual, automatic } = layers(record);
  const selected = { ...manual };
  if (selected.reasoningLevels === null && Object.hasOwn(automatic, "reasoningLevels")) delete selected.reasoningLevels;
  return { ...automatic, ...selected };
}
export async function getCapsOverrides() {
  return Object.fromEntries(Object.entries(await capsKv.getAll()).map(([key, record]) => [key, effective(record)]));
}
export async function getManualCapsOverrides() {
  return Object.fromEntries(Object.entries(await capsKv.getAll()).filter(([, record]) => Object.keys(layers(record).manual).length).map(([key, record]) => [key, layers(record).manual]));
}
export async function getAutomaticCapsOverrides() {
  return Object.fromEntries(Object.entries(await capsKv.getAll()).map(([key, record]) => [key, layers(record).automatic]));
}
export async function getAutomaticCapsMetadata() {
  return Object.fromEntries(Object.entries(await capsKv.getAll()).map(([key, record]) => [key, layers(record).sources]));
}
export async function getCapsMetadata() {
  return Object.fromEntries(Object.entries(await capsKv.getAll()).map(([key, record]) => {
    const { manual, automatic, sources, manualSources } = layers(record);
    const metadata = { ...sources };
    for (const field of Object.keys(manual)) {
      if (field === "reasoningLevels" && manual[field] === null && Object.hasOwn(automatic, field)) continue;
      metadata[field] = { ...(manualSources[field] || { source: "legacy", updatedAt: null, verified: false }),
        ...(Object.hasOwn(automatic, field) ? { catalog: { value: automatic[field], ...sources[field] } } : {}),
      };
    }
    return [key, metadata];
  }));
}
export async function getCapsOverride(provider, model) {
  const record = await capsKv.get(capsKey(provider, model));
  return record ? effective(record) : null;
}
export async function setCapsOverride(provider, model, caps) {
  const key = capsKey(provider, model);
  const updatedAt = new Date().toISOString();
  await capsKv.updateMany([key], previous => {
    const record = layers(previous);
    const manualSources = Object.fromEntries(Object.keys(caps).map(field => [field,
      Object.hasOwn(record.manual, field) && JSON.stringify(record.manual[field]) === JSON.stringify(caps[field])
        ? record.manualSources[field] || { source: "legacy", updatedAt: null, verified: false }
        : { source: "manual", updatedAt, verified: false },
    ]));
    return { ...record, manual: caps, manualSources };
  });
}
export async function deleteCapsOverride(provider, model) {
  await capsKv.updateMany([capsKey(provider, model)], previous => {
    const record = layers(previous);
    return Object.keys(record.automatic).length ? { ...record, manual: {}, manualSources: {} } : null;
  });
}
// Catalog refresh only writes the automatic layer. Missing fields retain their last observation.
export async function setCapsOverridesBulk(provider, entries, options = {}) {
  const updatedAt = options.updatedAt || new Date().toISOString();
  const keyed = Object.fromEntries(Object.entries(entries).map(([model, caps]) => [capsKey(provider, model), { model, caps }]));
  await capsKv.updateMany(Object.keys(keyed), (previous, key) => {
    const { model, caps } = keyed[key];
    const record = layers(previous);
    const sources = { ...record.sources };
    for (const field of Object.keys(caps)) {
      sources[field] = options.sources?.[model]?.[field]
        || { source: options.source || "models.dev", updatedAt, verified: false };
    }
    return { ...record, automatic: { ...record.automatic, ...caps }, sources };
  });
}
