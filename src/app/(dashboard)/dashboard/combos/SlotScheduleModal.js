"use client";

import { useState } from "react";
import { Button, Modal, Select, Toggle } from "@/shared/components";
import {
  TIME_PRIORITY_PRESETS,
  isSlotScheduleActive,
  nextScheduleBoundary,
  normalizeSlotSchedule,
} from "@/shared/services/comboTimePriority.js";

const DAY_OPTIONS = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekends", label: "Weekends" },
];

const ACTION_OPTIONS = [
  { value: "top", label: "Move to top" },
  { value: "bottom", label: "Move to bottom" },
];

const MODE_OPTIONS = [
  { value: "in", label: "Inside windows" },
  { value: "except", label: "Outside windows" },
];

// Curated datalist suggestions; any valid IANA zone is accepted.
const TZ_SUGGESTIONS = ["UTC", "local", "Asia/Shanghai", "America/New_York", "Europe/London", "Europe/Moscow", "America/Sao_Paulo"];

const cloneSchedule = (schedule) =>
  schedule
    ? { ...schedule, windows: (schedule.windows || []).map((window) => ({ ...window })) }
    : { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "09:00", to: "18:00", days: "weekdays" }] };

function formatInZone(ms, timezone) {
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  } catch {
    return "—";
  }
}

function matchesPreset(model, schedule) {
  return TIME_PRIORITY_PRESETS.find((preset) => {
    if (!model || !preset.providerPrefixes.some((prefix) => model.toLowerCase().startsWith(prefix.toLowerCase()))) return false;
    return JSON.stringify(preset.schedule) === JSON.stringify(schedule);
  })?.id || "custom";
}

