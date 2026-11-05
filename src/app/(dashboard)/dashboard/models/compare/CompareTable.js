"use client";

// Model-centric comparison table: one row per model, one sub-row per provider.
//
// Everything the user asked to compare lives in the columns: context, max
// output, the four price directions, and health. Sorting works on the group
// summary (cheapest provider, widest context, worst status) so the answer to
// "where is this model cheapest / most reliable" is one click away.

import { Fragment } from "react";
import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import CapacityBadges from "@/shared/components/CapacityBadges";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { formatTokenCount } from "@/shared/utils/modelMeta";
import { MODEL_STATUS_META } from "@/shared/utils/modelStatus";
import PriceCell from "./PriceCell";
import StatusCell from "./StatusCell";
import { summarizeGroup } from "./summary";

const COLUMNS = [
  { key: "model", label: "Model", sortKey: "name" },
  { key: "provider", label: "Provider" },
  { key: "contextWindow", label: "Context", sortKey: "contextWindow", align: "right" },
  { key: "maxOutput", label: "Max out", sortKey: "maxOutput", align: "right" },
  { key: "input", label: "$ in", sortKey: "input", align: "right" },
  { key: "output", label: "$ out", sortKey: "output", align: "right" },
  { key: "cached", label: "$ cache read", sortKey: "cached", align: "right" },
  { key: "cache_creation", label: "$ cache write", sortKey: "cache_creation", align: "right" },
  { key: "status", label: "Status", sortKey: "status", align: "right" },
  { key: "requests", label: "24h", sortKey: "requests", align: "right" },
  { key: "actions", label: "" },
];

function SortLabel({ column, sort, onSortChange }) {
  if (!column.sortKey) return <span>{column.label}</span>;
  const active = sort?.key === column.sortKey;
  return (
    <button
      type="button"
      onClick={() => onSortChange(column.sortKey)}
      className={`inline-flex items-center gap-0.5 uppercase tracking-wide transition-colors ${
        active ? "text-text-main" : "text-text-muted hover:text-text-main"
      }`}
    >
      {column.label}
      <span className="material-symbols-outlined text-[13px]">
        {active ? (sort.dir === "asc" ? "arrow_upward" : "arrow_downward") : "unfold_more"}
      </span>
    </button>
  );
}

SortLabel.propTypes = {
  column: PropTypes.shape({ label: PropTypes.string, sortKey: PropTypes.string }).isRequired,
  sort: PropTypes.shape({ key: PropTypes.string, dir: PropTypes.string }),
  onSortChange: PropTypes.func.isRequired,
};

function GroupRow({ group, expanded, onToggle }) {
  const summary = summarizeGroup(group);
  const meta = MODEL_STATUS_META[summary.statusState] || MODEL_STATUS_META.unknown;
  const ctx = formatTokenCount(summary.contextWindow);
  const out = formatTokenCount(summary.maxOutput);
  const cheapestRow = summary.pricing.input !== null
    ? group.providers.find((row) => row.pricing?.input === summary.pricing.input)
    : null;

  return (
    <tr
      className="bg-surface-2/60 hover:bg-surface-2 cursor-pointer border-t border-border"
      onClick={onToggle}
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-base text-text-muted">
            {expanded ? "expand_more" : "chevron_right"}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-main truncate">{group.name}</p>
            <p className="text-[11px] font-mono text-text-muted truncate">{group.id}</p>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">
        {summary.providers} provider{summary.providers === 1 ? "" : "s"}
        {cheapestRow ? ` · cheapest ${cheapestRow.providerAlias}` : ""}
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums">{ctx || "—"}</td>
      <td className="px-3 py-2 text-right text-xs tabular-nums">{out || "—"}</td>
      {["input", "output", "cached", "cache_creation"].map((field) => (
        <td key={field} className="px-3 py-2 text-right text-xs">
          <PriceCell row={{ pricing: summary.pricing, pricingSource: { warnings: [] } }} field={field} />
        </td>
      ))}
      <td className="px-3 py-2 text-right">
        <Badge variant={meta.tone === "default" ? "default" : meta.tone} size="sm" dot>
          {meta.label}
        </Badge>
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums text-text-muted">
        {summary.requests > 0 ? summary.requests : "—"}
      </td>
      <td className="px-3 py-2" />
    </tr>
  );
}

