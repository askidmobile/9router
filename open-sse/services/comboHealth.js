import { randomUUID } from "node:crypto";
import { COMBO_HEALTH_CONFIG, COMBO_HEALTH_STORAGE_CONFIG, getComboProbeTimeoutMs } from "../config/comboHealth.js";
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

export function comboHealthNextProbeAt({ now, failureCount, retryAfterMs, config = COMBO_HEALTH_CONFIG }) {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 30);
  const delay = Math.min(config.baseCooldownMs * 2 ** exponent, config.maxCooldownMs);
  // retryAfterMs is an absolute deadline (the same convention as account cooldowns).
  const retryDeadline = Number.isFinite(retryAfterMs)
    ? Math.min(Math.max(now, retryAfterMs), now + MAX_RATE_LIMIT_COOLDOWN_MS)
    : now;
  return Math.max(now + delay, retryDeadline);
}

export function createComboHealthService({
  repository = comboHealthRepository,
  now = Date.now,
  createToken = randomUUID,
  config = COMBO_HEALTH_CONFIG,
} = {}) {
  return {
    async getComboHealth(provider, model) {
      const pair = identity(provider, model);
      return repository.get(pair.provider, pair.model);
    },
    async listComboHealth() {
      return (await repository.list()).sort((a, b) => a.nextProbeAt - b.nextProbeAt
        || comboHealthKey(a.provider, a.model).localeCompare(comboHealthKey(b.provider, b.model)));
    },
    async freezeComboModel({ provider, model, status, reason, retryAfterMs }) {
      const pair = identity(provider, model);
      return repository.transaction((tx) => {
        const timestamp = now();
        const previous = tx.get(pair.provider, pair.model);
        const failureCount = previous?.failureCount || 1;
        const record = {
          ...pair,
          state: "open",
          failureCount,
          openedAt: previous?.openedAt ?? timestamp,
          lastFailureAt: timestamp,
          nextProbeAt: Math.max(previous?.nextProbeAt || 0,
            comboHealthNextProbeAt({ now: timestamp, failureCount, retryAfterMs, config })),
          lastProbeAt: previous?.lastProbeAt ?? null,
          // An in-flight probe invalidated by a newer foreground failure may
          // still be using the network. Retain its global lease until expiry.
          leaseUntil: previous?.leaseUntil > timestamp ? previous.leaseUntil : null,
          probeToken: null,
          lastStatus: safeStatus(status),
          lastReason: sanitizeComboHealthReason(reason),
        };
        tx.set(record);
        return record;
      });
    },
    async claimDueComboProbe({ eligiblePairs } = {}) {
      const eligible = eligiblePairs === undefined ? null : new Set(eligiblePairs.map((pair) => {
        const normalized = identity(pair.provider, pair.model);
        return comboHealthKey(normalized.provider, normalized.model);
      }));
      return repository.transaction((tx) => {
        const timestamp = now();
        const records = tx.list();
        if (records.some((record) => record.leaseUntil > timestamp)) return null;
        const due = records.filter((record) => record.nextProbeAt <= timestamp
          && (!eligible || eligible.has(comboHealthKey(record.provider, record.model))))
          .sort((a, b) => a.nextProbeAt - b.nextProbeAt
            || comboHealthKey(a.provider, a.model).localeCompare(comboHealthKey(b.provider, b.model)))[0];
        if (!due) return null;
        const record = {
          ...due,
          state: "probing",
          lastProbeAt: timestamp,
          leaseUntil: timestamp + getComboProbeTimeoutMs(due.provider, due.model, config) + config.probeLeaseGraceMs,
          probeToken: createToken(),
        };
        tx.set(record);
        return record;
      });
    },
    async finishComboProbe({ provider, model, probeToken, success, status, reason, retryAfterMs, cancelled = false }) {
      const pair = identity(provider, model);
      return repository.transaction((tx) => {
        const timestamp = now();
        const previous = tx.get(pair.provider, pair.model);
        if (!probeToken || previous?.state !== "probing" || previous.probeToken !== probeToken
          || previous.leaseUntil <= timestamp) return false;
        if (success && !cancelled) {
          tx.remove(pair.provider, pair.model);
          return true;
        }
        const failureCount = cancelled ? previous.failureCount : Math.min(previous.failureCount + 1, maxFailureCount);
        tx.set({
          ...previous,
          state: "open",
          failureCount,
          lastFailureAt: cancelled ? previous.lastFailureAt : timestamp,
          nextProbeAt: cancelled ? Math.max(previous.nextProbeAt, timestamp + config.probeIntervalMs)
            : comboHealthNextProbeAt({ now: timestamp, failureCount, retryAfterMs, config }),
          leaseUntil: null,
          probeToken: null,
          lastStatus: cancelled ? previous.lastStatus : safeStatus(status),
          lastReason: cancelled ? previous.lastReason : sanitizeComboHealthReason(reason),
        });
        return true;
      });
    },
  };
}

const defaultService = createComboHealthService();
export const { getComboHealth, listComboHealth, freezeComboModel, claimDueComboProbe, finishComboProbe } = defaultService;
