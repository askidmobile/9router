// Per-account concurrent-request slots (in-process). Many providers reject
// or queue when an account exceeds its parallelism allowance (Ollama
// NUM_PARALLEL=2 by default, several paid tiers 2-5). The router now enforces
// that limit before dispatching and spills overflow to the next account,
// instead of letting the provider queue the request (queueing kills prompt
// cache and adds seconds of latency).
//
// Limit resolution: connection.maxConcurrentRequests (per-account, optional)
// -> global default of 2. Missing or invalid value -> 2.
// In-flight counters live in memory; a slot is acquired at account selection
// and released when the upstream response finishes or fails.

const DEFAULT_MAX_CONCURRENT = Number(process.env.CONNECTION_DEFAULT_MAX_CONCURRENT) || 2;

const inflight = new Map(); // connectionId -> count

/**
 * Read the concurrency cap for an account.
 * @param {object} connection - Connection record (from providerConnections)
 * @returns {number}
 */
export function connectionMaxConcurrent(connection) {
  const raw = connection?.maxConcurrentRequests;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT;
}

/**
 * In-memory counter of currently dispatched (or streaming) requests on an
 * account.
 * @param {string} connectionId
 * @returns {number}
 */
export function getInflightCount(connectionId) {
  return inflight.get(connectionId) ?? 0;
}

/**
 * Atomically try to take a slot. Synchronous and race-free on the event loop
 * because selection never awaits between this call and consuming the result.
 * @param {string} connectionId
 * @param {number} max - cap for this account
 * @returns {boolean} true if the slot was acquired
 */
export function tryAcquireConnectionSlot(connectionId, max) {
  const cap = Number.isSafeInteger(max) && max > 0 ? max : DEFAULT_MAX_CONCURRENT;
  const current = inflight.get(connectionId) ?? 0;
  if (current >= cap) return false;
  inflight.set(connectionId, current + 1);
  return true;
}

/**
 * Release a slot that was acquired via tryAcquireConnectionSlot.
 * @param {string|null} connectionId
 */
export function releaseConnectionSlot(connectionId) {
  if (!connectionId) return;
  const current = inflight.get(connectionId) ?? 0;
  if (current <= 1) inflight.delete(connectionId);
  else inflight.set(connectionId, current - 1);
}

/**
 * Wrap a success Response so its account slot frees when the upstream body
 * closes (streams hold their provider slot until the last byte) or the client
 * cancels. Non-stream JSON responses still release at pipe completion.
 * @param {Response|null} response
 * @param {string} connectionId
 * @returns {Response}
 */
export function withSlotRelease(response, connectionId) {
  if (!response || !connectionId || !response.body) {
    releaseConnectionSlot(connectionId);
    return response;
  }
  let done = false;
  const release = () => {
    if (!done) {
      done = true;
      releaseConnectionSlot(connectionId);
    }
  };

  const { readable, writable } = new TransformStream({
    flush() { release(); },
    cancel() { release(); },
  });
  response.body.pipeTo(writable).catch(() => {}); // upstream done -> flush fires
  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Test hooks.
export function _resetConcurrency() {
  inflight.clear();
}
