"use client";

// One price cell: the number, where it came from, and why to distrust it.
//
// An absent cache rate is NOT $0 and NOT "same as input": the cost calculator
// silently falls back to the input rate, so the cell says "—" and the tooltip
// states which rate is actually billed. That distinction is the whole point of
// this view.

import PropTypes from "prop-types";
import Tooltip from "@/shared/components/Tooltip";
import { formatPricePerM } from "@/shared/utils/modelMeta";

const SOURCE_LABELS = {
  provider: "Provider's own catalog",
  "models.dev": "models.dev",
  "provider-table": "Static table (provider rates)",
  "model-table": "Static table (canonical model rates)",
  pattern: "Static table (pattern guess)",
  free: "Free lane ($0)",
  manual: "Manual override",
  stored: "Imported (source unknown)",
};

const SOURCE_COLORS = {
  provider: "#22c55e",
  "models.dev": "#3b82f6",
  manual: "#a855f7",
  free: "#6b7280",
  "provider-table": "#9ca3af",
  "model-table": "#9ca3af",
  pattern: "#9ca3af",
  stored: "#9ca3af",
};

const FIELD_LABELS = {
  input: "Input",
  output: "Output",
  cached: "Cache read",
  cache_creation: "Cache write",
};

function sourceLabel(source) {
  return SOURCE_LABELS[source] || "Unknown source";
}

function formatUpdated(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export default function PriceCell({ row, field, showSource = false }) {
  const value = row.pricing?.[field];
  const source = row.pricingSource || {};
  const fallback = source.fallbacks?.[field];
  const published = typeof value === "number" && Number.isFinite(value);

  const sourceLine = [
    sourceLabel(source.source),
    formatUpdated(source.updatedAt) ? `updated ${formatUpdated(source.updatedAt)}` : null,
    source.verified ? "verified" : null,
  ].filter(Boolean).join(" · ");

  let display;
  let tooltip;

  if (published) {
    display = formatPricePerM(value);
    const warnings = (source.warnings || [])
      .filter((warning) => warning.code !== "cache-not-published" && warning.code !== "cache-write-not-published")
      .map((warning) => warning.message);
    tooltip = [`${FIELD_LABELS[field]}: $${display}/1M`, sourceLine, ...warnings]
      .filter(Boolean)
      .join("\n");
  } else if (fallback) {
    const reference = row.pricing?.[fallback];
    display = "—";
    tooltip = [
      `${FIELD_LABELS[field]}: not published`,
      reference !== undefined
        ? `Cost is computed at the ${fallback} rate ($${formatPricePerM(reference)}/1M)`
        : `Cost falls back to the ${fallback} rate`,
      sourceLine,
    ].filter(Boolean).join("\n");
  } else {
    display = "—";
    tooltip = [`${FIELD_LABELS[field]}: not published`, sourceLine].filter(Boolean).join("\n");
  }

  const hasWarning = (source.warnings || []).length > 0;

  return (
    <Tooltip text={tooltip}>
      <span className="inline-flex items-center justify-end gap-1 tabular-nums">
        {showSource && (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: SOURCE_COLORS[source.source] || "#9ca3af" }}
          />
        )}
        <span className={published ? "text-text-main" : "text-text-muted"}>{display}</span>
        {showSource && hasWarning && (
          <span className="material-symbols-outlined text-[13px] text-yellow-500">error</span>
        )}
      </span>
    </Tooltip>
  );
}

PriceCell.propTypes = {
  row: PropTypes.shape({
    pricing: PropTypes.object,
    pricingSource: PropTypes.shape({
      source: PropTypes.string,
      updatedAt: PropTypes.string,
      verified: PropTypes.bool,
      fallbacks: PropTypes.object,
      warnings: PropTypes.array,
    }),
  }).isRequired,
  field: PropTypes.oneOf(["input", "output", "cached", "cache_creation"]).isRequired,
  showSource: PropTypes.bool,
};

export { SOURCE_LABELS, sourceLabel };