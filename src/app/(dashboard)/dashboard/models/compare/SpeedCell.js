"use client";

import PropTypes from "prop-types";
import Tooltip from "@/shared/components/Tooltip";
import { useTranslation } from "@/i18n/useTranslation";

export default function SpeedCell({ health = {} }) {
  const t = useTranslation();
  const speed = health?.tokensPerSecond;
  const measured = typeof speed === "number" && Number.isFinite(speed);
  const tooltip = measured
    ? [
      health.speedProvider ? t("Fastest measured provider: {provider}", { provider: health.speedProvider }) : null,
      t("Observed output: {speed} tok/s", { speed: speed.toLocaleString(undefined, { maximumFractionDigits: 1 }) }),
      t("{count} streamed responses in 24h", { count: health.speedSamples || 0 }),
      t("Provider-reported output tokens / time from first output to completion. Waiting is excluded; thinking is included only when part of the provider's output total."),
    ].filter(Boolean).join("\n")
    : t("No measured streaming speed yet. New responses with provider-reported usage will appear here; estimated tokens are excluded.");
  return (
    <Tooltip text={tooltip} position="left">
      <span className="inline-flex flex-col items-end tabular-nums">
        <span className={measured ? "text-text-main" : "text-text-muted"}>
          {measured ? speed.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "—"}
        </span>
        {typeof health?.avgTtft === "number" && (
          <span className="text-[10px] text-text-muted">{(health.avgTtft / 1000).toFixed(1)}s TTFT</span>
        )}
      </span>
    </Tooltip>
  );
}

SpeedCell.propTypes = {
  health: PropTypes.shape({ tokensPerSecond: PropTypes.number, speedSamples: PropTypes.number, avgTtft: PropTypes.number, speedProvider: PropTypes.string }),
};
