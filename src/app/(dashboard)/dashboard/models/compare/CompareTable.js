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
import Tooltip from "@/shared/components/Tooltip";
import { formatTokenCount } from "@/shared/utils/modelMeta";
import { MODEL_STATUS_META } from "@/shared/utils/modelStatus";
import PriceCell from "./PriceCell";
import StatusCell from "./StatusCell";
import SpeedCell from "./SpeedCell";
import { summarizeGroup } from "./summary";

const COLUMNS = [
  { key: "model", label: "Model", sortKey: "name", width: "23%" },
  { key: "provider", label: "Provider", width: "15%" },
  { key: "contextWindow", label: "Ctx", title: "Context window in tokens", sortKey: "contextWindow", align: "right", width: "5.5%" },
  { key: "maxOutput", label: "Out", title: "Maximum output tokens", sortKey: "maxOutput", align: "right", width: "5.5%" },
  { key: "input", label: "$ in", title: "Input / 1M tokens", sortKey: "input", align: "right", width: "8%" },
  { key: "output", label: "$ out", title: "Output / 1M tokens", sortKey: "output", align: "right", width: "6%" },
  { key: "cached", label: "Cache read", title: "Cache read / 1M tokens", sortKey: "cached", align: "right", width: "7%" },
  { key: "cache_creation", label: "Cache write", title: "Cache write / 1M tokens", sortKey: "cache_creation", align: "right", width: "7%" },
  { key: "speed", label: "tok/s", title: "Observed output speed; waiting for first output excluded", sortKey: "speed", align: "right", width: "7%" },
  { key: "status", label: "Status", title: "Status / 24h", sortKey: "status", align: "right", width: "10%" },
  { key: "actions", label: "", width: "6%" },
];

