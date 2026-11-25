// CodeBuddy intl: Hy4 / Hy4-Flash рассуждают, но комбо «Hy4» публиковал их без
// reasoning, и запрос к cbai уходил без reasoning_effort. Проверено живьём на
// www.codebuddy.ai 2026-11-25: «none» выключает рассуждение, прочие уровни принимаются.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels, getComboThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import PROVIDERS from "../../open-sse/providers/registry/index.js";

const { storage, kv, db } = vi.hoisted(() => {
  const storage = {};
  const kv = {
    getAll: async () => ({ ...storage }), get: async (k) => storage[k] || null,
    setMany: async (obj) => Object.assign(storage, obj), set: async (k, v) => { storage[k] = v; },
    remove: async (k) => { delete storage[k]; },
    updateMany: async (keys, update) => { for (const key of keys) { const value = update(storage[key] || null, key); if (value === null) delete storage[key]; else storage[key] = value; } },
  };
  return { storage, kv, db: {
    getProviderConnections: vi.fn(),
    getCombos: vi.fn(async () => []),
    getCustomModels: vi.fn(async () => []),
    getModelAliases: vi.fn(async () => ({})),
    getCapsOverrides: vi.fn(async () => ({})),
    getCapsMetadata: vi.fn(async () => ({})),
    getCustomModels: vi.fn(async () => []),
  } };
});

vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => kv }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/db/index.js", () => ({ getCapsOverrides: db.getCapsOverrides, getCapsMetadata: db.getCapsMetadata, getCustomModels: db.getCustomModels }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

const { getCapsOverrides } = await import("../../src/lib/db/repos/capsRepo.js");
const { getModelReasoningCaps } = await import("../../src/lib/modelReasoning.js");
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const LEVELS_ONLY = { contextWindow: 1048576, reasoningLevels: ["none", "low", "high"] };
const record = (manual) => ({ version: 1, manual, automatic: {}, sources: {}, manualSources: {} });

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  vi.clearAllMocks();
});

describe("CodeBuddy intl Hy4 reasoning", () => {
  it("lists hy4 and hy4-flash as reasoning models", () => {
    const entry = PROVIDERS.find((p) => p.id === "codebuddy-intl");
    expect(entry.models.map((m) => m.id)).toEqual(expect.arrayContaining(["hy4", "hy4-flash"]));
    expect(getCapabilitiesForModel("codebuddy-intl", "hy4")).toMatchObject({ reasoning: true, thinkingFormat: "openai" });
    expect(getThinkingLevels("codebuddy-intl", "hy4")).toEqual(["none", "high"]);
    expect(getThinkingLevels("codebuddy-intl", "hy4-flash")).toEqual(["none", "high"]);
  });

  it("resolves combo members spelled with the provider alias", () => {
    // Комбо хранит участников как «cbai/hy4»: без разворота алиаса провайдерные записи молчат.
    expect(getCapabilitiesForModel("cbai", "hy4").reasoning).toBe(true);
    expect(getThinkingLevels("cbai", "hy4")).toEqual(["none", "high"]);
    expect(getThinkingLevels("cbai", "hy4", { reasoningLevels: ["low", "high"] })).toEqual(["low", "high"]);
  });

  it("levels saved without the reasoning flag enable reasoning on the request path", async () => {
    // На проде у cbai|hy4-flash стояли только reasoningLevels — флаг reasoning выставлен не был.
    storage["cbai|hy4-flash"] = record(LEVELS_ONLY);
    expect((await getCapsOverrides())["cbai|hy4-flash"].reasoning).toBe(true);

    const caps = await getModelReasoningCaps("codebuddy-intl", "hy4-flash");
    const body = { model: "hy4-flash", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" };
    applyThinking("openai", "hy4-flash", body, "codebuddy-intl", undefined, caps);
    expect(body.reasoning_effort).toBe("high");
  });

  it("keeps an explicit reasoning:false above the listed levels", async () => {
    storage["oc|space-bunny"] = record({ reasoning: false, reasoningLevels: ["low"] });
    expect((await getCapsOverrides())["oc|space-bunny"].reasoning).toBe(false);
  });

  it("publishes the shared member levels on the combo", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: 1, provider: "codebuddy-intl", isActive: true, providerSpecificData: { enabledModels: ["hy4", "glm-5.3"] } },
    ]);
    db.getCombos.mockResolvedValue([{ name: "Hy4", models: ["cbai/hy4", "cbai/glm-5.3(high)"] }]);

    const models = await buildModelsList(["llm"]);
    const combo = models.find((m) => m.id === "Hy4");

    expect(combo.capabilities.reasoning).toBe(true);
    expect(combo.thinking_levels).toEqual(["high"]);
  });

  it("intersects member sets and stays silent when a member publishes none", () => {
    expect(getComboThinkingLevels(["cbai/hy4", "cbai/glm-5.3"])).toEqual(["high"]);
    expect(getComboThinkingLevels(["cbai/hy4", "cbai/hy4-preview"])).toEqual([]);
    expect(getComboThinkingLevels(["Nested", "cbai/hy4"], {}, {
      nestedModels: (name) => (name === "Nested" ? ["cbai/hy4", "cbai/glm-5.3"] : []),
    })).toEqual(["high"]);
  });
});
