// Providers that publish limits, capabilities and prices in their own
// /v1/models must be imported from there — models.dev lags behind the rate
// actually charged on the key and does not list every aggregator at all.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  updatePricing: vi.fn(async () => ({})),
  setCapsOverridesBulk: vi.fn(async () => {}),
  connections: [],
  modelsDev: vi.fn(), exact: vi.fn(async () => ({})),
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
  addCustomModelsBulk: async ({ ids }) => ({ added: ids.length, skipped: 0 }),
}));
vi.mock("@/lib/modelsDev/index.js", () => ({ getProviderModels: mocks.modelsDev, getExactModelFallbacks: mocks.exact }));

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
  mocks.exact.mockResolvedValue({});
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

  it("converts Requesty's per-token rates to per-million", () => {
    const meta = catalogMetadata({
      id: "openai/gpt-4o", context_window: 128000, max_output_tokens: 16384,
      input_price: 2.5e-6, cached_price: 1.25e-6, output_price: 1e-5,
      supports_vision: true, supports_tool_calling: true,
    });
    expect(meta.pricing).toEqual({ input: 2.5, output: 10, cached: 1.25 });
    expect(meta.caps).toEqual({ contextWindow: 128000, maxOutput: 16384, vision: true, tools: true });
  });

  it("reads APInex's flat per-million rate and short-form context", () => {
    const meta = catalogMetadata({ id: "glm-5.3-flash", contextWindow: "1M", dollarsPer1M: 0.05 });
    expect(meta.pricing).toEqual({ input: 0.05, output: 0.05 });
    expect(meta.caps).toEqual({ contextWindow: 1000000 });
  });

  it("keeps a zero price free instead of dropping it", () => {
    const meta = catalogMetadata({ id: "free/kimi-k3", contextWindow: "500K", dollarsPer1M: 0 });
    expect(meta.pricing).toEqual({ input: 0, output: 0 });
    expect(meta.caps.contextWindow).toBe(500000);
  });

  it("does not invent a false capability from an absent flag", () => {
    const meta = catalogMetadata({ id: "m", capabilities: { vision: true } });
    expect(Object.keys(meta.caps)).toEqual(["vision"]);
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
    }, expect.objectContaining({ sources: expect.any(Object) }));
    expect(mocks.modelsDev).toHaveBeenCalled();
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

describe("field-wise catalog completion", () => {
  it("uses exact supplementary OUT/efforts while preserving provider CTX and explicit false", async () => {
    mocks.fetch.mockResolvedValue({ok:true,json:async()=>({data:[{id:"m",context_length:1000000,capabilities:{vision:false}}]})});
    mocks.modelsDev.mockResolvedValue({modelsDevId:"vendor",fetchedAt:1700000000000,models:{m:{caps:{contextWindow:1048576,maxOutput:32000,vision:true,reasoningLevels:["low","high"]}}}});
    const result=await POST({json:async()=>({provider:"cheaper",targets:["caps"]})});
    expect(result.status).toBe(200);
    const [,caps,options]=mocks.setCapsOverridesBulk.mock.calls[0];
    expect(caps.m).toEqual({contextWindow:1000000,maxOutput:32000,vision:false,reasoningLevels:["low","high"]});
    expect(options.sources.m.contextWindow.source).toBe("provider");
    expect(options.sources.m.maxOutput.source).toBe("models.dev");
    expect(options.sources.m.maxOutput.updatedAt).toBe("2023-11-14T22:13:20.000Z");
  });
  it("imports declared effort choices without inferring choices from a reasoning boolean",()=>{
    expect(catalogMetadata({id:"m",supports_reasoning:true}).caps).toEqual({reasoning:true});
    expect(catalogMetadata({id:"m",reasoning_levels:["high","none","low","high"]}).caps).toEqual({reasoning:true,reasoningLevels:["none","low","high"]});
    expect(catalogMetadata({id:"m",supported_reasoning_levels:[{effort:"high"},{effort:"low"}]}).caps.reasoningLevels).toEqual(["low","high"]);
    expect(catalogMetadata({id:"m",reasoning_levels:["vendor-magic"]}).caps).toBeNull();
  });
});
