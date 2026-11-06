"use client";

import { useCallback, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Card, CardSkeleton, CapacityBadges, ConfirmModal, SegmentedControl } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { useCatalogSnapshot } from "@/shared/hooks/useCatalogSnapshot";
import { invalidateModelCapsCache } from "@/shared/hooks/useModelCaps";
import { invalidatePricingCache } from "@/shared/hooks/usePricing";
import { formatModelMeta } from "@/shared/utils/modelMeta";
import { buildEditModel } from "@/shared/utils/editModel";
import EditModelModal from "./EditModelModal";
import CompareTable from "./compare/CompareTable";
import { downloadCatalogCsv } from "./compare/exportCsv";
import { STATUS_RANK, summarizeGroup } from "./compare/summary";

const inputClass =
  "w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary";

const VIEW_OPTIONS = [
  { value: "provider", label: "By provider" },
  { value: "model", label: "By model" },
];

const SCOPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
];

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "issues", label: "Issues only" },
  { value: "missing-price", label: "No price" },
  { value: "cache-missing", label: "Cache rate unpublished" },
];

function relativeTime(value) {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString();
}

function groupSortValue(group, key) {
  const summary = summarizeGroup(group);
  switch (key) {
    case "contextWindow":
      return summary.contextWindow;
    case "maxOutput":
      return summary.maxOutput;
    case "input":
    case "output":
    case "cached":
    case "cache_creation":
      return summary.pricing[key];
    case "status":
      return STATUS_RANK[summary.statusState] ?? 0;
    case "requests":
      return summary.requests;
    default:
      return group.name.toLowerCase();
  }
}

