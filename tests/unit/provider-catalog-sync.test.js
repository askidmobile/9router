// Scheduled catalog refresh: only opted-in providers, per-provider failures are
// isolated, and the import path writes prices, limits and the model list.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  settings: { catalogSyncProviders: [] },
  connections: [],
  addedBulk: vi.fn(async () => ({ added: 3, skipped: 0 })),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ body, status: init?.status || 200, ok: !init?.status || init.status < 400 }) },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mocks.settings,
  updateSettings: vi.fn(),
  getProviderConnectionById: async () => null,
  getProviderConnections: async () => mocks.connections,
}));
vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: async () => null,
  getProviderConnections: async () => mocks.connections,
  addCustomModelsBulk: mocks.addedBulk,
  updatePricing: vi.fn(async () => ({})),
  setCapsOverridesBulk: vi.fn(async () => {}),
}));
vi.mock("@/lib/modelsDev/index.js", () => ({
  getProviderModels: async () => ({ modelsDevId: null, models: null, stale: false }),
}));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: async () => mocks.connections,
}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: async () => mocks.settings,
}));

import { importProviderCatalog, findImportConnection } from "@/lib/providerCatalog/import.js";
import { syncProviderCatalogs, getSyncProviders } from "@/lib/providerCatalog/sync.js";

const CATALOG = {
  data: [
    { id: "glm-5.3", type: "text", context_length: 1000000, max_output_tokens: 128000,
      capabilities: { vision: true, reasoning: true }, pricing: { input_per_million: "0.08", output_per_million: "0.27" } },
    { id: "new-model-1", type: "text", context_length: 200000,
      pricing: { input_per_million: "1", output_per_million: "2" } },
  ],
};

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.addedBulk.mockClear();
  mocks.settings = { catalogSyncProviders: [] };
  mocks.connections = [{ id: "c1", provider: "cheaper", isActive: true, apiKey: "k", providerSpecificData: {} }];
  globalThis.fetch = mocks.fetch;
});

describe("scheduled provider catalog sync", () => {
  it("does nothing while no provider is opted in", async () => {
    const result = await syncProviderCatalogs();
    expect(result).toMatchObject({ synced: 0, failed: 0 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("skips a provider that has no active connection", async () => {
    mocks.settings = { catalogSyncProviders: ["cheaper", "groq"] };
    mocks.connections = [{ id: "c1", provider: "cheaper", isActive: true, apiKey: "k", providerSpecificData: {} }];
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => CATALOG });
    const result = await syncProviderCatalogs();
    expect(result.providers.groq).toMatchObject({ status: "skipped" });
    expect(result.providers.cheaper).toMatchObject({ status: "ok", pricing: 2, caps: 2 });
  });

  it("registers newly listed models so they become selectable", async () => {
    mocks.settings = { catalogSyncProviders: ["cheaper"] };
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => CATALOG });
    const result = await syncProviderCatalogs();
    expect(result.providers.cheaper.models).toBe(3);
    expect(mocks.addedBulk).toHaveBeenCalledWith({ providerAlias: "cheaper", type: "llm", ids: ["glm-5.3", "new-model-1"] });
  });

  it("isolates one provider's failure from the rest", async () => {
    // One vendor's listing is down; the other must still refresh in the same run.
    mocks.settings = { catalogSyncProviders: ["groq", "cheaper"] };
    mocks.connections = [
      { id: "c1", provider: "cheaper", isActive: true, apiKey: "k", providerSpecificData: {} },
      { id: "c2", provider: "groq", isActive: true, apiKey: "k", providerSpecificData: {} },
    ];
    mocks.fetch.mockImplementation(async (url) =>
      String(url).includes("cheaperinference")
        ? { ok: true, json: async () => CATALOG }
        : { ok: false, status: 503, json: async () => ({}) }
    );
    const result = await syncProviderCatalogs();
    expect(result.providers.cheaper).toMatchObject({ status: "ok", pricing: 2 });
    expect(result.providers.groq).toMatchObject({ status: "error" });
    expect(result.providers.groq.error).toContain("503");
    expect(result).toMatchObject({ synced: 1, failed: 1 });
  });

  it("reads the opt-in list from settings and filters junk", async () => {
    mocks.settings = { catalogSyncProviders: ["cheaper", "", 42, null, "groq"] };
    expect(await getSyncProviders()).toEqual(["cheaper", "groq"]);
  });
});

describe("import with registration", () => {
  it("registers every metadata-bearing id when asked", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => CATALOG });
    const connection = await findImportConnection({ provider: "cheaper" });
    const result = await importProviderCatalog({ connection, registerModels: true });
    expect(result.source).toBe("provider");
    expect(result.pricing).toEqual({ imported: 2 });
    expect(result.registered).toEqual({ added: 3, skipped: 0 });
  });

  it("leaves the model list alone without registerModels", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => CATALOG });
    const connection = await findImportConnection({ provider: "cheaper" });
    const result = await importProviderCatalog({ connection });
    expect(result.registered).toBeUndefined();
    expect(mocks.addedBulk).not.toHaveBeenCalled();
  });
});
