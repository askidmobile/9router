// Shared view of "which provider|model pairs are currently blocked".
//
// Both the status badge API and the model catalog use this, so a model cannot
// look healthy in one place and cooled down in the other.

// Barrel import on purpose: the dashboard routes and their test doubles both
// resolve connections through `@/lib/localDb`.
import { getProviderConnections } from "@/lib/localDb";
import { listComboHealth } from "open-sse/services/comboHealth.js";
import { toPublicComboCircuit } from "@/shared/utils/comboHealth";

export const MODEL_LOCK_PREFIX = "modelLock_";
export const ALL_MODELS = "__all";

/** Locks that are still in the future, newest first. */
export function getActiveModelLocks(connection, now = Date.now()) {
  return Object.entries(connection || {})
    .filter(([key, value]) => key.startsWith(MODEL_LOCK_PREFIX) && value)
    .map(([key, value]) => ({
      key,
      model: key.slice(MODEL_LOCK_PREFIX.length) || ALL_MODELS,
      until: value,
      active: new Date(value).getTime() > now,
    }))
    .filter((lock) => lock.active);
}

/**
 * Enumerate every blocked provider|model pair across connections plus the
 * combo circuits that are currently open.
 *
 * @returns {Promise<{models: object[], unavailableCount: number, comboCircuits: object[]}>}
 */
export async function getModelAvailability() {
  const [connections, comboHealth] = await Promise.all([
    getProviderConnections(),
    listComboHealth(),
  ]);
  const models = [];
  const now = Date.now();

  for (const connection of connections) {
    const locks = getActiveModelLocks(connection, now);
    for (const lock of locks) {
      models.push({
        provider: connection.provider,
        model: lock.model,
        status: "cooldown",
        until: lock.until,
        connectionId: connection.id,
        connectionName: connection.name || connection.email || connection.id,
        lastError: connection.lastError || null,
      });
    }

    // An account-wide test failure only covers models that have no explicit
    // lock of their own; otherwise the per-model detail is lost.
    if (locks.length === 0 && connection.testStatus === "unavailable") {
      models.push({
        provider: connection.provider,
        model: ALL_MODELS,
        status: "unavailable",
        connectionId: connection.id,
        connectionName: connection.name || connection.email || connection.id,
        lastError: connection.lastError || null,
      });
    }
  }

  return {
    models,
    unavailableCount: models.length,
    comboCircuits: comboHealth.map(toPublicComboCircuit).filter(Boolean),
  };
}

/**
 * Index availability by provider alias, keeping the worst state per model.
 * `__all` entries mark the whole provider as unavailable.
 */
export function indexAvailability(availability) {
  const byProvider = new Map();
  const ensure = (provider) => {
    if (!byProvider.has(provider)) byProvider.set(provider, new Map());
    return byProvider.get(provider);
  };

  for (const item of availability?.models || []) {
    ensure(item.provider).set(item.model, {
      state: item.status,
      until: item.until || null,
      lastError: item.lastError || null,
    });
  }
  for (const circuit of availability?.comboCircuits || []) {
    if (circuit?.state !== "open") continue;
    const provider = circuit.provider || circuit.providerId;
    const model = circuit.model;
    if (!provider || !model) continue;
    ensure(provider).set(model, {
      state: "cooldown",
      until: circuit.nextProbeAt || null,
      lastError: circuit.lastReason || null,
    });
  }
  return byProvider;
}