// Providers that publish limits, capabilities and prices in their own
// /v1/models must be imported from there — models.dev lags behind the rate
// actually charged on the key and does not list every aggregator at all.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  updatePricing: vi.fn(async () => ({})),
  setCapsOverridesBulk: vi.fn(async () => {}),
  connections: [],
  modelsDev: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ body, status: init?.status || 200, ok: !init?.status || init.status < 400 }) },
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: async (id) => mocks.connections.find((c) => c.id === id) || null,
  getProviderConnections: async () => mocks.connections,
}));
// The endpoint is a thin wrapper over src/lib/providerCatalog/import.js, which
// reads adapters directly.
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: async () => ({}) }));
// The import module reads connections and adapters from this barrel.
vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: async (id) => mocks.connections.find((c) => c.id === id) || null,
  getProviderConnections: async () => mocks.connections,
  updatePricing: mocks.updatePricing,
  setCapsOverridesBulk: mocks.setCapsOverridesBulk,
  addCustomModelsBulk: async () => ({ added: 0, skipped: 0 }),
}));
vi.mock("@/lib/modelsDev/index.js", () => ({ getProviderModels: mocks.modelsDev }));

import { catalogMetadata } from "@/lib/providerCatalog/metadata.js";
import { POST } from "@/app/api/providers/import-models/route.js";

const CHEAPER_ENTRY = {
  id: "claude-opus-5.5",
  context_length: 1000000,
  max_output_tokens: 128000,
  type: "text",
  capabilities: { vision: true, reasoning: true, video: false, streaming: true },
  pricing: {
    currency: "USD",
    input_per_million: "2.600000",
    output_per_million: "13.000000",
    cache_read_input_per_million: "0.650000000000000000000000",
    cache_write_input_per_million: "3.250000000000000000000000",
  },
};

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.updatePricing.mockClear();
  mocks.setCapsOverridesBulk.mockClear();
  mocks.modelsDev.mockReset();
  mocks.connections = [{
    id: "conn-cheaper", provider: "cheaper", isActive: true, apiKey: "ci_live_x",
    providerSpecificData: {},
  }];
  globalThis.fetch = mocks.fetch;
});

describe("catalogMetadata", () => {
  it("maps limits, capabilities and the charged price", () => {
    expect(catalogMetadata(CHEAPER_ENTRY)).toEqual({
      id: "claude-opus-5.5",
      caps: { contextWindow: 1000000, maxOutput: 128000, vision: true, reasoning: true, videoInput: false },
      pricing: { input: 2.6, output: 13, cached: 0.65, cache_creation: 3.25 },
    });
  });

  it("omits capabilities the catalog does not declare", () => {
    // An absent flag must not clobber a capability resolved elsewhere.
    const meta = catalogMetadata({ id: "m", capabilities: { vision: true }, pricing: {} });
    expect(meta.caps).toEqual({ vision: true });
    expect(meta.pricing).toBeNull();
  });

  it("skips media entries, which bill per unit and have no context window", () => {
    expect(catalogMetadata({ id: "nano-banana", type: "image", pricing: { input_per_million: "1" } })).toBeNull();
    expect(catalogMetadata({ id: "seedance-2.0", type: "video" })).toBeNull();
  });

  it("ignores unusable prices instead of publishing a bogus one", () => {
    const meta = catalogMetadata({ id: "m", pricing: { input_per_million: "n/a", output_per_million: "-3" } });
    expect(meta.pricing).toBeNull();
  });
});

describe("POST /api/providers/import-models", () => {
  it("imports caps and pricing from the provider's own catalog", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [CHEAPER_ENTRY] }) });
    const res = await POST({ json: async () => ({ provider: "cheaper" }) });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("provider");
    expect(mocks.fetch).toHaveBeenCalledWith("https://api.cheaperinference.com/v1/models", expect.anything());
    expect(mocks.updatePricing).toHaveBeenCalledWith({
      cheaper: { "claude-opus-5.5": { input: 2.6, output: 13, cached: 0.65, cache_creation: 3.25 } },
    });
    expect(mocks.setCapsOverridesBulk).toHaveBeenCalledWith("cheaper", {
      "claude-opus-5.5": { contextWindow: 1000000, maxOutput: 128000, vision: true, reasoning: true, videoInput: false },
    });
    expect(mocks.modelsDev).not.toHaveBeenCalled();
  });

  it("falls back to models.dev when the provider catalog is unavailable", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    mocks.modelsDev.mockResolvedValue({
      modelsDevId: "some-vendor", stale: false,
      models: { "m-1": { caps: { vision: true }, pricing: { input: 1, output: 2 } } },
    });
    const res = await POST({ json: async () => ({ provider: "cheaper" }) });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("models.dev");
    // The failure of the provider endpoint is reported, not silently swallowed.
    expect(res.body.warning).toContain("404");
    expect(mocks.updatePricing).toHaveBeenCalledWith({ cheaper: { "m-1": { input: 1, output: 2 } } });
  });

  it("reports a clear error when neither source has a catalog", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    mocks.modelsDev.mockResolvedValue({ modelsDevId: null, models: null, stale: false });
    const res = await POST({ json: async () => ({ provider: "cheaper" }) });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("cheaper");
  });

  it("rejects a request without a provider or connection", async () => {
    const res = await POST({ json: async () => ({}) });
    expect(res.status).toBe(400);
  });
});
