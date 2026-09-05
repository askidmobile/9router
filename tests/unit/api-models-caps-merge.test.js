import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getModelAliases: vi.fn(),
  setModelAlias: vi.fn(),
  getCustomModels: vi.fn(),
  getDisabledModels: vi.fn(),
  getCapsOverrides: vi.fn(),
  getModelNameOverrides: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.jsonResponse },
}));

vi.mock("@/models", () => ({
  getModelAliases: mocks.getModelAliases,
  setModelAlias: mocks.setModelAlias,
  getCustomModels: mocks.getCustomModels,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("@/lib/db/index.js", () => ({
  getCapsOverrides: mocks.getCapsOverrides,
  getModelNameOverrides: mocks.getModelNameOverrides,
}));

const { GET } = await import("../../src/app/api/models/route.js");

describe("GET /api/models — caps overrides merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getCapsOverrides.mockResolvedValue({});
    mocks.getModelNameOverrides.mockResolvedValue({});
  });

  it("applies overrides on top of static caps and flags the model", async () => {
    mocks.getCapsOverrides.mockResolvedValue({
      "openai|gpt-4o": { contextWindow: 999000, vision: false, imageOutput: true },
    });

    const response = await GET();
    const model = response.body.models.find((m) => m.provider === "openai" && m.model === "gpt-4o");
    expect(model).toBeTruthy();

    // Override wins (both value override and explicit false)
    expect(model.caps.contextWindow).toBe(999000);
    expect(model.caps.vision).toBe(false);
    // Override adds fields missing from static caps
    expect(model.caps.imageOutput).toBe(true);
    // Static caps kept where the override is silent
    expect(model.caps.search).toBe(true);
    expect(model.caps.maxOutput).toBe(16384);
    expect(model.capsOverridden).toBe(true);
  });

  it("keeps static caps without capsOverridden flag when no override exists", async () => {
    const response = await GET();
    const model = response.body.models.find((m) => m.provider === "openai" && m.model === "gpt-4o");
    expect(model).toBeTruthy();

    expect(model.caps.contextWindow).toBe(128000);
    expect(model.caps.vision).toBe(true);
    expect(model.capsOverridden).toBeUndefined();
  });

  it("excludes disabled models", async () => {
    mocks.getDisabledModels.mockResolvedValue({ openai: ["gpt-4o"] });

    const response = await GET();
    expect(response.body.models.some((m) => m.provider === "openai" && m.model === "gpt-4o")).toBe(false);
  });

  it("applies saved limits and explicit false values to manually added models", async () => {
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "cx", id: "gpt-6-astra", caps: { vision: true, reasoning: true } },
    ]);
    mocks.getCapsOverrides.mockResolvedValue({
      "cx|gpt-6-astra": { contextWindow: 400000, maxOutput: 128000, vision: false, pdf: true, audioInput: true },
    });

    const response = await GET();
    const model = response.body.models.find((m) => m.fullModel === "cx/gpt-6-astra");
    expect(model.caps).toMatchObject({
      contextWindow: 400000, maxOutput: 128000, vision: false,
      reasoning: true, pdf: true, audioInput: true, tools: true,
    });
    expect(model.capsOverridden).toBe(true);
  });

  it("keeps custom capabilities when overrides are absent and isolates providers", async () => {
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "cx", id: "gpt-6-astra", caps: { vision: true } },
      { providerAlias: "custom-node", id: "gpt-6-astra", caps: { vision: false, videoInput: true, tools: false } },
    ]);
    mocks.getCapsOverrides.mockResolvedValue({ "cx|gpt-6-astra": { contextWindow: 400000 } });

    const response = await GET();
    const model = response.body.models.find((m) => m.fullModel === "custom-node/gpt-6-astra");
    expect(model.caps).toMatchObject({ vision: false, videoInput: true, tools: false });
    expect(model.caps.contextWindow).not.toBe(400000);
    expect(model.capsOverridden).toBeUndefined();
  });

  it("accepts overrides keyed by the registry ID and prefers the storage alias", async () => {
    mocks.getCustomModels.mockResolvedValue([{ providerAlias: "cx", id: "gpt-6-astra" }]);
    mocks.getCapsOverrides.mockResolvedValue({ "codex|gpt-6-astra": { contextWindow: 300000 } });
    let response = await GET();
    expect(response.body.models.find((m) => m.fullModel === "cx/gpt-6-astra").caps.contextWindow).toBe(300000);

    mocks.getCapsOverrides.mockResolvedValue({
      "codex|gpt-6-astra": { contextWindow: 300000 },
      "cx|gpt-6-astra": { contextWindow: 400000 },
    });
    response = await GET();
    expect(response.body.models.find((m) => m.fullModel === "cx/gpt-6-astra").caps.contextWindow).toBe(400000);
  });
});
