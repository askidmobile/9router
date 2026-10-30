// Local requests-per-minute guard per account. Providers publish per-minute
// request allowances (e.g. Experiential's free core: 10 requests/min PER MODEL)
// and answer 429 when a client walks past them; a proactive budget keeps the
// router from burning the account's cooldown on avoidable 429s.
//
// Window is sliding (60s) and keyed by connection — and by model too when the
// allowance is per model, which is how coding-gateway free tiers are metered.

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 2000;

const hits = new Map(); // windowKey -> ascending timestamps (ms)

/**
 * Read the RPM budget for an account. 0/undefined means no local limit.
 * @param {object} connection - Connection record (from providerConnections)
 * @returns {number}
 */
export function connectionRpmLimit(connection) {
  const n = Number.parseInt(connection?.rpmLimit, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Whether the budget is metered per model (default) or for the whole account.
 * @param {object} connection
 * @returns {boolean}
 */
export function connectionRpmPerModel(connection) {
  return connection?.rpmPerModel !== false;
}

function windowKey(connection, model) {
  if (!connection?.id) return null;
  const perModel = connectionRpmPerModel(connection) && model;
  return perModel ? `${connection.id}:${model}` : connection.id;
}

function prune(list, now) {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < list.length && list[i] <= cutoff) i++;
  if (i > 0) list.splice(0, i);
  return list;
}

function sweep(now) {
  if (hits.size <= MAX_TRACKED_KEYS) return;
  for (const [key, list] of hits) {
    if (prune(list, now).length === 0) hits.delete(key);
  }
}

/**
 * True while the account (or account+model pair) can take another request in
 * the current window. Synchronous and race-free on the event loop, like
 * connectionConcurrency: nothing awaits between the check and the record.
 * @param {object} connection
 * @param {string|null} model
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRpmAvailable(connection, model = null, now = Date.now()) {
  const limit = connectionRpmLimit(connection);
  if (!limit) return true;
  const key = windowKey(connection, model);
  if (!key) return true;
  const list = hits.get(key);
  if (!list) return true;
  return prune(list, now).length < limit;
}

/**
 * Count a dispatched request against the account's budget.
 * @param {object} connection
 * @param {string|null} model
 * @param {number} [now]
 */
export function recordRpmHit(connection, model = null, now = Date.now()) {
  const limit = connectionRpmLimit(connection);
  if (!limit) return;
  const key = windowKey(connection, model);
  if (!key) return;
  sweep(now);
  const list = hits.get(key) || [];
  prune(list, now);
  list.push(now);
  hits.set(key, list);
}

/**
 * Milliseconds until the oldest hit leaves the window — the earliest moment a
 * request could be admitted again. 0 when the account is not limited.
 * @param {object} connection
 * @param {string|null} model
 * @param {number} [now]
 * @returns {number}
 */
export function rpmRetryAfterMs(connection, model = null, now = Date.now()) {
  const limit = connectionRpmLimit(connection);
  if (!limit) return 0;
  const key = windowKey(connection, model);
  const list = key ? hits.get(key) : null;
  if (!list) return 0;
  const live = prune(list, now);
  if (live.length < limit) return 0;
  return Math.max(0, live[live.length - limit] + WINDOW_MS - now);
}

/** Test hook: forget every counter. */
export function resetRpmState() {
  hits.clear();
}
