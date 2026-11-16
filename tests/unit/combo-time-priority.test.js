import { describe, expect, it } from "vitest";

import {
  TIME_PRIORITY_PRESETS,
  countActiveSchedules,
  isSlotScheduleActive,
  normalizeSlotSchedule,
  normalizeTimePriorityMap,
  nextScheduleBoundary,
  reorderByTimePriority,
  stripOrphanSchedules,
  zonedNowParts,
} from "../../src/shared/services/comboTimePriority.js";

const at = (iso) => new Date(iso).getTime();

const active = (schedule, iso, opts) => isSlotScheduleActive(schedule, at(iso), opts);

// 2026-11-16 is a Monday; 2026-11-14 Saturday; 2026-11-15 Sunday.
const MON_2026 = "2026-11-16";
const SAT_2026 = "2026-11-14";

describe("normalizeSlotSchedule", () => {
  it("rejects absent, disabled and empty-window schedules", () => {
    expect(normalizeSlotSchedule(null)).toBeNull();
    expect(normalizeSlotSchedule({ enabled: false })).toBeNull();
    expect(normalizeSlotSchedule({ enabled: true, action: "top", mode: "in", tz: "UTC", windows: [] })).toBeNull();
    expect(normalizeSlotSchedule({ enabled: true, action: "top", mode: "in", tz: "UTC", windows: "nope" })).toBeNull();
  });

  it("rejects invalid action, mode or timezone entirely", () => {
    const base = { enabled: true, mode: "in", tz: "UTC", windows: [{ from: "01:00", to: "04:00", days: "daily" }] };
    expect(normalizeSlotSchedule({ ...base, action: "sideways" })).toBeNull();
    expect(normalizeSlotSchedule({ ...base, action: "top", mode: "sometimes" })).toBeNull();
    expect(normalizeSlotSchedule({ ...base, action: "top", tz: "Mars/Olympus" })).toBeNull();
  });

  it("drops only the broken window and keeps the rest", () => {
    const schedule = normalizeSlotSchedule({
      enabled: true,
      action: "top",
      mode: "in",
      tz: "UTC",
      windows: [
        { from: "25:00", to: "04:00", days: "daily" },
        { from: "01:00", to: "04:00", days: "weekdays" },
      ],
    });
    expect(schedule.windows).toEqual([{ from: "01:00", to: "04:00", days: "weekdays" }]);
  });

  it("keeps tz local as a first-class value", () => {
    const schedule = normalizeSlotSchedule({
      enabled: true,
      action: "bottom",
      mode: "except",
      tz: "local",
      windows: [{ from: "00:00", to: "00:00", days: "weekends" }],
    });
    expect(schedule.tz).toBe("local");
  });
});

describe("zonedNowParts", () => {
  it("derives the calendar weekday of the zone, not of UTC", () => {
    // 2026-11-16T20:30Z is already Tuesday in Shanghai (04:30 on the 17th).
    const parts = zonedNowParts(at("2026-11-16T20:30:00Z"), "Asia/Shanghai");
    expect(parts.weekday).toBe(2); // Tuesday
    expect(parts.minutes).toBe(4 * 60 + 30);
  });

  it("prevWeekday is the calendar day before in the same zone", () => {
    const parts = zonedNowParts(at("2026-11-16T20:30:00Z"), "Asia/Shanghai");
    expect(parts.prevWeekday).toBe(1); // Monday
  });
});

