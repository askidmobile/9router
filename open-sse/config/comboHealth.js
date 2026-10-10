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
  // A frozen pair is skipped only until its cooldown ends, then the next real
  // request is the recovery attempt: a failure escalates the cooldown X, 2X,
  // 3X... per consecutive incident, a success forgets the pair. An explicit
  // provider Retry-After deadline still wins in the persistent health service.
  const baseCooldownMs = envInteger(env, "COMBO_BASE_COOLDOWN_MS", 10_000, maxTimerMs);
  return Object.freeze({
    firstResponseTimeoutMs: envInteger(env, "COMBO_FIRST_RESPONSE_TIMEOUT_MS", 45_000, maxTimerMs),
    requestTimeoutMs: envInteger(env, "COMBO_REQUEST_TIMEOUT_MS", 120_000, maxTimerMs),
    streamIdleTimeoutMs: envInteger(env, "COMBO_STREAM_IDLE_TIMEOUT_MS", 45_000, maxTimerMs),
    baseCooldownMs,
    maxCooldownMs: Math.max(baseCooldownMs, envInteger(env, "COMBO_MAX_COOLDOWN_MS", 1_800_000, maxTimerMs)),
    maxBufferedBytes: envInteger(env, "COMBO_MAX_BUFFERED_BYTES", 1_048_576, 16_777_216),
  });
}

export const COMBO_HEALTH_CONFIG = loadComboHealthConfig();

export const COMBO_HEALTH_STORAGE_CONFIG = Object.freeze({
  scope: "comboModelHealth",
  lockKey: "__transaction_lock__",
  reasonMaxLength: 240,
  reasonInputMaxLength: 4_096,
  identityMaxLength: 1_024,
  maxFailureCount: 1_000,
});
