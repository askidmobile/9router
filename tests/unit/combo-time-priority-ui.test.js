// UI-side pure logic of slot schedules: rename transfer and preset prefix
// matching (the interactive parts are covered by the manual smoke run).
import { describe, expect, it } from "vitest";

import { TIME_PRIORITY_PRESETS, transferSlotSchedules } from "../../src/shared/services/comboTimePriority.js";

const inWindow = { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "01:00", to: "04:00", days: "weekdays" }] };

describe("transferSlotSchedules", () => {
  it("is a no-op without a real rename", () => {
    const strategies = { old: { timePriority: { "a/x": inWindow } } };
    expect(transferSlotSchedules(strategies, "old", "old")).toEqual({ strategies, moved: false });
    expect(transferSlotSchedules(strategies, "", "new")).toEqual({ strategies, moved: false });
  });

  it("is a no-op when the source has no schedules", () => {
    const strategies = { old: { contextWindow: 100 } };
    expect(transferSlotSchedules(strategies, "old", "new")).toEqual({ strategies, moved: false });
    expect(transferSlotSchedules({}, "gone", "new")).toEqual({ strategies: {}, moved: false });
  });

  it("moves schedules to the renamed combo and keeps other extras in place", () => {
    const strategies = {
      old: { fallbackStrategy: "round-robin", contextWindow: 100, timePriority: { "a/x": inWindow } },
    };
    const { strategies: next, moved } = transferSlotSchedules(strategies, "old", "new");
    expect(moved).toBe(true);
    expect(next.old).toEqual({ fallbackStrategy: "round-robin", contextWindow: 100 });
    expect(next.new).toEqual({ timePriority: { "a/x": inWindow } });
  });

  it("drops the old entry when it empties out", () => {
    const strategies = { old: { timePriority: { "a/x": inWindow } } };
    const { strategies: next } = transferSlotSchedules(strategies, "old", "new");
    expect(next.old).toBeUndefined();
    expect(next.new).toEqual({ timePriority: { "a/x": inWindow } });
  });

  it("merges into an existing target entry without clobbering its fields", () => {
    const strategies = {
      old: { timePriority: { "a/x": inWindow } },
      new: { maxOutput: 4096 },
    };
    const { strategies: next } = transferSlotSchedules(strategies, "old", "new");
    expect(next.new).toEqual({ maxOutput: 4096, timePriority: { "a/x": inWindow } });
  });
});

describe("preset provider prefixes", () => {
  it("every prefix ends with a slash (slot matching by 'provider/model')", () => {
    for (const preset of TIME_PRIORITY_PRESETS) {
      for (const prefix of preset.providerPrefixes) {
        expect(prefix.endsWith("/"), `${preset.id}: ${prefix}`).toBe(true);
      }
    }
  });

  it("aliases used by the router resolve to the right preset (ds → deepseek)", () => {
    const prefixes = TIME_PRIORITY_PRESETS.flatMap((preset) => preset.providerPrefixes.map((prefix) => ({ id: preset.id, prefix })));
    expect(prefixes.find((p) => p.prefix === "ds/").id).toBe("deepseek-offpeak");
    expect(prefixes.find((p) => p.prefix === "zai/").id).toBe("zai-coding-offpeak");
    expect(prefixes.find((p) => p.prefix === "alims/").id).toBe("qwen-idle");
  });
});