describe("isSlotScheduleActive — boundaries and wrap", () => {
  const weekdayWindow = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "01:00", to: "04:00", days: "weekdays" }] };

  it("matches [from, to) on the exact boundary", () => {
    expect(active(weekdayWindow, `${MON_2026}T01:00:00Z`)).toBe(true);
    expect(active(weekdayWindow, `${MON_2026}T03:59:59Z`)).toBe(true);
    expect(active(weekdayWindow, `${MON_2026}T04:00:00Z`)).toBe(false);
    expect(active(weekdayWindow, `${MON_2026}T00:59:59Z`)).toBe(false);
  });

  it("honours days filtering", () => {
    expect(active(weekdayWindow, `${SAT_2026}T02:00:00Z`)).toBe(false); // Saturday
  });

  it("from == to covers the whole listed day", () => {
    const allDay = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "00:00", to: "00:00", days: "daily" }] };
    expect(active(allDay, `${SAT_2026}T12:00:00Z`)).toBe(true);
    const workdayOnly = { ...allDay, windows: [{ from: "00:00", to: "00:00", days: "weekdays" }] };
    expect(active(workdayOnly, `${MON_2026}T12:00:00Z`)).toBe(true);
    expect(active(workdayOnly, `${SAT_2026}T12:00:00Z`)).toBe(false);
  });

  it("except with a full-day weekend window boosts only on weekdays", () => {
    const exceptWeekend = { enabled: true, action: "top", mode: "except", tz: "UTC", windows: [{ from: "00:00", to: "00:00", days: "weekends" }] };
    expect(active(exceptWeekend, `${MON_2026}T12:00:00Z`)).toBe(true);
    expect(active(exceptWeekend, `${SAT_2026}T12:00:00Z`)).toBe(false);
  });

  it("wraps midnight anchored to the start day", () => {
    const nightly = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "22:00", to: "06:00", days: "daily" }] };
    expect(active(nightly, `${MON_2026}T23:00:00Z`)).toBe(true);
    expect(active(nightly, `${MON_2026}T05:59:59Z`)).toBe(true);
    expect(active(nightly, `${MON_2026}T06:00:00Z`)).toBe(false);
    expect(active(nightly, `${MON_2026}T21:59:59Z`)).toBe(false);
  });

  it("weekdays 22:00–06:00: Saturday 02:00 active (Friday start), Monday 02:00 not (Sunday start)", () => {
    const workNights = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "22:00", to: "06:00", days: "weekdays" }] };
    // 2026-11-14 is Saturday, 2026-11-16 is Monday.
    expect(active(workNights, "2026-11-14T02:00:00Z")).toBe(true); // started Friday 22:00
    expect(active(workNights, "2026-11-16T02:00:00Z")).toBe(false); // started Sunday 22:00
    expect(active(workNights, "2026-11-13T23:00:00Z")).toBe(true); // Friday 23:00
    expect(active(workNights, "2026-11-14T23:00:00Z")).toBe(false); // Saturday 23:00
  });

  it("except inverts the union of windows (deepseek off-peak shape)", () => {
    const offpeak = {
      enabled: true,
      action: "top",
      mode: "except",
      tz: "UTC",
      windows: [
        { from: "01:00", to: "04:00", days: "weekdays" },
        { from: "06:00", to: "10:00", days: "weekdays" },
      ],
    };
    expect(active(offpeak, "2026-11-17T20:00:00Z")).toBe(true); // Tuesday evening
    expect(active(offpeak, "2026-11-18T06:30:00Z")).toBe(false); // Wednesday peak
    expect(active(offpeak, "2026-11-18T02:30:00Z")).toBe(false); // Wednesday night peak
    expect(active(offpeak, "2026-11-14T12:00:00Z")).toBe(true); // Saturday — always off-peak
    expect(active(offpeak, "2026-11-15T02:00:00Z")).toBe(true); // Sunday night
  });

  it("matches wall-clock windows in the schedule timezone", () => {
    const shanghai = { enabled: true, action: "top", mode: "in", tz: "Asia/Shanghai", windows: [{ from: "14:00", to: "18:00", days: "daily" }] };
    expect(active(shanghai, "2026-11-16T06:00:00Z")).toBe(true); // 14:00 CST
    expect(active(shanghai, "2026-11-16T10:00:00Z")).toBe(false); // 18:00 CST
  });
});

describe("isSlotScheduleActive — DST gap and fold", () => {
  // America/New_York, spring forward 2026-03-08: 02:00 EST -> 03:00 EDT (07:00 UTC).
  it("spring-forward: minutes that exist still match; skipped minutes never occur", () => {
    const window = { enabled: true, action: "top", mode: "in", tz: "America/New_York", windows: [{ from: "02:30", to: "04:00", days: "daily" }] };
    expect(active(window, "2026-03-08T06:59:00Z")).toBe(false); // 01:59 EST — before the window
    expect(active(window, "2026-03-08T07:00:00Z")).toBe(true); // 03:00 EDT — inside the window
    expect(active(window, "2026-03-08T07:15:00Z")).toBe(true); // 03:15 EDT
    // The jump moment itself: 06:59:59Z is 01:59:59 EST; there is no UTC instant
    // that reads 02:45 in the zone on this date — assert via the parts.
    const parts = zonedNowParts(at("2026-03-08T07:00:00Z"), "America/New_York");
    expect(parts.minutes).toBe(3 * 60); // jumped straight to 03:00
  });

  // America/New_York, fall back 2026-11-01: 02:00 EDT -> 01:00 EST (06:00 UTC).
  it("fall-back: the repeated hour matches on both occurrences", () => {
    const window = { enabled: true, action: "top", mode: "in", tz: "America/New_York", windows: [{ from: "01:30", to: "02:30", days: "daily" }] };
    expect(active(window, "2026-11-01T05:45:00Z")).toBe(true); // 01:45 EDT (first pass)
    expect(active(window, "2026-11-01T06:45:00Z")).toBe(true); // 01:45 EST (second pass)
    expect(active(window, "2026-11-01T04:45:00Z")).toBe(false); // 00:45 EDT — before
  });
});