GroupRow.propTypes = {
  group: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    providers: PropTypes.array.isRequired,
  }).isRequired,
  expanded: PropTypes.bool,
  onToggle: PropTypes.func.isRequired,
};

function ProviderRow({ row, provider, onEdit, onClearCooldown }) {
  const ctx = formatTokenCount(row.caps?.contextWindow);
  const out = formatTokenCount(row.caps?.maxOutput);

  return (
    <tr
      className="border-t border-border-subtle hover:bg-sidebar/50 cursor-pointer"
      onClick={() => onEdit(row)}
    >
      <td className="px-3 py-2 pl-9">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-text-muted">↳</span>
          <code className="text-[11px] text-text-main bg-surface-2 px-1.5 py-0.5 rounded">{row.id}</code>
          {row.isCustom && <Badge variant="primary" size="sm">Custom</Badge>}
          {row.disabled && <Badge size="sm">Disabled</Badge>}
          <CapacityBadges caps={row.caps} size={12} />
        </div>
        {row.alias && (
          <p className="text-[11px] text-text-muted mt-0.5">Alias: <code>{row.alias}</code></p>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <ProviderIcon
            providerId={provider?.iconId || row.providerId}
            size={16}
            fallbackText={(provider?.name || row.providerAlias).charAt(0)}
          />
          <span className="text-xs text-text-main truncate">{provider?.name || row.providerAlias}</span>
          {provider?.active === false && (
            <span className="text-[10px] text-text-muted">(not connected)</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums">{ctx || "—"}</td>
      <td className="px-3 py-2 text-right text-xs tabular-nums">{out || "—"}</td>
      <td className="px-3 py-2 text-right text-xs"><PriceCell row={row} field="input" showSource /></td>
      <td className="px-3 py-2 text-right text-xs"><PriceCell row={row} field="output" /></td>
      <td className="px-3 py-2 text-right text-xs"><PriceCell row={row} field="cached" /></td>
      <td className="px-3 py-2 text-right text-xs"><PriceCell row={row} field="cache_creation" /></td>
      <td className="px-3 py-2"><StatusCell row={row} onClearCooldown={onClearCooldown} /></td>
      <td className="px-3 py-2 text-right text-xs tabular-nums text-text-muted">
        {row.health?.requests > 0 ? row.health.requests : "—"}
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(row);
          }}
          title="Edit model"
          className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar"
        >
          <span className="material-symbols-outlined text-[16px]">edit</span>
        </button>
      </td>
    </tr>
  );
}

ProviderRow.propTypes = {
  row: PropTypes.object.isRequired,
  provider: PropTypes.object,
  onEdit: PropTypes.func.isRequired,
  onClearCooldown: PropTypes.func,
};

export default function CompareTable({
  groups,
  providers,
  expandedKeys,
  onToggleGroup,
  onEdit,
  onClearCooldown,
  sort,
  onSortChange,
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[1040px] border-collapse">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-text-muted">
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className={`px-3 py-2 font-semibold whitespace-nowrap ${
                  column.align === "right" ? "text-right" : "text-left"
                }`}
              >
                <SortLabel column={column} sort={sort} onSortChange={onSortChange} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const expanded = expandedKeys.has(group.identity);
            return (
              <Fragment key={group.identity}>
                <GroupRow
                  group={group}
                  expanded={expanded}
                  onToggle={() => onToggleGroup(group.identity)}
                />
                {expanded &&
                  group.providers.map((row) => (
                    <ProviderRow
                      key={row.key}
                      row={row}
                      provider={providers?.[row.providerAlias]}
                      onEdit={onEdit}
                      onClearCooldown={onClearCooldown}
                    />
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

CompareTable.propTypes = {
  groups: PropTypes.array.isRequired,
  providers: PropTypes.object,
  expandedKeys: PropTypes.instanceOf(Set).isRequired,
  onToggleGroup: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onClearCooldown: PropTypes.func,
  sort: PropTypes.shape({ key: PropTypes.string, dir: PropTypes.string }),
  onSortChange: PropTypes.func.isRequired,
};