// A process-wide counter bumped by every metadata write.
//
// Reads of model metadata are cached in process memory (caps resolution in
// /api/models, the aggregated catalog snapshot). Those caches used to live until
// a server restart, so an import or a manual edit stayed invisible on screen —
// and the provider page and the models page could disagree indefinitely.
//
// The counter lives on globalThis because this codebase can load the same module
// twice (Next.js route bundles vs. the SSE runtime), and a module-local variable
// would then be bumped in one copy while the cache lives in another.

const KEY = Symbol.for("9router.catalogRevision");
const globalStore = globalThis;

function state() {
  if (!globalStore[KEY]) globalStore[KEY] = { revision: 1 };
  return globalStore[KEY];
}

/** Current revision. Cache entries store the revision they were built at. */
export function catalogRevision() {
  return state().revision;
}

/** Call after any write to model metadata (caps, pricing, custom models). */
export function bumpCatalogRevision() {
  state().revision += 1;
  return state().revision;
}

export const __test__ = { KEY };