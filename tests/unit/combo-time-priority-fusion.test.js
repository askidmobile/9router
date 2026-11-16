// Fusion + time-priority: an active window reorders the parallel panel, and
// the judge default follows the reordered panel[0] unless an explicit judge
// model is configured (PD-007).
import { describe, it, expect, vi } from "vitest";
import { handleFusionChat } from "../../open-sse/services/combo.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const LOG = { line: vi.fn(), errorLine: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const at = (iso) => new Date(iso).getTime();
// Monday 2026-11-16 — the weekday window below is active all day.
const ACTIVE_MS = at("2026-11-16T12:00:00Z");

const boostTop = {
  "b/y": { enabled: true, action: "top", mode: "in", tz: "UTC", windows: [{ from: "00:00", to: "23:59", days: "weekdays" }] },
};

const jsonRes = (model) => new Response(
  JSON.stringify({ id: "x", model, choices: [{ index: 0, message: { role: "assistant", content: `answer from ${model}` }, finish_reason: "stop" }] }),
  { status: 200, headers: { "Content-Type": "application/json" } }
);

async function runFusion({ models, timePriority = null, judgeModel = undefined }) {
  const calls = [];
  const res = await handleFusionChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models,
    handleSingleModel: async (_b, m, isPanel) => { calls.push({ model: m, isPanel }); return jsonRes(m); },
    log: LOG,
    comboName: `f-${Math.random().toString(36).slice(2)}`,
    judgeModel,
    timePriority,
    nowMs: ACTIVE_MS,
  });
  return { calls, res };
}

describe("handleFusionChat time-priority", () => {
  it("judge default follows the reordered panel[0]", async () => {
    const { calls } = await runFusion({ models: ["a/x", "b/y"], timePriority: boostTop });
    const panelCalls = calls.filter((c) => c.isPanel === true);
    const judgeCall = calls.find((c) => c.isPanel !== true);
    expect(panelCalls.map((c) => c.model).sort()).toEqual(["a/x", "b/y"]);
    expect(judgeCall.model).toBe("b/y"); // boosted slot became panel[0] and thus judge
  });

  it("an explicit judge model is not displaced by the reorder", async () => {
    const { calls } = await runFusion({ models: ["a/x", "b/y"], timePriority: boostTop, judgeModel: "a/x" });
    const judgeCall = calls.find((c) => c.isPanel !== true);
    expect(judgeCall.model).toBe("a/x");
  });

  it("without schedules the panel order is untouched", async () => {
    const { calls } = await runFusion({ models: ["a/x", "b/y"] });
    const judgeCall = calls.find((c) => c.isPanel !== true);
    expect(judgeCall.model).toBe("a/x"); // original panel[0]
  });
});
