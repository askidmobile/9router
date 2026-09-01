"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import ImportModelsModal from "./ImportModelsModal";
import EditModelModal from "@/app/(dashboard)/dashboard/models/EditModelModal";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { usePricing } from "@/shared/hooks/usePricing";
import { buildEditModel } from "@/shared/utils/editModel";
import { CapacityBadges } from "@/shared/components";
import { formatModelMeta } from "@/shared/utils/modelMeta";
function CompatibleModelRow({ modelId, fullModel, copied, onCopy, onDeleteAlias, onTest, testStatus, isTesting, onEdit, hasOverride, caps }) {
  const { getPricing } = usePricing();
  const meta = formatModelMeta(caps, getPricing(fullModel.slice(0, fullModel.indexOf("/")), modelId));
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
          <span className="truncate text-sm font-medium text-text-main">{modelId}</span>
          {/* Row 2 — routed id + copy on hover */}
          <div className="flex min-w-0 items-center gap-1.5">
            <code className="max-w-[72vw] truncate rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs text-text-muted sm:max-w-[360px]">{fullModel}</code>
            <div className="relative shrink-0 group/btn">
              <button
                onClick={() => onCopy(fullModel, `model-${modelId}`)}
                className="rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-sidebar hover:text-primary sm:opacity-0 sm:group-hover:opacity-100"
              >
                <span className="material-symbols-outlined text-[13px]">
                  {copied === `model-${modelId}` ? "check" : "content_copy"}
                </span>
              </button>
              <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {copied === `model-${modelId}` ? "Copied!" : "Copy"}
              </span>
            </div>
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
            <div className="relative shrink-0 group/btn">
              <button
                onClick={onTest}
                disabled={isTesting}
                title="Test"
                className={`rounded p-0.5 text-text-muted transition-opacity hover:bg-sidebar hover:text-primary ${isTesting ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"}`}
              >
                <span className="material-symbols-outlined text-[13px]" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test"}
              </span>
            </div>
          )}
          {onEdit && (
            <div className="relative shrink-0 group/btn">
              <button
                onClick={onEdit}
                title="Edit model capabilities / pricing"
                className={`rounded p-0.5 transition-opacity hover:bg-sidebar ${hasOverride ? "text-primary opacity-100" : "text-text-muted opacity-100 hover:text-primary sm:opacity-0 sm:group-hover:opacity-100"}`}
              >
                <span className="material-symbols-outlined text-[13px]">tune</span>
              </button>
              <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {hasOverride ? "Configured" : "Settings"}
              </span>
            </div>
          )}
          <div className="relative shrink-0 group/btn">
            <button
              onClick={onDeleteAlias}
              title="Remove model"
              className="rounded p-0.5 text-text-muted opacity-100 transition-opacity hover:bg-red-500/10 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <span className="material-symbols-outlined text-[13px]">close</span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              Remove
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel, connections, isAnthropic, onModelsChanged, importSupported = false }) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [testingModelId, setTestingModelId] = useState(null);
  const [modelTestResults, setModelTestResults] = useState({});
  const [editing, setEditing] = useState(null);
  const { getCaps, overrides: capsOverrides } = useModelCaps();
  const { getPricing } = usePricing();

  const handleTestModel = async (modelId) => {
    if (testingModelId) return;
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
    } finally {
      setTestingModelId(null);
    }
  };

  const allModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (allModels.some((model) => model.id === modelId)) {
      alert("Model already exists for this provider.");
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModel(modelId);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const activeConnectionId = connections.find((conn) => conn.isActive !== false)?.id || null;
  // Import requires an active connection with a Base URL configured
  // (probed via ?check=1 on the parent page).
  const canImport = !!activeConnectionId && importSupported === true;
  const existingIds = new Set(allModels.map((m) => m.id));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={() => setShowImport(true)} disabled={!canImport}>
          Import from /models
        </Button>
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          {activeConnectionId
            ? "Set a Base URL on the active connection to enable importing models."
            : "Add a connection to enable importing models."}
        </p>
      )}

      {allModels.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {allModels.map(({ id, alias, source }) => (
            <div key={`${source}-${providerStorageAlias}/${id}`} className="w-full sm:w-[calc(50%-6px)] xl:w-[calc(33.333%-8px)]">
            <CompatibleModelRow
              key={`${source}-${providerStorageAlias}/${id}`}
              modelId={id}
              fullModel={`${providerDisplayAlias}/${id}`}
              copied={copied}
              onCopy={onCopy}
              onDeleteAlias={() => source === "custom" ? onDeleteCustomModel(id) : onDeleteAlias(alias)}
              onTest={connections.length > 0 ? () => handleTestModel(id) : undefined}
              testStatus={modelTestResults[id]}
              isTesting={testingModelId === id}
              hasOverride={!!capsOverrides[`${providerStorageAlias}|${id}`]}
              caps={(() => {
                const base = getCapabilitiesForModel(providerStorageAlias, id) || {};
                return { ...base, ...(capsOverrides[`${providerStorageAlias}|${id}`] || {}) };
              })()}
              onEdit={() => setEditing(buildEditModel({
                id,
                providerAlias: providerStorageAlias,
                alias,
                overrides: capsOverrides,
                getCaps,
                getPricing,
              }))}
            />
            </div>
          ))}
        </div>
      )}

      <ImportModelsModal
        isOpen={showImport}
        onClose={() => setShowImport(false)}
        connectionId={activeConnectionId}
        providerStorageAlias={providerStorageAlias}
        existingIds={existingIds}
        onImported={onModelsChanged}
      />

      <EditModelModal
        isOpen={!!editing}
        onClose={() => setEditing(null)}
        model={editing}
        onSaved={onModelsChanged}
      />
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
  onModelsChanged: PropTypes.func,
  importSupported: PropTypes.bool,
};
