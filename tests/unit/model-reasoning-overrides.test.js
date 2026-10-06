import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getCapsOverrides: vi.fn(), getCustomModels: vi.fn(),
  setCapsOverride: vi.fn(), deleteCapsOverride: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => db);

const { PUT } = await import("../../src/app/api/models/caps/route.js");
const { getModelReasoningCaps, resolveModelReasoningCaps } = await import("../../src/lib/modelReasoning.js");
const { getThinkingLevels } = await import("../../open-sse/providers/thinkingLevels.js");
const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

const levels = ["low", "medium", "high", "xhigh", "max"];
const request = (caps) => new Request("http://localhost/api/models/caps", {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "ocg", model: "space-bunny", caps }),
});

beforeEach(() => {
  vi.clearAllMocks();
  db.getCapsOverrides.mockResolvedValue({});
  db.getCustomModels.mockResolvedValue([]);
});

describe("persisted reasoning effort settings", () => {
  it("accepts and persists an explicit list without a static model entry", async () => {
    const caps = { reasoning: true, reasoningLevels: levels, contextWindow: 1000000 };
    const response = await PUT(request(caps));
    expect(response.status).toBe(200);
    expect(db.setCapsOverride).toHaveBeenCalledWith("ocg", "space-bunny", caps);
  });

  it.each([[], null].map(reasoningLevels => ({ reasoningLevels })))("accepts empty choices and catalog reset (%j)", async ({ reasoningLevels }) => {
    expect((await PUT(request({ reasoningLevels }))).status).toBe(200);
    expect(db.setCapsOverride).toHaveBeenCalledWith("ocg", "space-bunny", { reasoningLevels });
  });

  it.each([["low", "low"], ["typo"], [5], "high", {}, ["thinking"]].map(reasoningLevels => ({ reasoningLevels })))("rejects invalid lists %j before writing", async ({ reasoningLevels }) => {
    const response = await PUT(request({ reasoningLevels }));
    expect(response.status).toBe(400);
    expect(db.setCapsOverride).not.toHaveBeenCalled();
    expect(db.deleteCapsOverride).not.toHaveBeenCalled();
  });

  it("resolves registry IDs, storage aliases and suffixes without crossing providers", () => {
    const caps = resolveModelReasoningCaps("opencode-go", "space-bunny(max)", {
      "ocg|space-bunny": { reasoningLevels: levels, vision: false },
      "openai|space-bunny": { reasoningLevels: ["low"] },
    }, [{ providerAlias: "ocg", id: "space-bunny", caps: { reasoning: true, tools: true } }]);
    expect(caps).toEqual({ reasoning: true, reasoningLevels: levels });
    expect(resolveModelReasoningCaps("openai", "space-bunny", {}, [{
      providerAlias: "ocg", id: "space-bunny", caps: { reasoning: true, reasoningLevels: levels },
    }])).toEqual({});
  });

  it("reads changes on subsequent requests without restarting", async () => {
    db.getCustomModels.mockResolvedValue([{ providerAlias: "ocg", id: "space-bunny", caps: { reasoning: true } }]);
    db.getCapsOverrides.mockResolvedValue({ "ocg|space-bunny": { reasoningLevels: levels } });
    expect(await getModelReasoningCaps("opencode-go", "space-bunny")).toEqual({ reasoning: true, reasoningLevels: levels });
    db.getCapsOverrides.mockResolvedValue({ "ocg|space-bunny": { reasoning: false, reasoningLevels: ["high"] } });
    expect(await getModelReasoningCaps("opencode-go", "space-bunny")).toEqual({ reasoning: false, reasoningLevels: ["high"] });
  });
});

describe("reasoning override reaches provider normalization", () => {
  it.each(levels)("preserves configured %s on an unknown OpenAI-compatible model", level => {
    const caps = { reasoning: true, reasoningLevels: levels };
    expect(getThinkingLevels("openai-compatible-fixture", "space-bunny", caps)).toEqual(levels);
    const body = { reasoning: { effort: level, summary: "auto" } };
    applyThinking("openai", "space-bunny", body, "openai-compatible-fixture", undefined, caps);
    expect(body.reasoning_effort).toBe(level);
    expect(body.reasoning).toBeUndefined();
  });

  it("retains the existing max clamp when catalog defaults are selected", () => {
    const body = { reasoning_effort: "max" };
    applyThinking("openai", "gpt-5", body, "openai", undefined, { reasoningLevels: null });
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("respects an explicit false reasoning flag", () => {
    expect(getThinkingLevels("openai", "gpt-5", { reasoning: false, reasoningLevels: levels })).toBeNull();
    const body = { reasoning_effort: "max" };
    applyThinking("openai", "gpt-5", body, "openai", undefined, { reasoning: false, reasoningLevels: levels });
    expect(body.reasoning_effort).toBeUndefined();
  });
});
