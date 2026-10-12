"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { invalidateModelCapsCache } from "@/shared/hooks/useModelCaps";
import { invalidatePricingCache } from "@/shared/hooks/usePricing";
import { saveModelName } from "@/shared/hooks/useModelNames";
import { getThinkingLevels, REASONING_EFFORT_LEVELS } from "open-sse/providers/thinkingLevels.js";

const BOOL_CAPS = [
  ["vision", "Vision (image input)"],
  ["reasoning", "Reasoning / thinking"],
  ["tools", "Tool calling"],
  ["pdf", "PDF input"],
  ["imageOutput", "Image output"],
  ["audioInput", "Audio input"],
];

const PRICE_FIELDS = [
  ["input", "Input"],
  ["output", "Output"],
  ["cached", "Cached input"],
  ["cache_creation", "Cache creation"],
];

const inputClass =
  "w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary";

export default function EditModelModal({ isOpen, onClose, model, onSaved }) {
  const [metadataReady, setMetadataReady] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [metadataRevision, setMetadataRevision] = useState(0);
  const [catalogCaps, setCatalogCaps] = useState({});
  const [manualCaps, setManualCaps] = useState({});
  const [catalogSources, setCatalogSources] = useState({});
  const [sources, setSources] = useState({});
  const baseline = { ...model?.staticCaps, ...catalogCaps };
  const sourceText = (field) => {
    const info = sources[field];
    const origin = info ? `${info.source}${info.updatedAt ? " · " + new Date(info.updatedAt).toLocaleString() : " · date unknown"}${info.verified ? "" : " · unconfirmed"}` : "registry · unconfirmed";
    const observed = catalogSources[field];
    return observed && ["manual", "legacy"].includes(info?.source)
      ? `${origin} · catalog: ${JSON.stringify(catalogCaps[field])} (${observed.source}${observed.updatedAt ? ", " + new Date(observed.updatedAt).toLocaleString() : ""})` : origin;
  };
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [flags, setFlags] = useState({});
  const [useCatalogLevels, setUseCatalogLevels] = useState(true);
  const [reasoningLevels, setReasoningLevels] = useState([]);
  const [prices, setPrices] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");

  const catalogLevels = model ? getThinkingLevels(model.providerId || model.providerAlias, model.id, {
    ...baseline, reasoning: true,
  }) || [] : [];
  const orderedLevels = (levels) => REASONING_EFFORT_LEVELS.filter((level) =>
    levels.includes(level) || (level === "high" && levels.includes("thinking"))
  );

  // Pull caps/pricing for this model's provider from the provider's own catalog
  // (falling back to models.dev) and write them as overrides. The provider knows
  // the price actually charged on this key; models.dev lags behind it.
  const handleImportFromCatalog = async () => {
    setImporting(true);
    setImportMsg("");
    setError("");
    try {
      const res = await fetch("/api/providers/import-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: model.providerAlias, targets: ["caps", "pricing"] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      invalidateModelCapsCache();
      invalidatePricingCache();
      setImportMsg(`Imported ${data.caps?.imported ?? 0} capability sets, ${data.pricing?.imported ?? 0} prices from ${data.source}`);
      setMetadataRevision(value => value + 1);
      onSaved?.();
    } catch (err) {
      setImportMsg(err.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !model) return;
    let cancelled = false;
    setMetadataLoading(true);
    setMetadataReady(false);
    setCatalogCaps({});
    setManualCaps(model.override || {});
    setSources({});
    setCatalogSources({});
    fetch(`/api/models/caps?${new URLSearchParams({ provider: model.providerAlias, model: model.id })}`, { signal: AbortSignal.timeout(15000) }).then(res => {
      if (!res.ok) throw new Error("Model metadata unavailable");
      return res.json();
    }).then(data => {
      if (cancelled) return;
      const key = `${model.providerAlias}|${model.id}`;
      const automatic = data.automatic?.[key] || {};
      const manual = data.overrides?.[key] || {};
      setCatalogCaps(automatic);
      setManualCaps(manual);
      setSources(data.sources?.[key] || {});
      setCatalogSources(data.automaticSources?.[key] || {});
      const effective = { ...model.caps, ...(data.effective?.[key] || {}) };
      setContextWindow(effective.contextWindow ? String(effective.contextWindow) : "");
      setMaxOutput(effective.maxOutput ? String(effective.maxOutput) : "");
      setFlags(Object.fromEntries(BOOL_CAPS.map(([field]) => [field, !!effective[field]])));
      setUseCatalogLevels(!Array.isArray(manual.reasoningLevels));
      const levels = Array.isArray(manual.reasoningLevels) ? manual.reasoningLevels
        : getThinkingLevels(model.providerId || model.providerAlias, model.id, { ...model.staticCaps, ...automatic, reasoning: true }) || [];
      setReasoningLevels(orderedLevels(levels));
      setMetadataReady(true);
    }).catch(() => { if (!cancelled) setError("Could not load model metadata. Reopen the editor to retry."); }).finally(() => { if (!cancelled) setMetadataLoading(false); });
    setName(model.name || model.id);
    setAlias(model.alias || "");
    setContextWindow(model.caps?.contextWindow ? String(model.caps.contextWindow) : "");
    setMaxOutput(model.caps?.maxOutput ? String(model.caps.maxOutput) : "");
    const nextFlags = {};
    for (const [key] of BOOL_CAPS) nextFlags[key] = !!model.caps?.[key];
    setFlags(nextFlags);
    const manualLevels = model.caps?.reasoningLevels;
    setUseCatalogLevels(!Array.isArray(manualLevels));
    const defaults = getThinkingLevels(model.providerId || model.providerAlias, model.id, {
      ...model.staticCaps, reasoning: true,
    }) || [];
    setReasoningLevels(REASONING_EFFORT_LEVELS.filter((level) =>
      (Array.isArray(manualLevels) ? manualLevels : defaults).includes(level)
      || (level === "high" && !Array.isArray(manualLevels) && defaults.includes("thinking"))
    ));
    const nextPrices = {};
    for (const [key] of PRICE_FIELDS) {
      nextPrices[key] = model.pricing?.[key] != null ? String(model.pricing[key]) : "";
    }
    setPrices(nextPrices);
    setError("");
    return () => { cancelled = true; };
  }, [isOpen, model, metadataRevision]);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      // Any model can carry a display-name override without altering routing.
      if (name.trim() !== (model.name || model.id)) {
        await saveModelName({ ...model, name });
      }

      // 1. Alias
      const nextAlias = alias.trim();
      if (nextAlias && nextAlias !== (model.alias || "")) {
        const res = await fetch("/api/models/alias", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model.aliasKey, alias: nextAlias }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to save alias");
        }
        // The store is keyed by alias name, so a rename would otherwise leave
        // the old name still routing to this model.
        if (model.alias) {
          await fetch(`/api/models/alias?alias=${encodeURIComponent(model.alias)}`, { method: "DELETE" });
        }
      } else if (!nextAlias && model.alias) {
        await fetch(`/api/models/alias?alias=${encodeURIComponent(model.alias)}`, { method: "DELETE" });
      }

      // 2. Capabilities override = diff vs static caps (empty diff removes the override)
      // Keep less common overrides (thinking format/range, audio/video, etc.)
      // when editing one of the fields exposed by this modal.
      const override = { ...manualCaps };
      for (const [key] of BOOL_CAPS) {
        const value = !!flags[key];
        if (value !== !!model.caps?.[key]) {
          if (value !== !!baseline[key]) override[key] = value;
          else delete override[key];
        }
      }
      const ctx = contextWindow.trim() ? parseInt(contextWindow, 10) : null;
      if (ctx !== (model.caps?.contextWindow || null)) {
        if (ctx && ctx !== baseline.contextWindow) override.contextWindow = ctx;
        else delete override.contextWindow;
      }
      const out = maxOutput.trim() ? parseInt(maxOutput, 10) : null;
      if (out !== (model.caps?.maxOutput || null)) {
        if (out && out !== baseline.maxOutput) override.maxOutput = out;
        else delete override.maxOutput;
      }
      const reasoningChanged = useCatalogLevels !== !Array.isArray(manualCaps.reasoningLevels)
        || (!useCatalogLevels && JSON.stringify(reasoningLevels) !== JSON.stringify(orderedLevels(manualCaps.reasoningLevels || [])));
      if (!useCatalogLevels) override.reasoningLevels = reasoningLevels;
      else delete override.reasoningLevels;
      const capsChanged = BOOL_CAPS.some(([key]) => !!flags[key] !== !!model.caps?.[key])
        || ctx !== (model.caps?.contextWindow || null)
        || out !== (model.caps?.maxOutput || null)
        || reasoningChanged;

      if (capsChanged && Object.keys(override).length > 0) {
        const res = await fetch("/api/models/caps", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: model.providerAlias, model: model.id, caps: override }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to save capabilities");
        }
      } else if (capsChanged && model.override) {
        await fetch(
          `/api/models/caps?provider=${encodeURIComponent(model.providerAlias)}&model=${encodeURIComponent(model.id)}`,
          { method: "DELETE" }
        );
      }

      // 3. Pricing (PATCH replaces the per-model override entry, so send the full object)
      const pricingPayload = {};
      for (const [key, label] of PRICE_FIELDS) {
        const raw = (prices[key] || "").trim();
        if (raw === "") continue;
        const value = Number(raw);
        if (Number.isNaN(value) || value < 0) throw new Error(`Invalid price for ${label}`);
        pricingPayload[key] = value;
      }
      const currentPricing = model.pricing || {};
      const pricingChanged = PRICE_FIELDS.some(
        ([key]) => (pricingPayload[key] ?? undefined) !== (currentPricing[key] ?? undefined)
      );
      if (Object.keys(pricingPayload).length > 0 && pricingChanged) {
        const res = await fetch("/api/pricing", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [model.providerAlias]: { [model.id]: pricingPayload } }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to save pricing");
        }
      } else if (Object.keys(pricingPayload).length === 0 && Object.keys(currentPricing).length > 0) {
        // All fields cleared → drop the user override (static defaults still apply)
        await fetch(
          `/api/pricing?provider=${encodeURIComponent(model.providerAlias)}&model=${encodeURIComponent(model.id)}`,
          { method: "DELETE" }
        );
      }

      invalidateModelCapsCache();
      invalidatePricingCache();
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleResetCaps = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(
        `/api/models/caps?provider=${encodeURIComponent(model.providerAlias)}&model=${encodeURIComponent(model.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to reset capabilities");
      }
      invalidateModelCapsCache();
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Failed to reset capabilities");
    } finally {
      setSaving(false);
    }
  };

  const handleResetPricing = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(
        `/api/pricing?provider=${encodeURIComponent(model.providerAlias)}&model=${encodeURIComponent(model.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to reset pricing");
      }
      invalidatePricingCache();
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Failed to reset pricing");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Edit model: ${model?.id || ""}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!metadataReady}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <p className="text-sm text-red-500">{error}</p>}

        {model && (
          <div>
            <label htmlFor="edit-model-name" className="text-sm font-medium text-text-main mb-1 block">
              Display name
            </label>
            <input
              id="edit-model-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={256}
              placeholder={model.defaultName || model.id}
              className={inputClass}
            />
            <p className="text-xs text-text-muted mt-1">
              Leave empty to restore the original name. Model ID and routing alias stay the same.
            </p>
          </div>
        )}

        <div>
          <label htmlFor="edit-model-alias" className="text-sm font-medium text-text-main mb-1 block">
            Alias
          </label>
          <input
            id="edit-model-alias"
            type="text"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder={model?.id}
            className={inputClass}
          />
          <p className="text-xs text-text-muted mt-1">
            Friendly name for routing (<code>{model?.providerAlias}/{alias.trim() || model?.id}</code>). Leave empty to use the model id.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-text-main">Capabilities</p>
            {metadataLoading && <span role="status" className="text-xs text-text-muted">Загрузка настроек модели…</span>}
            {!metadataLoading && !metadataReady && <button className="text-xs text-primary hover:underline" onClick={() => setMetadataRevision(value => value + 1)}>Повторить загрузку</button>}
            <div className="flex items-center gap-3">
              <button
                onClick={handleImportFromCatalog}
                disabled={importing || metadataLoading}
                className="text-xs text-primary hover:underline disabled:opacity-50"
                title="Fill pricing and capabilities from the provider's own model catalog"
              >
                {importing ? "Importing..." : "Import from provider"}
              </button>
              {model?.override && (
                <button
                  onClick={handleResetCaps}
                  disabled={saving}
                  className="text-xs text-red-500 hover:underline"
                >
                  Reset to defaults
                </button>
              )}
            </div>
          </div>
          {importMsg && <p className={`text-xs mb-2 ${importMsg.includes("fail") || importMsg.includes("not") ? "text-red-500" : "text-green-600"}`}>{importMsg}</p>}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="edit-model-ctx" className="text-xs text-text-muted mb-1 block">Context window (tokens)</label>
              <input
                id="edit-model-ctx"
                disabled={metadataLoading}
                type="number"
                min="1"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder="e.g. 200000"
                className={inputClass}
              />
              <p className="text-xs text-text-muted mt-1">{sourceText("contextWindow")}</p>
            </div>
            <div>
              <label htmlFor="edit-model-out" className="text-xs text-text-muted mb-1 block">Max output (tokens)</label>
              <input
                id="edit-model-out"
                disabled={metadataLoading}
                type="number"
                min="1"
                value={maxOutput}
                onChange={(e) => setMaxOutput(e.target.value)}
                placeholder="e.g. 64000"
                className={inputClass}
              />
              <p className="text-xs text-text-muted mt-1">{sourceText("maxOutput")}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            {BOOL_CAPS.map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-text-main cursor-pointer">
                <input
                  type="checkbox"
                  disabled={metadataLoading}
                  checked={!!flags[key]}
                  onChange={(e) => setFlags((prev) => ({ ...prev, [key]: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                {label}
              </label>
            ))}
          </div>
          <fieldset className="mt-4 border-t border-border pt-3" disabled={!flags.reasoning || metadataLoading}>
            <legend className="sr-only">Reasoning effort levels</legend>
            <p className="text-sm font-medium text-text-main mb-2">Reasoning effort levels</p>
            <p className="text-xs text-text-muted mb-2">{sourceText("reasoningLevels")}</p>
            <label className="flex items-center gap-2 text-sm text-text-main cursor-pointer">
              <input
                type="checkbox"
                checked={useCatalogLevels}
                onChange={(e) => {
                  setUseCatalogLevels(e.target.checked);
                  if (e.target.checked) setReasoningLevels(orderedLevels(catalogLevels));
                }}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              />
              Use catalog defaults
            </label>
            <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3">
              {REASONING_EFFORT_LEVELS.map((level) => (
                <label key={level} className="flex items-center gap-2 text-sm text-text-main cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reasoningLevels.includes(level)}
                    disabled={useCatalogLevels || !flags.reasoning}
                    onChange={(e) => setReasoningLevels((prev) => orderedLevels(e.target.checked
                      ? [...prev, level] : prev.filter((entry) => entry !== level)))}
                    aria-label={`Reasoning effort: ${level}`}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <code>{level}</code>
                </label>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-2">
              Choose the levels accepted by this provider. Saved choices are used in Codex and the model picker.
            </p>
            {!flags.reasoning && <p className="text-xs text-text-muted mt-1">Enable reasoning to configure effort levels.</p>}
          </fieldset>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-text-main">
              Pricing <span className="text-xs font-normal text-text-muted">($ per 1M tokens, empty = unset)</span>
            </p>
            {model?.pricing && (
              <button
                onClick={handleResetPricing}
                disabled={saving}
                className="text-xs text-red-500 hover:underline"
              >
                Reset to defaults
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {PRICE_FIELDS.map(([key, label]) => (
              <div key={key}>
                <label htmlFor={`edit-model-price-${key}`} className="text-xs text-text-muted mb-1 block">{label}</label>
                <input
                  id={`edit-model-price-${key}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={prices[key] || ""}
                  onChange={(e) => setPrices((prev) => ({ ...prev, [key]: e.target.value }))}
                  placeholder="0.00"
                  className={inputClass}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

EditModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func,
  model: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    defaultName: PropTypes.string,
    isCustom: PropTypes.bool,
    providerAlias: PropTypes.string,
    providerId: PropTypes.string,
    aliasKey: PropTypes.string,
    alias: PropTypes.string,
    caps: PropTypes.object,
    staticCaps: PropTypes.object,
    override: PropTypes.object,
    pricing: PropTypes.object,
  }),
};
