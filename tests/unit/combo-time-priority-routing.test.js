// Time-priority reordering inside handleComboChat: an active slot schedule
// overrides the strategy order (fallback / round-robin / smart+sticky) while
// the capability tier sort still beats price. Deterministic via the explicit
// `nowMs` snapshot — no clock mocking, immediate JSON member responses only.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const LOG = { line: vi.fn(), errorLine: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const at = (iso) => new Date(iso).getTime();
// 2026-11-16 is a Monday, 2026-11-14 a Saturday; the weekday window below is
// therefore active at ACTIVE_MS and inactive at INACTIVE_MS.
const ACTIVE_MS = at("2026-11-16T12:00:00Z");
const INACTIVE_MS = at("2026-11-14T12:00:00Z");

const boostTop = {
  "b/y": { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "00:00", to: "23:59", days: "weekdays" }] },
};
const boostBottom = { "b/y": { ...boostTop["b/y"], action: "bottom" } };

const jsonRes = (model, status, content) => new Response(
  JSON.stringify({ id: "x", model, choices: [{ index: 0, message: { role: "assistant", content: content ?? `ok-${model}` }, finish_reason: "stop" }] }),
  { status, headers: { "Content-Type": "application/json" } }
);

// Every member fails with a plain 500 so the loop walks the whole order and
// `tried` records it; skipCooldown keeps the walk immediate.
async function runCombo({ models, timePriority = null, nowMs, strategy = "fallback", body, ...rest }) {
  const tried = [];
  const res = await handleComboChat({
    body: body || { messages: [{ role: "user", content: "hi" }] },
    models,
    handleSingleModel: async (_b, m) => { tried.push(m); return jsonRes(m, 500); },
    log: LOG,
    comboName: `tp-${Math.random().toString(36).slice(2)}`,
    comboStrategy: strategy,
    skipCooldown: true,
    timePriority,
    nowMs,
    ...rest,
  });
  return { tried, res };
}

describe("handleComboChat time-priority ordering", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("floats an active top slot above the fallback order", async () => {
    const { tried } = await runCombo({ models: ["a/x", "b/y", "c/z"], timePriority: boostTop, nowMs: ACTIVE_MS });
    expect(tried).toEqual(["b/y", "a/x", "c/z"]);
  });

  it("keeps the configured order outside the window", async () => {
    const { tried } = await runCombo({ models: ["a/x", "b/y", "c/z"], timePriority: boostTop, nowMs: INACTIVE_MS });
    expect(tried).toEqual(["a/x", "b/y", "c/z"]);
  });

  it("sinks an active bottom slot below the fallback order", async () => {
    const { tried } = await runCombo({ models: ["a/x", "b/y", "c/z"], timePriority: boostBottom, nowMs: ACTIVE_MS });
    expect(tried).toEqual(["a/x", "c/z", "b/y"]);
  });

  it("beats round-robin rotation for as long as the window is active", async () => {
    const first = await runCombo({ models: ["a/x", "b/y", "c/z"], timePriority: boostTop, nowMs: ACTIVE_MS, strategy: "round-robin" });
    const second = await runCombo({ models: ["a/x", "b/y", "c/z"], timePriority: boostTop, nowMs: ACTIVE_MS, strategy: "round-robin" });
    expect(first.tried[0]).toBe("b/y");
    expect(second.tried[0]).toBe("b/y");
  });

  it("overrides the smart router's sticky model while the window is active", async () => {
    const comboName = `smart-${Math.random().toString(36).slice(2)}`;
    const sessionId = `s-${Math.random().toString(36).slice(2)}`;
    const resolveSmartChoice = async () => ({ choice: "a/x", probabilities: { "a/x": 1 }, confidence: 0.95 });

    // Turn 1 (window inactive): the router picks a/x and the session sticks to it.
    const turn1 = await runCombo({
      models: ["a/x", "b/y"], strategy: "smart", timePriority: boostTop, nowMs: INACTIVE_MS,
      comboName, sessionId, resolveSmartChoice,
    });
    expect(turn1.tried[0]).toBe("a/x");

    // Turn 2 (window active): the schedule floats b/y above the sticky a/x.
    const turn2 = await runCombo({
      models: ["a/x", "b/y"], strategy: "smart", timePriority: boostTop, nowMs: ACTIVE_MS,
      comboName, sessionId, resolveSmartChoice,
    });
    expect(turn2.tried).toEqual(["b/y", "a/x"]);
  });

  it("capability tiers still beat the schedule on capability-requiring requests", async () => {
    const models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];
    const tp = {
      // boost the vision-less model to the top for the whole weekday
      "deepseek/deepseek-chat": { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "00:00", to: "23:59", days: "weekdays" }] },
    };
    const visionBody = { messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
    ] }] };

    const vision = await runCombo({ models, timePriority: tp, nowMs: ACTIVE_MS, body: visionBody });
    expect(vision.tried[0]).toBe("anthropic/claude-sonnet-4.6"); // correctness first

    const text = await runCombo({ models, timePriority: tp, nowMs: ACTIVE_MS });
    expect(text.tried[0]).toBe("deepseek/deepseek-chat"); // price first
  });
});
