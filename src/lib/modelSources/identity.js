// Explicit aliases only: never strip dates, preview versions or model sizes.
const ALIASES = { hy4: "tencent/hy4-preview" };
export function normalizeModelIdentity(id) {
  return typeof id === "string" ? id.trim().toLowerCase().replace(/^free\//, "").replace(/:free$/, "") : "";
}
export function createModelMatcher(models) {
  const exact = new Map(), names = new Map();
  const add = (index, key, model) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(model);
  };
  for (const model of models) for (const name of [model.id, model.canonical_slug, model.hugging_face_id]) {
    const key = normalizeModelIdentity(name);
    add(exact, key, model);
    add(names, key.split("/").at(-1), model);
  }
  const select = (matches, match) => matches?.size === 1 ? { model: [...matches][0], match } : null;
  return id => {
    const key = normalizeModelIdentity(id);
    if (!key) return null;
    if (exact.has(key)) return select(exact.get(key), "exact");
    if (ALIASES[key]) return select(exact.get(ALIASES[key]), "alias");
    // Explicit manufacturer namespaces must not match a different manufacturer's model.
    return key.includes("/") ? null : select(names.get(key), "unique-name");
  };
}
export const matchModel = (id, models) => createModelMatcher(models)(id);
