import { COMBO_HEALTH_CONFIG, COMBO_HEALTH_STORAGE_CONFIG } from "../config/comboHealth.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../config/errorConfig.js";
import { comboHealthKey, comboHealthRepository } from "../../src/lib/db/repos/comboHealthRepo.js";

const { reasonMaxLength, reasonInputMaxLength, identityMaxLength, maxFailureCount } = COMBO_HEALTH_STORAGE_CONFIG;

export function sanitizeComboHealthReason(reason) {
  const text = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
  return text.slice(0, reasonInputMaxLength)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[endpoint]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/gi, "[redacted authorization]")
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|password|secret)\b["']?\s*[:=]\s*["']?[^\s,"'}]+/gi, "[redacted credential]")
    .replace(/\b(?:sk[-_]|workos:)[A-Za-z0-9_./:+-]+/g, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b[A-Za-z0-9_+/.=-]{48,}\b/g, "[redacted value]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim().slice(0, reasonMaxLength);
}

function identity(provider, model) {
  if (typeof provider !== "string" || !provider.trim() || provider.length > identityMaxLength
    || typeof model !== "string" || !model.trim() || model.length > identityMaxLength) {
    throw new Error("Combo health requires a provider and model");
  }
  return { provider: provider.trim(), model: model.trim() };
}

function safeStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

// Cooldown before the pair may be attempted again. Consecutive incidents grow
// it X, 2X, 3X... up to the cap; an explicit provider deadline wins.
export function comboHealthRetryAt({ now, failureCount, retryAfterMs, config = COMBO_HEALTH_CONFIG }) {
  const delay = Math.min(config.baseCooldownMs * Math.max(failureCount, 1), config.maxCooldownMs);
  // retryAfterMs is an absolute deadline (the same convention as account cooldowns).
  const retryDeadline = Number.isFinite(retryAfterMs)
    ? Math.min(Math.max(now, retryAfterMs), now + MAX_RATE_LIMIT_COOLDOWN_MS)
    : now;
  return Math.max(now + delay, retryDeadline);
}

export function createComboHealthService({
  repository = comboHealthRepository,
  now = Date.now,
  config = COMBO_HEALTH_CONFIG,
  // Next can hold one module instance per route, so a per-instance Map would let a success
  // seen by one instance leave the streak of another untouched. The process-wide store keeps
  // the counter coherent; tests inject their own Map to stay isolated.
  streaks = (globalThis.__nineRouterComboTimeoutStreaks ||= new Map()),
} = {}) {
  const freeze = async ({ provider, model, status, reason, retryAfterMs }) => {
    const pair = identity(provider, model);
    return repository.transaction((tx) => {
      const timestamp = now();
      const previous = tx.get(pair.provider, pair.model);
      // A failure while the pair is still frozen (a concurrent request that
      // started earlier) belongs to the same incident; only a retry after the
      // cooldown escalates the counter.
      const failureCount = previous && previous.nextProbeAt > timestamp
        ? previous.failureCount
        : Math.min((previous?.failureCount || 0) + 1, maxFailureCount);
      const record = {
        ...pair,
        state: "open",
        failureCount,
        openedAt: previous?.openedAt ?? timestamp,
        lastFailureAt: timestamp,
        nextProbeAt: Math.max(previous?.nextProbeAt || 0,
          comboHealthRetryAt({ now: timestamp, failureCount, retryAfterMs, config })),
        lastStatus: safeStatus(status),
        lastReason: sanitizeComboHealthReason(reason),
      };
      tx.set(record);
      return record;
    });
  };
  const clear = async ({ provider, model }) => {
    const pair = identity(provider, model);
    return repository.transaction((tx) => {
      tx.remove(pair.provider, pair.model);
      return true;
    });
  };

  return {
    async getComboHealth(provider, model) {
      const pair = identity(provider, model);
      return repository.get(pair.provider, pair.model);
    },
    async listComboHealth() {
      return (await repository.list()).sort((a, b) => a.nextProbeAt - b.nextProbeAt
        || comboHealthKey(a.provider, a.model).localeCompare(comboHealthKey(b.provider, b.model)));
    },
    freezeComboModel: freeze,
    async clearComboModel({ provider, model }) {
      const pair = identity(provider, model);
      // Any success also ends a run of deadlines.
      streaks.delete(comboHealthKey(pair.provider, pair.model));
      return clear(pair);
    },
    /**
     * Record an upstream deadline. One slow answer is a property of that request; a run of them
     * without a single success in between is a property of the pair. On the threshold the pair
     * is frozen through the same backoff as any other incident, and the counter drops to
     * threshold-1 so the next deadline escalates the cooldown immediately.
     * `startedAt` keeps parallel requests that began before the last counted deadline from
     * counting twice — they are part of the same incident.
     */
    async recordUpstreamTimeout({ provider, model, startedAt } = {}) {
      const pair = identity(provider, model);
      const timestamp = now();
      const key = comboHealthKey(pair.provider, pair.model);
      const previous = streaks.get(key);
      if (previous && Number.isFinite(startedAt) && startedAt < previous.lastAt) return null;
      const inWindow = previous && timestamp - previous.lastAt <= config.timeoutStreakWindowMs;
      const count = inWindow ? previous.count + 1 : 1;
      const threshold = config.timeoutStreakThreshold;
      if (count < threshold) {
        streaks.set(key, { count, lastAt: timestamp });
        return null;
      }
      streaks.set(key, { count: threshold - 1, lastAt: timestamp });
      return freeze({
        provider: pair.provider, model: pair.model, status: 504,
        reason: `Upstream timed out ${count} times in a row`,
      });
    },
  };
}

const defaultService = createComboHealthService();

export const { getComboHealth, listComboHealth, freezeComboModel, clearComboModel, recordUpstreamTimeout } = defaultService;