function SortLabel({ column, sort, onSortChange }) {
  if (!column.sortKey) return <span>{column.label}</span>;
  const active = sort?.key === column.sortKey;
  return (
    <button
      type="button"
      onClick={() => onSortChange(column.sortKey)}
      title={`Sort by ${column.label}`}
      className={`inline-flex max-w-full items-center gap-0.5 uppercase tracking-wide transition-colors ${
        active ? "text-text-main" : "text-text-muted hover:text-text-main"
      }`}
    >
      <span className="min-w-0 whitespace-normal leading-tight">{column.label}</span>
      {active && <span aria-hidden="true" className="material-symbols-outlined shrink-0" style={{ fontSize: 12 }}>{sort.dir === "asc" ? "arrow_upward" : "arrow_downward"}</span>}
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
      <td className="px-1.5 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`} onClick={event => { event.stopPropagation(); onToggle(); }} className="material-symbols-outlined inline-flex size-6 shrink-0 items-center justify-center rounded text-base text-text-muted focus-visible:outline-2 focus-visible:outline-primary">
            {expanded ? "expand_more" : "chevron_right"}
          </button>
          <div className="min-w-0">
            <p title={group.name} className="text-[13px] font-semibold text-text-main truncate">{group.name}</p>
            <p className="text-[11px] font-mono text-text-muted truncate">{group.id}</p>
          </div>
        </div>
      </td>
      <td className="px-1.5 py-1.5">
        <div className="min-w-0 truncate text-xs text-text-muted" title={`${summary.providers} provider${summary.providers === 1 ? "" : "s"}${cheapestRow ? ` · cheapest ${cheapestRow.providerAlias}` : ""}`}>
          {summary.providers} provider{summary.providers === 1 ? "" : "s"}
          {cheapestRow ? ` · cheapest ${cheapestRow.providerAlias}` : ""}
        </div>
      </td>
      <td className="px-1.5 py-1.5 text-right text-xs tabular-nums">{ctx || "—"}</td>
      <td className="px-1.5 py-1.5 text-right text-xs tabular-nums">{out || "—"}</td>
      {["input", "output", "cached", "cache_creation"].map((field) => (
        <td key={field} className="px-1.5 py-1.5 text-right text-xs">
          <PriceCell row={{ pricing: summary.pricing, pricingSource: { warnings: [] } }} field={field} />
        </td>
      ))}
      <td className="px-1.5 py-1.5 text-right text-xs"><SpeedCell health={summary} /></td>
      <td className="px-1.5 py-1.5 text-right">
        <Badge variant={meta.tone === "default" ? "default" : meta.tone} size="sm" dot>
          {meta.label}
        </Badge>
        <div className="text-[10px] tabular-nums text-text-muted">{summary.requests > 0 ? summary.requests.toLocaleString() : "—"}</div>
      </td>
      <td className="px-1.5 py-1.5" />
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
      <td className="px-1.5 py-1.5 pl-4">
        <div className="flex min-w-0 items-center gap-1">
          <span className="text-xs text-text-muted">↳</span>
          <code title={row.id} className="min-w-0 whitespace-normal [overflow-wrap:anywhere] text-[11px] text-text-main bg-surface-2 px-1 py-0.5 rounded">{row.id}</code>
          {row.isCustom && <Tooltip text="Custom model"><span role="img" aria-label="Custom model" className="material-symbols-outlined text-[13px] text-primary">person</span></Tooltip>}
          {row.disabled && <Tooltip text="Disabled"><span role="img" aria-label="Disabled" className="material-symbols-outlined text-[13px] text-text-muted">visibility_off</span></Tooltip>}
          <span className="shrink-0"><CapacityBadges caps={row.caps} size={12} /></span>
        </div>
        {row.alias && (
          <p className="text-[11px] text-text-muted mt-0.5">Alias: <code>{row.alias}</code></p>
        )}
      </td>
      <td className="px-1.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          <ProviderIcon
            providerId={provider?.iconId || row.providerId}
            size={16}
            fallbackText={(provider?.name || row.providerAlias).charAt(0)}
          />
          <span className="truncate text-[11px] text-text-main" title={provider?.name || row.providerAlias}>
            {provider?.name || row.providerAlias}
          </span>
          {provider?.active === false && (
            <span className="shrink-0 text-[10px] text-text-muted">(off)</span>
          )}
        </div>
      </td>
      <td className="px-1.5 py-1.5 text-right text-xs tabular-nums">{ctx || "—"}</td>
      <td className="px-1.5 py-1.5 text-right text-xs tabular-nums">{out || "—"}</td>
      <td className="px-1.5 py-1.5 text-right text-xs"><PriceCell row={row} field="input" showSource /></td>
      <td className="px-1.5 py-1.5 text-right text-xs"><PriceCell row={row} field="output" /></td>
      <td className="px-1.5 py-1.5 text-right text-xs"><PriceCell row={row} field="cached" /></td>
      <td className="px-1.5 py-1.5 text-right text-xs"><PriceCell row={row} field="cache_creation" /></td>
      <td className="px-1.5 py-1.5 text-right text-xs"><SpeedCell health={row.health} /></td>
      <td className="px-1.5 py-1.5"><StatusCell row={row} /></td>
      <td className="px-0.5 py-1.5">
        <div className="flex items-center justify-end gap-0.5">
        {onClearCooldown && ["cooldown", "down"].includes(row.status?.state) && (
          <button type="button" title="Clear cooldown" aria-label={`Clear cooldown for ${row.id}`} className="inline-flex size-6 shrink-0 items-center justify-center rounded text-text-muted hover:text-primary hover:bg-sidebar" onClick={event => { event.stopPropagation(); onClearCooldown(row); }}>
            <span className="material-symbols-outlined text-[15px]">restart_alt</span>
          </button>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onEdit(row);
          }}
          title="Edit model"
          aria-label={`Edit ${row.id}`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-text-muted hover:text-primary hover:bg-sidebar"
        >
          <span className="material-symbols-outlined text-[16px]">edit</span>
        </button>
        </div>
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
    <div className="max-h-[calc(100dvh-20rem)] overflow-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[900px] table-fixed border-collapse text-text-main">
        <caption className="sr-only">Model comparison. Prices in USD per million tokens; observed streaming output speed in tokens per second.</caption>
        <colgroup>{COLUMNS.map(column => <col key={column.key} style={{ width: column.width }} />)}</colgroup>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="text-[10px] uppercase tracking-wide text-text-muted">
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className={`px-1.5 py-1.5 font-semibold whitespace-nowrap ${
                  column.align === "right" ? "text-right" : "text-left"
                }`}
                title={column.title}
                aria-sort={sort && (sort.key === column.sortKey || (column.key === "status" && sort.key === "requests")) ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
              >
                {column.key === "status" ? (
                  <div className="flex items-center justify-end gap-0.5">
                    <SortLabel column={column} sort={sort} onSortChange={onSortChange} />
                    <span>/</span>
                    <SortLabel column={{ label: "24h", sortKey: "requests" }} sort={sort} onSortChange={onSortChange} />
                  </div>
                ) : <SortLabel column={column} sort={sort} onSortChange={onSortChange} />}
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