describe("reorderByTimePriority", () => {
  const map = (schedule) => ({ "ds/deepseek-v4-pro": schedule });
  const inWindow = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "00:00", to: "23:59", days: "daily" }] };
  const bottomWindow = { ...inWindow, action: "bottom" };

  it("returns the same reference when nothing applies", () => {
    const models = ["a/x", "b/y"];
    expect(reorderByTimePriority(models, null, at(`${MON_2026}T12:00:00Z`))).toBe(models);
    expect(reorderByTimePriority(models, {}, at(`${MON_2026}T12:00:00Z`))).toBe(models);
    const offWindow = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "05:00", to: "06:00", days: "daily" }] };
    expect(reorderByTimePriority(models, map(offWindow), at(`${MON_2026}T12:00:00Z`))).toBe(models);
  });

  it("floats an active top slot to the front", () => {
    const models = ["a/x", "ds/deepseek-v4-pro", "b/y"];
    expect(reorderByTimePriority(models, map(inWindow), at(`${MON_2026}T12:00:00Z`)))
      .toEqual(["ds/deepseek-v4-pro", "a/x", "b/y"]);
  });

  it("sinks an active bottom slot to the end", () => {
    const models = ["a/x", "ds/deepseek-v4-pro", "b/y"];
    expect(reorderByTimePriority(models, map(bottomWindow), at(`${MON_2026}T12:00:00Z`)))
      .toEqual(["a/x", "b/y", "ds/deepseek-v4-pro"]);
  });

  it("keeps relative order of several active slots (stable)", () => {
    const tp = { "a/x": inWindow, "b/y": inWindow };
    expect(reorderByTimePriority(["a/x", "b/y", "c/z"], tp, at(`${MON_2026}T12:00:00Z`)))
      .toEqual(["a/x", "b/y", "c/z"]);
  });

  it("tops go first, bottoms last, neutral in between", () => {
    const tp = { "b/y": inWindow, "c/z": bottomWindow };
    expect(reorderByTimePriority(["a/x", "b/y", "c/z"], tp, at(`${MON_2026}T12:00:00Z`)))
      .toEqual(["b/y", "a/x", "c/z"]);
  });

  it("ignores orphaned keys not present in models", () => {
    expect(reorderByTimePriority(["a/x"], { "gone/m": inWindow }, at(`${MON_2026}T12:00:00Z`))).toEqual(["a/x"]);
  });
});

describe("stripOrphanSchedules / countActiveSchedules", () => {
  const inWindow = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "00:00", to: "23:59", days: "daily" }] };
  const offWindow = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "05:00", to: "06:00", days: "daily" }] };

  it("drops keys absent from models and keeps the rest", () => {
    expect(stripOrphanSchedules({ "a/x": inWindow, "gone/m": inWindow }, ["a/x"])).toEqual({ "a/x": inWindow });
    expect(stripOrphanSchedules(null, ["a/x"])).toEqual({});
  });

  it("counts total schedules and currently active ones", () => {
    const tp = { "a/x": inWindow, "b/y": offWindow };
    expect(countActiveSchedules(tp, ["a/x", "b/y", "c/z"], at(`${MON_2026}T12:00:00Z`))).toEqual({ active: 1, total: 2 });
  });
});

describe("normalizeTimePriorityMap", () => {
  it("keeps valid entries and drops invalid ones", () => {
    const valid = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "01:00", to: "04:00", days: "daily" }] };
    const out = normalizeTimePriorityMap({ "a/x": valid, "b/y": { enabled: true, action: "nope", mode: "in", tz: "UTC", windows: [] } });
    expect(Object.keys(out)).toEqual(["a/x"]);
    expect(normalizeTimePriorityMap(null)).toEqual({});
  });
});

describe("nextScheduleBoundary", () => {
  it("finds the moment the schedule flips", () => {
    const window = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "10:00", to: "12:00", days: "daily" }] };
    const now = at(`${MON_2026}T09:30:00Z`);
    const boundary = nextScheduleBoundary(window, now);
    expect(boundary).toBe(at(`${MON_2026}T10:00:00Z`));
    const inside = nextScheduleBoundary(window, at(`${MON_2026}T11:00:00Z`));
    expect(inside).toBe(at(`${MON_2026}T12:00:00Z`));
  });
});

describe("TIME_PRIORITY_PRESETS", () => {
  it("every preset normalizes to a valid enabled schedule", () => {
    expect(TIME_PRIORITY_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const preset of TIME_PRIORITY_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.verifiedAt).toBeTruthy();
      expect(preset.providerPrefixes.length).toBeGreaterThan(0);
      const schedule = normalizeSlotSchedule(preset.schedule);
      expect(schedule, `preset ${preset.id}`).not.toBeNull();
      expect(schedule.enabled).toBe(true);
    }
  });

  it("deepseek preset matches the documented peak windows", () => {
    const preset = TIME_PRIORITY_PRESETS.find((p) => p.id === "deepseek-offpeak");
    expect(preset.schedule).toEqual({
      enabled: true,
      action: "top",
      mode: "except",
      tz: "UTC",
      windows: [
        { from: "01:00", to: "04:00", days: "weekdays" },
        { from: "06:00", to: "10:00", days: "weekdays" },
      ],
    });
    // Peak Wednesday 06:30 UTC — not boosted; Saturday — boosted.
    expect(active(preset.schedule, "2026-11-18T06:30:00Z")).toBe(false);
    expect(active(preset.schedule, "2026-11-14T06:30:00Z")).toBe(true);
  });

  it("has unique ids", () => {
    const ids = TIME_PRIORITY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
