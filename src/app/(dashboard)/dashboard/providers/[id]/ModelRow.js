import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";
import { usePricing } from "@/shared/hooks/usePricing";
import { formatModelMeta } from "@/shared/utils/modelMeta";

// Icon button with hover tooltip — shared by the right action column.
function ActionIcon({ onClick, title, label, className = "", alwaysVisible = false, children, disabled = false }) {
  return (
    <div className="relative shrink-0 group/btn">
      <button
        onClick={onClick}
        title={title}
        disabled={disabled}
        className={`rounded p-0.5 text-text-muted transition-opacity hover:bg-sidebar ${className} ${alwaysVisible ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"}`}
      >
        {children}
      </button>
      <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
        {label}
      </span>
    </div>
  );
}

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, onEdit, hasOverride, caps, thinkingSuffix }) {
  const { getPricing } = usePricing();
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const providerKey = fullModel.includes("/") ? fullModel.slice(0, fullModel.indexOf("/")) : null;
  const meta = formatModelMeta(caps, getPricing(providerKey, model.id));
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`group min-w-0 max-w-full rounded-lg border px-3 py-2 ${borderColor} hover:bg-sidebar/50`}>
      <div className="flex min-w-0 items-start gap-2">
        {/* Left: 3 info rows */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Row 1 — display name */}
          <span className="truncate text-sm font-medium text-text-main">
            {alias || model.name || model.id}
          </span>
          {/* Row 2 — routed id + copy on hover */}
          <div className="flex min-w-0 items-center gap-1.5">
            <code className="max-w-[72vw] truncate rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs text-text-muted sm:max-w-[360px]">{displayModel}</code>
            <ActionIcon
              onClick={() => onCopy(displayModel, `model-${model.id}`)}
              label={copied === `model-${model.id}` ? "Copied!" : "Copy"}
            >
              <span className="material-symbols-outlined text-[13px]">
                {copied === `model-${model.id}` ? "check" : "content_copy"}
              </span>
            </ActionIcon>
            {isFree && <span className="text-[10px] font-bold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">FREE</span>}
          </div>
          {/* Row 3 — capabilities, ctx/out/prices, configured */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-0.5">
            <CapacityBadges caps={caps} colorOverride="text-text-muted/70" size={12} />
            {meta && <span className="truncate text-[9px] text-text-muted/70">{meta}</span>}
            {hasOverride && (
              <span className="text-[9px] font-semibold uppercase text-primary bg-primary/10 px-1 py-px rounded">configured</span>
            )}
          </div>
        </div>

        {/* Right: action column (test / settings / delete) */}
        <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
          {onTest && (
            <ActionIcon
              onClick={onTest}
              disabled={isTesting}
              alwaysVisible={isTesting}
              label={isTesting ? "Testing..." : "Test"}
              className="hover:text-primary"
            >
              <span className="material-symbols-outlined text-[13px]" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
            </ActionIcon>
          )}
          {onEdit && (
            <ActionIcon
              onClick={onEdit}
              title="Edit model capabilities / pricing"
              label={hasOverride ? "Configured" : "Settings"}
              alwaysVisible={!!hasOverride}
              className={hasOverride ? "text-primary" : "hover:text-primary"}
            >
              <span className="material-symbols-outlined text-[13px]">tune</span>
            </ActionIcon>
          )}
          {isCustom ? (
            <ActionIcon
              onClick={onDeleteAlias}
              title="Remove custom model"
              label="Remove"
              className="hover:text-red-500"
            >
              <span className="material-symbols-outlined text-[13px]">close</span>
            </ActionIcon>
          ) : onDisable ? (
            <ActionIcon
              onClick={onDisable}
              title="Disable this model"
              label="Disable"
              className="hover:text-red-500"
            >
              <span className="material-symbols-outlined text-[13px]">close</span>
            </ActionIcon>
          ) : null}
        </div>
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  onEdit: PropTypes.func,
  hasOverride: PropTypes.bool,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
};