export default function ModelsPage() {
  const { data, loading, revalidating, error, fromCache, refresh } = useCatalogSnapshot();

  const [view, setView] = useState("provider");
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  // Active providers by default: the full registry list is mostly providers the
  // user never connected, and it buries the ones that actually serve traffic.
  const [scopeFilter, setScopeFilter] = useState("active");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState({ key: "name", dir: "asc" });
  const [collapsedProviders, setCollapsedProviders] = useState(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [action, setAction] = useState({});
  const [busy, setBusy] = useState(false);

  const providers = data?.providers || {};
  const modelGroups = useMemo(() => data?.models || [], [data]);
  const totals = data?.totals || {};
  const sources = data?.sources || {};
  const activeProviderCount = useMemo(
    () => Object.values(providers).filter((provider) => provider?.active).length,
    [providers],
  );

  // ---- provider view -------------------------------------------------------

  const providerGroups = useMemo(() => {
    const map = new Map();
    for (const group of modelGroups) {
      for (const row of group.providers) {
        const alias = row.providerAlias;
        if (!map.has(alias)) {
          const info = providers[alias] || {};
          map.set(alias, {
            key: alias,
            providerId: info.id || row.providerId,
            name: info.name || alias,
            iconId: info.iconId || row.providerId,
            active: info.active !== false,
            models: [],
          });
        }
        map.get(alias).models.push(row);
      }
    }
    for (const group of map.values()) {
      group.models.sort((a, b) => a.id.localeCompare(b.id));
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [modelGroups, providers]);

  const visibleProviderGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return providerGroups
      .map((group) => {
        if (providerFilter && group.key !== providerFilter) return null;
        if (scopeFilter === "active" && !group.active) return null;
        const models = query
          ? group.models.filter(
              (row) =>
                row.id.toLowerCase().includes(query) ||
                row.name.toLowerCase().includes(query) ||
                (row.alias || "").toLowerCase().includes(query),
            )
          : group.models;
        return models.length > 0 ? { ...group, models } : null;
      })
      .filter(Boolean);
  }, [providerGroups, search, providerFilter, scopeFilter]);

  // ---- model view ----------------------------------------------------------

  const visibleModelGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matched = modelGroups
      .map((group) => {
        let rows = group.providers;
        if (providerFilter) rows = rows.filter((row) => row.providerAlias === providerFilter);
        if (scopeFilter === "active") rows = rows.filter((row) => row.active);
        if (statusFilter === "issues") {
          rows = rows.filter((row) => ["degraded", "down", "cooldown"].includes(row.status?.state));
        } else if (statusFilter === "missing-price") {
          rows = rows.filter((row) => !row.pricing || Object.keys(row.pricing).length === 0);
        } else if (statusFilter === "cache-missing") {
          rows = rows.filter((row) => row.pricingSource?.fallbacks?.cached === "input");
        }
        if (query) {
          rows = rows.filter(
            (row) =>
              row.id.toLowerCase().includes(query) ||
              row.name.toLowerCase().includes(query) ||
              (row.alias || "").toLowerCase().includes(query) ||
              group.name.toLowerCase().includes(query),
          );
        }
        return rows.length > 0 ? { ...group, providers: rows } : null;
      })
      .filter(Boolean);

    const direction = sort.dir === "desc" ? -1 : 1;
    return matched.sort((a, b) => {
      const va = groupSortValue(a, sort.key);
      const vb = groupSortValue(b, sort.key);
      // Missing numbers always sink, in both directions: "no price" is not
      // "cheapest", and a model with no traffic is not a healthy one.
      if (va === null || va === undefined) return vb === null || vb === undefined ? 0 : 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "string" || typeof vb === "string") {
        return String(va).localeCompare(String(vb)) * direction;
      }
      return (va - vb) * direction;
    });
  }, [modelGroups, providerFilter, scopeFilter, statusFilter, search, sort]);

  const effectiveExpanded = useMemo(() => {
    // A search should reveal what matched instead of asking for another click.
    if (search.trim()) return new Set(visibleModelGroups.map((group) => group.identity));
    return expandedGroups;
  }, [search, visibleModelGroups, expandedGroups]);

  // ---- actions -------------------------------------------------------------

  const refreshAll = useCallback(async () => {
    invalidateModelCapsCache();
    invalidatePricingCache();
    await refresh();
  }, [refresh]);

  const openEdit = useCallback((row) => {
    setEditing(
      buildEditModel({
        id: row.id,
        name: row.defaultName,
        isCustom: row.isCustom,
        providerAlias: row.providerAlias,
        providerId: row.isCustom ? undefined : row.providerId,
        alias: row.alias,
        // The snapshot already carries effective caps and the resolved rate set.
        overrides: {},
        getCaps: () => row.caps,
        getPricing: () => row.pricing,
      }),
    );
  }, []);

  const handleToggleDisabled = useCallback(
    async (row) => {
      try {
        if (row.disabled) {
          await fetch(
            `/api/models/disabled?providerAlias=${encodeURIComponent(row.providerAlias)}&id=${encodeURIComponent(row.id)}`,
            { method: "DELETE" },
          );
        } else {
          await fetch("/api/models/disabled", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerAlias: row.providerAlias, ids: [row.id] }),
          });
        }
        await refresh();
      } catch (err) {
        console.log("Error toggling model:", err);
      }
    },
    [refresh],
  );

  const handleDeleteCustom = useCallback(
    (row) => {
      setConfirmState({
        title: "Delete Custom Model",
        message: `Delete ${row.providerAlias}/${row.id}?`,
        onConfirm: async () => {
          setConfirmState(null);
          try {
            await fetch(
              `/api/models/custom?providerAlias=${encodeURIComponent(row.providerAlias)}&id=${encodeURIComponent(row.id)}&type=llm`,
              { method: "DELETE" },
            );
            globalThis.dispatchEvent(new Event("customModelChanged"));
            await refresh();
          } catch (err) {
            console.log("Error deleting model:", err);
          }
        },
      });
    },
    [refresh],
  );

  const handleClearCooldown = useCallback(
    async (row) => {
      try {
        await fetch("/api/models/availability", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "clearCooldown", provider: row.providerId, model: row.id }),
        });
        await refresh();
      } catch (err) {
        console.log("Error clearing cooldown:", err);
      }
    },
    [refresh],
  );

  // The provider's own catalog is the authority (real per-key prices, limits,
  // capabilities); models.dev is only the fallback for providers that publish
  // nothing. The API reports which source answered.
  const handleCatalogImport = useCallback(
    async (group) => {
      setAction((prev) => ({ ...prev, [group.key]: { loading: true } }));
      try {
        const res = await fetch("/api/providers/import-models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: group.providerId || group.key, registerModels: true }),
        });
        const json = await res.json();
        if (!res.ok) {
          setAction((prev) => ({ ...prev, [group.key]: { error: json.error || "Import failed" } }));
          return;
        }
        setAction((prev) => ({
          ...prev,
          [group.key]: {
            message:
              `Imported ${json.pricing?.imported ?? 0} prices, ${json.caps?.imported ?? 0} capability sets from ${json.source}` +
              (json.registered?.added ? ` · added ${json.registered.added} models` : "") +
              (json.registered?.truncated ? ` (${json.registered.truncated} beyond the per-run limit)` : ""),
          },
        }));
        await refreshAll();
      } catch {
        setAction((prev) => ({ ...prev, [group.key]: { error: "Import failed" } }));
      }
    },
    [refreshAll],
  );

  const handleToggleCatalogSync = useCallback(
    async (group) => {
      const id = group.providerId || group.key;
      const current = data?.catalogSync?.providers || [];
      const next = current.includes(id) ? current.filter((provider) => provider !== id) : [...current, id];
      setBusy(true);
      try {
        const res = await fetch("/api/providers/catalog-sync", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providers: next }),
        });
        if (!res.ok) throw new Error("save failed");
        // Opting in should show current numbers now, not after the first timer tick.
        if (!current.includes(id)) {
          await fetch("/api/providers/catalog-sync", { method: "POST" }).catch(() => {});
        }
        await refreshAll();
      } catch {
        // The snapshot still shows the old value; nothing to roll back locally.
      } finally {
        setBusy(false);
      }
    },
    [data, refreshAll],
  );

  const toggleProvider = (key) => {
    setCollapsedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleModelGroup = (identity) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });
  };

  const toggleAllGroups = () => {
    if (expandedGroups.size > 0) setExpandedGroups(new Set());
    else setExpandedGroups(new Set(visibleModelGroups.map((group) => group.identity)));
  };

  const handleSortChange = (key) => {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      // A status column is most useful with the broken things on top.
      const dir = key === "requests" || key === "status" ? "desc" : "asc";
      return { key, dir };
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const providerOptions = Object.entries(providers)
    .map(([alias, info]) => ({ alias, name: info?.name || alias }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-text-muted">
            {scopeFilter === "active"
              ? `${visibleModelGroups.length} models in ${activeProviderCount} active provider${activeProviderCount === 1 ? "" : "s"}.`
              : `${totals.models ?? 0} models across ${totals.pairs ?? 0} provider entries.`}
            {sources.pricing?.lastUpdated
              ? ` Prices updated ${relativeTime(sources.pricing.lastUpdated)}.`
              : " No prices imported yet."}
            {sources.modelsDev?.fetchedAt
              ? ` models.dev: ${sources.modelsDev.providers} providers, updated ${relativeTime(
                  new Date(sources.modelsDev.fetchedAt).toISOString(),
                )}${sources.modelsDev.stale ? " (stale)" : ""}.`
              : ""}
            {fromCache ? " Showing the last saved snapshot." : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {totals.missingPrices > 0 && (
              <Badge variant="warning" size="sm">{totals.missingPrices} without prices</Badge>
            )}
            {totals.missingCachePrices > 0 && (
              <Badge variant="default" size="sm">{totals.missingCachePrices} without a cache rate</Badge>
            )}
            {totals.withWarnings > 0 && (
              <Badge variant="warning" size="sm">{totals.withWarnings} with price warnings</Badge>
            )}
            {error && <Badge variant="error" size="sm">Refresh failed: {error}</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {view === "model" && (
            <Button
              variant="secondary"
              icon="download"
              onClick={() => downloadCatalogCsv(visibleModelGroups, providers)}
            >
              CSV
            </Button>
          )}
          <Button
            variant="secondary"
            icon="refresh"
            onClick={refreshAll}
            disabled={revalidating}
            className="whitespace-nowrap"
          >
            {revalidating ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by model id, name or alias..."
            className={`${inputClass} flex-1`}
          />
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <SegmentedControl options={VIEW_OPTIONS} value={view} onChange={setView} size="sm" />
            <SegmentedControl options={SCOPE_OPTIONS} value={scopeFilter} onChange={setScopeFilter} size="sm" />
            {view === "model" && (
              <>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className={`${inputClass} w-auto`}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={toggleAllGroups}
                  title={expandedGroups.size > 0 ? "Collapse all" : "Expand all"}
                  aria-label={expandedGroups.size > 0 ? "Collapse all" : "Expand all"}
                  className="inline-flex items-center justify-center h-9 w-9 rounded-[8px] bg-surface-2 hover:bg-surface text-text-muted hover:text-text-main transition-all border border-transparent hover:border-border"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {expandedGroups.size > 0 ? "unfold_less" : "unfold_more"}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
            className={`${inputClass} sm:w-64`}
          >
            <option value="">All providers</option>
            {providerOptions.map((provider) => (
              <option key={provider.alias} value={provider.alias}>{provider.name}</option>
            ))}
          </select>
          <span className="text-xs text-text-muted">
            {view === "model"
              ? `${visibleModelGroups.length} models`
              : `${visibleProviderGroups.reduce((acc, group) => acc + group.models.length, 0)} models · ${visibleProviderGroups.length} providers`}
          </span>
        </div>
      </div>

      {/* Body */}
      {view === "model" ? (
        visibleModelGroups.length === 0 ? (
          <EmptyState
            scopeFilter={scopeFilter}
            hasActive={activeProviderCount > 0}
            onShowAll={() => setScopeFilter("all")}
          />
        ) : (
          <CompareTable
            groups={visibleModelGroups}
            providers={providers}
            expandedKeys={effectiveExpanded}
            onToggleGroup={toggleModelGroup}
            onEdit={openEdit}
            onClearCooldown={handleClearCooldown}
            sort={sort}
            onSortChange={handleSortChange}
          />
        )
      ) : visibleProviderGroups.length === 0 ? (
        <EmptyState
          scopeFilter={scopeFilter}
          hasActive={activeProviderCount > 0}
          onShowAll={() => setScopeFilter("all")}
        />
      ) : (
        visibleProviderGroups.map((group) => {
          const isCollapsed = collapsedProviders.has(group.key);
          const currentAction = action[group.key];
          const scheduled = (data?.catalogSync?.providers || []).includes(group.providerId);
          return (
            <Card key={group.key}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => toggleProvider(group.key)}
                  className="flex items-center gap-2 min-w-0 text-left hover:opacity-80 transition-opacity flex-1 py-1"
                >
                  <span className="material-symbols-outlined text-lg text-text-muted">
                    {isCollapsed ? "chevron_right" : "expand_more"}
                  </span>
                  <ProviderIcon providerId={group.iconId} size={20} fallbackText={group.name.charAt(0)} />
                  <h3 className="font-semibold text-text-main truncate">{group.name}</h3>
                  <span className="text-xs text-text-muted px-1.5 py-0.5 rounded bg-surface-2">
                    {group.models.length}
                  </span>
                  {!group.active && <Badge size="sm">Not connected</Badge>}
                </button>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleToggleCatalogSync(group)}
                    disabled={busy}
                    title={
                      scheduled
                        ? "Prices and limits refresh automatically twice a day"
                        : "Refresh prices and available models twice a day; capabilities refresh manually"
                    }
                    className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs transition-colors ${
                      scheduled
                        ? "border-primary/40 bg-primary/5 text-primary"
                        : "border-border text-text-muted hover:border-primary/40 hover:text-primary"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      {scheduled ? "autorenew" : "schedule"}
                    </span>
                    {scheduled ? "Auto" : "Auto sync"}
                  </button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="download"
                    onClick={() => handleCatalogImport(group)}
                    disabled={currentAction?.loading}
                  >
                    {currentAction?.loading ? "Importing..." : "Import pricing & capabilities"}
                  </Button>
                </div>
              </div>
              {currentAction?.message && <p className="text-xs text-green-600 my-2">{currentAction.message}</p>}
              {currentAction?.error && <p className="text-xs text-red-500 my-2">{currentAction.error}</p>}
              {!isCollapsed && (
                <div className="flex flex-col gap-1.5 mt-3">
                  {group.models.map((row) => (
                    <ModelRow
                      key={row.key}
                      row={row}
                      onEdit={() => openEdit(row)}
                      onToggleDisabled={() => handleToggleDisabled(row)}
                      onDelete={row.isCustom ? () => handleDeleteCustom(row) : null}
                    />
                  ))}
                </div>
              )}
            </Card>
          );
        })
      )}

      {editing && (
        <EditModelModal
          isOpen={!!editing}
          onClose={() => setEditing(null)}
          model={editing}
          onSaved={refreshAll}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || ""}
        message={confirmState?.message || ""}
        confirmText="Delete"
      />
    </div>
  );
}

function EmptyState({ scopeFilter, hasActive, onShowAll }) {
  // "Active" is the default now, so an empty list usually means "nothing is
  // connected yet" rather than "your search matched nothing".
  const onlyActive = scopeFilter === "active";
  return (
    <Card>
      <div className="flex flex-col items-center gap-2 py-8">
        <p className="text-sm text-text-muted">
          {onlyActive && !hasActive
            ? "No active providers — nothing is connected or enabled yet."
            : onlyActive
              ? "No models match in the active providers."
              : "No models found."}
        </p>
        {onlyActive && (
          <Button variant="secondary" size="sm" onClick={onShowAll}>
            Show all providers
          </Button>
        )}
      </div>
    </Card>
  );
}

EmptyState.propTypes = {
  scopeFilter: PropTypes.string,
  hasActive: PropTypes.bool,
  onShowAll: PropTypes.func.isRequired,
};

function ModelRow({ row, onEdit, onToggleDisabled, onDelete }) {
  const meta = formatModelMeta(row.caps, row.pricing);
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 rounded-lg border border-border-subtle hover:bg-sidebar/50 ${
        row.disabled ? "opacity-60" : ""
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-text-main truncate">{row.name}</span>
          {row.isCustom && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-semibold uppercase">
              Custom
            </span>
          )}
          {row.disabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-500 font-semibold uppercase">
              Disabled
            </span>
          )}
          <CapacityBadges caps={row.caps} size={14} />
        </div>
        <p className="text-xs text-text-muted font-mono truncate">{row.id}</p>
        {row.alias && (
          <p className="text-xs text-text-muted truncate">Alias: <code>{row.alias}</code></p>
        )}
        {meta && <p className="text-xs text-text-muted mt-0.5">{meta}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onEdit}
          title="Edit model"
          className="p-1.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
        >
          <span className="material-symbols-outlined text-base">edit</span>
        </button>
        <button
          type="button"
          onClick={onToggleDisabled}
          title={row.disabled ? "Enable model" : "Disable model"}
          className="p-1.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
        >
          <span className="material-symbols-outlined text-base">
            {row.disabled ? "visibility" : "visibility_off"}
          </span>
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="Delete custom model"
            className="p-1.5 hover:bg-red-50 rounded text-red-500"
          >
            <span className="material-symbols-outlined text-base">delete</span>
          </button>
        )}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  row: PropTypes.shape({
    key: PropTypes.string,
    providerAlias: PropTypes.string,
    id: PropTypes.string,
    name: PropTypes.string,
    alias: PropTypes.string,
    isCustom: PropTypes.bool,
    disabled: PropTypes.bool,
    caps: PropTypes.object,
    pricing: PropTypes.object,
  }).isRequired,
  onEdit: PropTypes.func.isRequired,
  onToggleDisabled: PropTypes.func.isRequired,
  onDelete: PropTypes.func,
};