// Per-slot wall-clock schedule: when active, the combo slot floats to the top
// (or sinks to the bottom). Provider presets fill the windows for known
// time-based pricing; everything stays editable.
export default function SlotScheduleModal({ isOpen, onClose, model, initialSchedule, serverNowMs, serverTz, onSave }) {
  const [schedule, setSchedule] = useState(() => cloneSchedule(initialSchedule));
  const [presetId, setPresetId] = useState(() => matchesPreset(model, cloneSchedule(initialSchedule)));

  const patch = (fields) => setSchedule((prev) => ({ ...prev, ...fields }));
  const patchWindow = (index, fields) =>
    setSchedule((prev) => ({ ...prev, windows: prev.windows.map((window, i) => (i === index ? { ...window, ...fields } : window)) }));
  const removeWindow = (index) =>
    setSchedule((prev) => ({ ...prev, windows: prev.windows.filter((_, i) => i !== index) }));
  const addWindow = () =>
    setSchedule((prev) => ({ ...prev, windows: [...prev.windows, { from: "09:00", to: "18:00", days: "weekdays" }] }));

  const applyPreset = (id) => {
    setPresetId(id);
    const preset = TIME_PRIORITY_PRESETS.find((p) => p.id === id);
    if (preset) setSchedule(cloneSchedule(preset.schedule));
  };

  const active = schedule.enabled && normalizeSlotSchedule(schedule) && isSlotScheduleActive(schedule, serverNowMs, { localTz: serverTz });
  const boundary = schedule.enabled && normalizeSlotSchedule(schedule)
    ? nextScheduleBoundary(schedule, serverNowMs, { localTz: serverTz })
    : null;
  const tzLabel = schedule.tz === "local" ? serverTz : schedule.tz;
  const valid = !!normalizeSlotSchedule(schedule);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Slot Schedule — ${model}`} size="md">
      <div className="flex flex-col gap-3">
        {/* Live server clock — schedules resolve against the server's time, not the browser's */}
        <p className="text-[11px] text-text-muted">
          Server time now: <span className="font-mono">{formatInZone(serverNowMs, serverTz)} {serverTz}</span>
        </p>

        {/* Preset */}
        <div>
          <label className="text-xs text-text-muted mb-1 block">Preset</label>
          <Select
            options={[
              { value: "custom", label: "Custom" },
              ...TIME_PRIORITY_PRESETS.map((preset) => ({
                value: preset.id,
                label: `${preset.label} (${preset.verifiedAt})`,
              })),
            ]}
            value={presetId}
            onChange={(e) => applyPreset(e.target.value)}
            selectClassName="py-1.5 text-xs"
          />
          <p className="text-[10px] text-text-muted mt-0.5">
            Provider peak/off-peak windows as of the date in brackets — edit freely if they change.
          </p>
        </div>

        {/* Action + mode */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-text-muted mb-1 block">When active</label>
            <Select
              options={ACTION_OPTIONS}
              value={schedule.action}
              onChange={(e) => patch({ action: e.target.value })}
              selectClassName="py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">Active</label>
            <Select
              options={MODE_OPTIONS}
              value={schedule.mode}
              onChange={(e) => patch({ mode: e.target.value })}
              selectClassName="py-1.5 text-xs"
            />
          </div>
        </div>

        {/* Timezone */}
        <div>
          <label htmlFor="slot-schedule-tz" className="text-xs text-text-muted mb-1 block">Timezone (IANA, or “local” = server)</label>
          <input
            id="slot-schedule-tz"
            list="slot-schedule-tz-options"
            value={schedule.tz}
            onChange={(e) => patch({ tz: e.target.value })}
            className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm text-text-main outline-none focus:ring-1 focus:ring-primary dark:border-white/15"
          />
          <datalist id="slot-schedule-tz-options">
            {TZ_SUGGESTIONS.map((tz) => <option key={tz} value={tz} />)}
          </datalist>
        </div>

        {/* Windows */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-text-muted">Windows ({tzLabel})</label>
          {schedule.windows.map((window, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <input
                type="time"
                value={window.from}
                onChange={(e) => patchWindow(index, { from: e.target.value })}
                className="w-[104px] rounded border border-black/10 bg-transparent px-2 py-1 font-mono text-xs text-text-main outline-none focus:ring-1 focus:ring-primary dark:border-white/15"
              />
              <span className="text-xs text-text-muted">–</span>
              <input
                type="time"
                value={window.to}
                onChange={(e) => patchWindow(index, { to: e.target.value })}
                className="w-[104px] rounded border border-black/10 bg-transparent px-2 py-1 font-mono text-xs text-text-main outline-none focus:ring-1 focus:ring-primary dark:border-white/15"
              />
              <div className="flex-1 min-w-0">
                <Select
                  options={DAY_OPTIONS}
                  value={window.days}
                  onChange={(e) => patchWindow(index, { days: e.target.value })}
                  selectClassName="py-1 text-xs"
                />
              </div>
              <button
                onClick={() => removeWindow(index)}
                className="p-1 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all shrink-0"
                title="Remove window"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
          ))}
          <button
            onClick={addWindow}
            className="w-fit px-2 py-1 border border-dashed border-black/10 dark:border-white/10 rounded text-[11px] text-primary hover:border-primary/50 transition-colors"
          >
            + window
          </button>
          {schedule.windows.length > 16 && (
            <p className="text-[10px] text-amber-500">Many windows — double-check the preset you meant to use.</p>
          )}
          <p className="text-[10px] text-text-muted">
            [from, to) — “22:00–06:00” crosses midnight; equal times mean the whole day.
          </p>
        </div>

        {/* Status preview */}
        <div className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2 text-[11px]">
          {!valid ? (
            <span className="text-text-muted">Schedule incomplete — at least one valid window required.</span>
          ) : !schedule.enabled ? (
            <span className="text-text-muted">Disabled — the slot keeps its base position.</span>
          ) : active ? (
            <span className="text-primary font-medium">
              Active now — {schedule.action === "top" ? "boosted to top" : "sunk to bottom"}{boundary ? ` until ${formatInZone(boundary, tzLabel)} ${tzLabel}` : ""}
            </span>
          ) : (
            <span className="text-text-muted">
              Not active now — next change {boundary ? `${formatInZone(boundary, tzLabel)} ${tzLabel}` : "beyond 8 days"}
            </span>
          )}
        </div>

        {/* Enabled + actions */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <label className="flex items-center gap-2 text-xs text-text-main">
            <Toggle checked={schedule.enabled} onChange={(checked) => patch({ enabled: checked })} />
            Enabled
          </label>
          <div className="flex gap-2">
            <Button onClick={onClose} variant="ghost" size="sm">Cancel</Button>
            <Button onClick={() => onSave(schedule.enabled && valid ? schedule : null)} size="sm" disabled={!valid}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
