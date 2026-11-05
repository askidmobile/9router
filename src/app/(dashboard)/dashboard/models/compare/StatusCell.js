"use client";

// Health cell: does this provider|model answer right now, and how has it been
// behaving over the last day.

import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import Tooltip from "@/shared/components/Tooltip";

function pct(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
}

export default function StatusCell({ row, onClearCooldown }) {
  const status = row.status || { state: "unknown", label: "No traffic", tone: "default" };
  const health = row.health || {};
  const errorRate = pct(health.errorRate);

  const tooltip = [
    `${status.label} — ${health.requests || 0} requests in 24h`,
    errorRate ? `Errors: ${errorRate} (${health.err || 0} of ${health.requests || 0})` : null,
    health.avgLatency ? `Avg latency: ${health.avgLatency} ms` : null,
    health.rateLimited ? `429: ${health.rateLimited}` : null,
    health.serverErrors ? `5xx: ${health.serverErrors}` : null,
    health.timeouts ? `Timeouts: ${health.timeouts}` : null,
    health.lastErrorAt ? `Last error: ${new Date(health.lastErrorAt).toLocaleString()}` : null,
    health.lastError ? `“${health.lastError}”` : null,
  ].filter(Boolean).join("\n");

  const canClear = status.state === "cooldown" || status.state === "down";

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip text={tooltip}>
        <span className="inline-flex flex-col items-end gap-0.5">
          <Badge variant={status.tone === "default" ? "default" : status.tone} size="sm" dot>
            {status.label}
          </Badge>
          {health.requests > 0 && (
            <span className="text-[10px] text-text-muted tabular-nums">
              {errorRate && health.err > 0 ? `${errorRate} err · ` : ""}
              {health.requests} req
            </span>
          )}
        </span>
      </Tooltip>
      {canClear && onClearCooldown && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClearCooldown(row);
          }}
          title="Clear cooldown"
          className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar"
        >
          <span className="material-symbols-outlined text-[15px]">restart_alt</span>
        </button>
      )}
    </div>
  );
}

StatusCell.propTypes = {
  row: PropTypes.shape({
    status: PropTypes.shape({ state: PropTypes.string, label: PropTypes.string, tone: PropTypes.string }),
    health: PropTypes.shape({
      requests: PropTypes.number,
      err: PropTypes.number,
      errorRate: PropTypes.number,
      avgLatency: PropTypes.number,
      rateLimited: PropTypes.number,
      serverErrors: PropTypes.number,
      timeouts: PropTypes.number,
      lastError: PropTypes.string,
      lastErrorAt: PropTypes.string,
    }),
  }).isRequired,
  onClearCooldown: PropTypes.func,
};