// Combo slot schedules: boost or sink a combo member during wall-clock windows.
//
// Providers bill by time of day (DeepSeek off-peak is 2x cheaper outside
// weekday UTC peaks; Z.AI / GLM coding plans consume credits at 50% off-peak;
// Qwen has cheap idle hours). A slot with an active schedule floats to the
// front (or sinks to the back) of the combo order; outside its windows the
// base order applies. Everything here is pure and takes an explicit `nowMs`,
// so the same module serves the runtime (open-sse), the settings API and the
// dashboard UI.

import { getLocalTimezone, isValidTimezone, zonedParts } from "./quotaPingSchedule.js";

// Preset schedules verified on the date in `verifiedAt`; provider windows
// change over time — keep the label honest and update wholesale.
export const TIME_PRIORITY_PRESETS = [
  {
    id: "deepseek-offpeak",
    label: "DeepSeek off-peak",
    verifiedAt: "2026-11",
    providerPrefixes: ["deepseek/", "ds/"],
    schedule: {
      enabled: true,
      action: "top",
      mode: "except",
      tz: "UTC",
      windows: [
        { from: "01:00", to: "04:00", days: "weekdays" },
        { from: "06:00", to: "10:00", days: "weekdays" },
      ],
    },
  },
  {
    id: "zai-coding-offpeak",
    label: "Z.AI Coding off-peak",
    verifiedAt: "2026-11",
    providerPrefixes: ["zai/"],
    schedule: {
      enabled: true,
      action: "top",
      mode: "except",
      tz: "UTC",
      windows: [{ from: "06:00", to: "10:00", days: "weekdays" }],
    },
  },
  {
    id: "glm-coding-offpeak",
    label: "GLM Coding Plan off-peak",
    verifiedAt: "2026-11",
    providerPrefixes: ["glm/", "glm-cn/"],
    schedule: {
      enabled: true,
      action: "top",
      mode: "except",
      tz: "Asia/Shanghai",
      windows: [{ from: "14:00", to: "18:00", days: "weekdays" }],
    },
  },
  {
    id: "qwen-idle",
    label: "Qwen idle hours",
    verifiedAt: "2026-11",
    providerPrefixes: ["alims/", "alims-intl/", "qoder/", "qoder-cn/"],
    schedule: {
      enabled: true,
      action: "top",
      mode: "in",
      tz: "Asia/Shanghai",
      windows: [{ from: "22:00", to: "08:00", days: "daily" }],
    },
  },
  {
    id: "kimi-offpeak",
    label: "Kimi off-peak",
    verifiedAt: "2026-11",
    providerPrefixes: ["kimi/", "moonshot/"],
    schedule: {
      enabled: true,
      action: "top",
      mode: "except",
      tz: "Asia/Shanghai",
      windows: [
        { from: "09:00", to: "12:00", days: "weekdays" },
        { from: "14:00", to: "18:00", days: "weekdays" },
      ],
    },
  },
  {
    id: "volcengine-coding-offpeak",
    label: "Volcengine Coding off-peak",
    verifiedAt: "2026-11",
    providerPrefixes: ["volcengine-ark/"],
    schedule: {
      enabled: true,
      action: "top",
      mode: "except",
      tz: "Asia/Shanghai",
      windows: [{ from: "14:00", to: "18:00", days: "weekdays" }],
    },
  },
];

const DAY_SETS = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
};

const DAY_MS = 86400000;

function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function normalizeWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const from = parseHHMM(raw.from);
  const to = parseHHMM(raw.to);
  const days = DAY_SETS[raw.days] ? raw.days : null;
  if (from === null || to === null || !days) return null;
  return { from: raw.from, to: raw.to, days };
}

// Returns a fully-normalized schedule, or null when it is absent/disabled/invalid.
export function normalizeSlotSchedule(raw) {
  if (!raw || typeof raw !== "object" || raw.enabled !== true) return null;
  if (raw.action !== "top" && raw.action !== "bottom") return null;
  if (raw.mode !== "in" && raw.mode !== "except") return null;
  if (raw.tz !== "local" && !isValidTimezone(raw.tz)) return null;
  if (!Array.isArray(raw.windows) || raw.windows.length === 0) return null;

  const windows = raw.windows.map(normalizeWindow).filter(Boolean);
  if (windows.length === 0) return null;

  return { enabled: true, action: raw.action, mode: raw.mode, tz: raw.tz, windows };
}

// Wall-clock parts of `nowMs` in `tz`, plus the calendar weekday of the zoned
// date and of the day before it. zonedParts has no weekday part (its numeric
// coercion would make one NaN), so derive it from the zoned calendar date.
export function zonedNowParts(nowMs, tz) {
  const p = zonedParts(nowMs, tz);
  const dayUtcMs = Date.UTC(p.year, p.month - 1, p.day);
  return {
    weekday: new Date(dayUtcMs).getUTCDay(),
    prevWeekday: new Date(dayUtcMs - DAY_MS).getUTCDay(),
    minutes: p.hour * 60 + p.minute,
  };
}

