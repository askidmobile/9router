// Local per-minute budgets for an account. Providers publish per-minute request
// and token allowances (a gateway's plan page lists both, e.g. 6,000 requests/min
// and 100M tokens/min) and answer 429 once a client walks past them; a proactive
// request budget keeps the router from burning the account's cooldown on
// avoidable 429s. The token budget is reactive by nature — tokens are known only
// after the response — so it caps sustained volume, not a single huge request.
//
// Requests: sliding 60s window, keyed by connection, and by model too when the
// allowance is per model (gateway free tiers meter per model).
// Tokens: sliding 60s window per connection; plan ceilings are org-wide.

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 2000;

const requestHits = new Map(); // windowKey -> ascending timestamps (ms)
const tokenHits = new Map(); // connectionId -> ascending {at, n}

/**
 * Read the requests-per-minute budget for an account. 0/undefined = none.
 * @param {object} connection - Connection record (from providerConnections)
 * @returns {number}
 */
export function connectionRpmLimit(connection) {
  const n = Number.parseInt(connection?.rpmLimit, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Read the tokens-per-minute budget for an account. 0/undefined = none.
 * @param {object} connection
 * @returns {number}
 */
export function connectionTpmLimit(connection) {
  const n = Number.parseInt(connection?.tpmLimit, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * Whether the request budget is metered per model (default) or per account.
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
  if (requestHits.size <= MAX_TRACKED_KEYS) return;
  for (const [key, list] of requestHits) {
    if (prune(list, now).length === 0) requestHits.delete(key);
  }
}

/**
 * True while the account (or account+model pair) can take another request in
 * the current request budget AND its token budget is not spent. Synchronous and
 * race-free on the event loop, like connectionConcurrency: nothing awaits
 * between the check and the record.
 * @param {object} connection
 * @param {string|null} model
 * @param {number} [now]
 * @returns {boolean}
 */
export function isRateAvailable(connection, model = null, now = Date.now()) {
  const rpm = connectionRpmLimit(connection);
  if (rpm) {
    const key = windowKey(connection, model);
    const list = key ? requestHits.get(key) : null;
    if (list && prune(list, now).length >= rpm) return false;
  }
  if (connectionTpmLimit(connection)) {
    const tokens = tokensInWindow(connection?.id, now);
    if (tokens >= connectionTpmLimit(connection)) return false;
  }
  return true;
}

/**
 * Count a dispatched request against the account's request budget.
 * @param {object} connection
 * @param {string|null} model
 * @param {number} [now]
 */
export function recordRequestHit(connection, model = null, now = Date.now()) {
  const limit = connectionRpmLimit(connection);
  if (!limit) return;
  const key = windowKey(connection, model);
  if (!key) return;
  sweep(now);
  const list = requestHits.get(key) || [];
  prune(list, now);
  list.push(now);
  requestHits.set(key, list);
}

/**
 * Count settled tokens (input + output) against the account's token budget.
 * Called from saveUsageStats on every completed request, whether or not the
 * connection carries a TPM ceiling.
 * @param {string|null} connectionId
 * @param {number} tokens
 * @param {number} [now]
 */
export function recordTokenUsage(connectionId, tokens, now = Date.now()) {
  const n = Number(tokens);
  if (!connectionId || !Number.isFinite(n) || n <= 0) return;
  const list = tokenHits.get(connectionId) || [];
  const cutoff = now - WINDOW_MS;
  while (list.length && list[0].at <= cutoff) list.shift();
  list.push({ at: now, n: Math.round(n) });
  tokenHits.set(connectionId, list);
}

function tokensInWindow(connectionId, now) {
  if (!connectionId) return 0;
  const list = tokenHits.get(connectionId);
  if (!list) return 0;
  const cutoff = now - WINDOW_MS;
  while (list.length && list[0].at <= cutoff) list.shift();
  if (list.length === 0) {
    tokenHits.delete(connectionId);
    return 0;
  }
  let total = 0;
  for (const entry of list) total += entry.n;
  return total;
}

/**
 * Milliseconds until either budget admits a request again — the earliest moment
 * the oldest hit (or enough tokens) leaves the window. 0 when nothing is spent.
 * @param {object} connection
 * @param {string|null} model
 * @param {number} [now]
 * @returns {number}
 */
export function rateRetryAfterMs(connection, model = null, now = Date.now()) {
  let wait = 0;
  const rpm = connectionRpmLimit(connection);
  const key = rpm ? windowKey(connection, model) : null;
  const list = key ? requestHits.get(key) : null;
  if (list) {
    const live = prune(list, now);
    if (live.length >= rpm) wait = Math.max(0, live[live.length - rpm] + WINDOW_MS - now);
  }
  const tpm = connectionTpmLimit(connection);
  if (tpm && connection?.id) {
    const tokens = tokenHits.get(connection.id);
    if (tokens && tokens.length) {
      const cutoff = now - WINDOW_MS;
      while (tokens.length && tokens[0].at <= cutoff) tokens.shift();
      let total = tokens.reduce((sum, entry) => sum + entry.n, 0);
      // Drop oldest entries until the budget would admit a new request; the
      // last dropped entry's expiry is when that happens.
      let index = 0;
      while (total >= tpm && index < tokens.length) {
        wait = Math.max(wait, Math.max(0, tokens[index].at + WINDOW_MS - now));
        total -= tokens[index].n;
        index++;
      }
    }
  }
  return wait;
}

/** Test hook: forget every counter. */
export function resetRateLimitState() {
  requestHits.clear();
  tokenHits.clear();
}
