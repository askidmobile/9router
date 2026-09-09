import { GEMINI_FLEX_TIMEOUT_MS, GEMINI_SERVICE_TIERS } from "./gemini.js";
import { splitGeminiModelId } from "../utils/geminiModels.js";

// Combo budgets are independent of the longer direct-request provider budgets.
// Invalid overrides use defaults; valid positive integers are bounded to avoid
// overflowing timers or disabling recovery through an accidental env value.
function envInteger(env, name, fallback, maximum) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

export function loadComboHealthConfig(env = process.env) {
  const maxTimerMs = 6 * 60 * 60 * 1000;
  const baseCooldownMs = envInteger(env, "COMBO_BASE_COOLDOWN_MS", 60_000, maxTimerMs);
  return Object.freeze({
    firstResponseTimeoutMs: envInteger(env, "COMBO_FIRST_RESPONSE_TIMEOUT_MS", 45_000, maxTimerMs),
    requestTimeoutMs: envInteger(env, "COMBO_REQUEST_TIMEOUT_MS", 120_000, maxTimerMs),
    streamIdleTimeoutMs: envInteger(env, "COMBO_STREAM_IDLE_TIMEOUT_MS", 45_000, maxTimerMs),
    probeTimeoutMs: envInteger(env, "COMBO_PROBE_TIMEOUT_MS", 45_000, maxTimerMs),
    baseCooldownMs,
    maxCooldownMs: Math.max(baseCooldownMs, envInteger(env, "COMBO_MAX_COOLDOWN_MS", 1_800_000, maxTimerMs)),
    probeIntervalMs: envInteger(env, "COMBO_PROBE_INTERVAL_MS", 5_000, maxTimerMs),
    probeLeaseGraceMs: envInteger(env, "COMBO_PROBE_LEASE_GRACE_MS", 5_000, maxTimerMs),
    probeMaxTokens: envInteger(env, "COMBO_PROBE_MAX_TOKENS", 1_024, 4_096),
    maxBufferedBytes: envInteger(env, "COMBO_MAX_BUFFERED_BYTES", 1_048_576, 16_777_216),
    probePrompt: "Reply with exactly OK.",
  });
}

export const COMBO_HEALTH_CONFIG = loadComboHealthConfig();

export function getComboProbeTimeoutMs(provider, model, config = COMBO_HEALTH_CONFIG) {
  return provider === "gemini" && splitGeminiModelId(model).serviceTier === GEMINI_SERVICE_TIERS.flex
    ? GEMINI_FLEX_TIMEOUT_MS : config.probeTimeoutMs;
}

export const COMBO_HEALTH_STORAGE_CONFIG = Object.freeze({
  scope: "comboModelHealth",
  lockKey: "__transaction_lock__",
  reasonMaxLength: 240,
  reasonInputMaxLength: 4_096,
  identityMaxLength: 1_024,
  maxFailureCount: 1_000,
});