// [from, to); from == to spans the whole listed day; an overnight window
// (from > to) is anchored to its start day — the early-morning tail checks
// the *previous* day's membership.
function isWindowActive(window, parts) {
  const from = parseHHMM(window.from);
  const to = parseHHMM(window.to);
  const days = DAY_SETS[window.days];

  if (from === to) return days.includes(parts.weekday);
  if (from < to) {
    return parts.minutes >= from && parts.minutes < to && days.includes(parts.weekday);
  }
  return (
    (parts.minutes >= from && days.includes(parts.weekday)) ||
    (parts.minutes < to && days.includes(parts.prevWeekday))
  );
}

function resolveTz(schedule, opts) {
  if (schedule.tz !== "local") return schedule.tz;
  // "local" means the machine running the matcher: the server for routing,
  // but the dashboard must pass the server's zone explicitly so a browser in
  // another timezone does not reinterpret the window.
  return (opts && opts.localTz) || getLocalTimezone();
}

export function isSlotScheduleActive(rawSchedule, nowMs = Date.now(), opts = undefined) {
  const schedule = normalizeSlotSchedule(rawSchedule);
  if (!schedule) return false;
  const parts = zonedNowParts(nowMs, resolveTz(schedule, opts));
  const inAny = schedule.windows.some((window) => isWindowActive(window, parts));
  return schedule.mode === "in" ? inAny : !inAny;
}

// Stable reorder: active "top" slots first, active "bottom" slots last, the
// untouched middle keeps its order. Returns the input reference when nothing
// applies, so configs without schedules pay nothing.
export function reorderByTimePriority(models, timePriority, nowMs = Date.now(), opts = undefined) {
  if (!timePriority || typeof timePriority !== "object") return models;
  if (!Array.isArray(models) || models.length < 2) return models;

  const tops = [];
  const middle = [];
  const bottoms = [];
  for (const model of models) {
    const schedule = timePriority[model];
    if (schedule && isSlotScheduleActive(schedule, nowMs, opts)) {
      if (normalizeSlotSchedule(schedule).action === "top") tops.push(model);
      else bottoms.push(model);
    } else {
      middle.push(model);
    }
  }
  if (tops.length === 0 && bottoms.length === 0) return models;
  return [...tops, ...middle, ...bottoms];
}

// Drop schedule keys for slots no longer present in the combo (FR-008).
export function stripOrphanSchedules(timePriority, models) {
  if (!timePriority || typeof timePriority !== "object") return {};
  const present = new Set(Array.isArray(models) ? models : []);
  const out = {};
  for (const [slot, schedule] of Object.entries(timePriority)) {
    if (present.has(slot)) out[slot] = schedule;
  }
  return out;
}

export function countActiveSchedules(timePriority, models, nowMs = Date.now(), opts = undefined) {
  let active = 0;
  let total = 0;
  for (const model of Array.isArray(models) ? models : []) {
    const schedule = normalizeSlotSchedule(timePriority?.[model]);
    if (!schedule) continue;
    total += 1;
    if (isSlotScheduleActive(schedule, nowMs, opts)) active += 1;
  }
  return { active, total };
}

// Whole-map normalization for the settings API; invalid entries are dropped
// loudly (FR-005) — the UI validates on input, so this is the defensive layer.
export function normalizeTimePriorityMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [slot, schedule] of Object.entries(raw)) {
    const normalized = normalizeSlotSchedule(schedule);
    if (normalized) out[slot] = normalized;
    else console.warn(`[comboTimePriority] dropped invalid schedule for slot "${slot}"`);
  }
  return out;
}

// Next wall-clock minute (up to 8 days out) where the schedule's active state
// flips — powers the UI "top until 04:00 UTC" hint. Minute-granular scan;
// called from the UI only, never on the request path.
export function nextScheduleBoundary(rawSchedule, nowMs = Date.now(), opts = undefined) {
  const schedule = normalizeSlotSchedule(rawSchedule);
  if (!schedule) return null;
  const current = isSlotScheduleActive(schedule, nowMs, opts);
  for (let t = nowMs - (nowMs % 60000) + 60000; t <= nowMs + 8 * DAY_MS; t += 60000) {
    if (isSlotScheduleActive(schedule, t, opts) !== current) return t;
  }
  return null;
}

// Move a combo's slot schedules to a renamed combo, leaving the old entry's
// other strategy fields untouched and dropping the entry if it empties out.
// Other extras (ctx/out, judge, …) intentionally keep their existing rename
// behaviour; this only owns timePriority.
export function transferSlotSchedules(strategies, fromName, toName) {
  if (!strategies || typeof strategies !== "object" || !fromName || !toName || fromName === toName) {
    return { strategies, moved: false };
  }
  const from = strategies[fromName];
  if (!from || typeof from !== "object" || !from.timePriority) return { strategies, moved: false };

  const next = { ...strategies };
  const stripped = { ...from };
  delete stripped.timePriority;
  const strippedExtras = Object.keys(stripped).filter((key) => key !== "fallbackStrategy");
  if (!stripped.fallbackStrategy && strippedExtras.length === 0) delete next[fromName];
  else next[fromName] = stripped;

  next[toName] = { ...(next[toName] || {}), timePriority: from.timePriority };
  return { strategies: next, moved: true };
}
