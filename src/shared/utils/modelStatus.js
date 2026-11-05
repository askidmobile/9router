// Model health status, shared by the catalog API and the dashboard.
//
// The thresholds are deliberately boring: a status page that cries wolf on one
// failed request is worse than no status page. Anything under five samples is
// "unknown" rather than a percentage.

export const MODEL_STATUS_META = {
  ok: { label: "Operational", icon: "check_circle", color: "#22c55e", tone: "success" },
  degraded: { label: "Degraded", icon: "warning", color: "#f59e0b", tone: "warning" },
  down: { label: "Down", icon: "error", color: "#ef4444", tone: "error" },
  cooldown: { label: "Cooldown", icon: "schedule", color: "#f59e0b", tone: "warning" },
  unknown: { label: "No traffic", icon: "help", color: "#6b7280", tone: "default" },
};

export const MIN_SAMPLES = 5;
const DEGRADED_ERROR_RATE = 0.1;
const DOWN_ERROR_RATE = 0.5;

/**
 * @param {object} params
 * @param {object|null} params.summary - summarizeHealth() over 24h
 * @param {object|null} [params.recent] - summarizeHealth() over the last hour
 * @param {{state?: string, until?: string|number|null}|null} [params.lock]
 * @returns {{state: string, label: string, icon: string, color: string, tone: string, errorRate: number|null}}
 */
export function deriveModelStatus({ summary, recent, lock } = {}) {
  const state = (value, errorRate = summary?.errorRate ?? null) => ({
    state: value,
    ...MODEL_STATUS_META[value],
    errorRate,
  });

  // A live block (cooldown lock, account-wide failure) overrides telemetry: the
  // router will refuse this pair right now regardless of yesterday's success rate.
  if (lock?.state) {
    if (lock.state === "unavailable" || lock.model === "__all") return state("down");
    return state("cooldown");
  }

  const requests = summary?.requests || 0;
  const errorRate = summary?.errorRate;
  if (requests < MIN_SAMPLES || errorRate === null || errorRate === undefined) {
    return state("unknown");
  }
  if (errorRate >= DOWN_ERROR_RATE) return state("down");
  if (errorRate >= DEGRADED_ERROR_RATE) return state("degraded");
  if ((recent?.rateLimited || 0) > 0 || (recent?.serverErrors || 0) > 0 || (recent?.timeouts || 0) > 0) {
    return state("degraded");
  }
  return state("ok");
}