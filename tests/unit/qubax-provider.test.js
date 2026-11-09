import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { parseModel } from "../../open-sse/services/model.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { normalizeQubaxModels, probeQubaxApiKey } from "../../open-sse/services/qubax.js";
import { QUBAX_BASE_URL, QUBAX_MODELS_URL } from "../../open-sse/config/qubax.js";
import { catalogMetadata } from "../../src/lib/providerCatalog/metadata.js";
import { deriveModelsEndpoint } from "../../src/lib/providerModels/deriveModelsEndpoint.js";
import { APIKEY_PROVIDERS, getProviderByAlias } from "../../src/shared/constants/providers.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

const mocks = vi.hoisted(() => ({
  connection: { id: "conn-qubax", provider: "qubax", authType: "apikey", apiKey: "test-key", providerSpecificData: {} },
  updateProviderConnection: vi.fn(),
  updatePricing: vi.fn(),
  setCapsOverridesBulk: vi.fn(),
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => new Response(JSON.stringify(body), { status: init?.status || 200 }) } }));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn(), getProviderConnectionById: async () => mocks.connection }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: async () => mocks.connection, updateProviderConnection: mocks.updateProviderConnection }));
vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: async () => mocks.connection, getProviderConnections: async () => [mocks.connection],
  updatePricing: mocks.updatePricing, setCapsOverridesBulk: mocks.setCapsOverridesBulk, addCustomModelsBulk: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn() }));
vi.mock("@/lib/modelsDev/index.js", () => ({ getProviderModels: vi.fn(), getExactModelFallbacks: async () => ({}) }));
vi.mock("@/lib/modelSources/index.js", async original => ({ ...await original(), getSupplementaryMetadata: async () => ({ models: {} }) }));

const { POST: validate } = await import("../../src/app/api/providers/validate/route.js");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const { GET: listModels } = await import("../../src/app/api/providers/[id]/models/route.js");
const { resolveProviderCatalog } = await import("../../src/lib/providerCatalog/import.js");

const model = {
  id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1048576, max_output_length: 384000,
  input_modalities: ["text"], output_modalities: ["text"],
  capabilities: { reasoning: true, tools: true, vision: false, webSearch: false, reasoningEffortLevels: ["low", "medium", "high"] },
  pricing: [{ prompt: "0.000002", completion: "0.000008" }],
  pricing_summary: { prompt_per_1m: 0.0003, completion_per_1m: 0.013924, cache_read_per_1m: 0.00025, cache_write_per_1m: null },
};
const payload = { data: [model,
  { id: "image", input_modalities: ["text"], output_modalities: ["image"] },
  { id: "video", input_modalities: ["text"], output_modalities: ["video"] },
  { id: "tts", input_modalities: ["text"], output_modalities: ["audio"] },
  { id: "stt", input_modalities: ["audio"], output_modalities: ["text"] },
  { id: "embed", input_modalities: ["text"], output_modalities: ["embedding"] },
  { id: "decisions", input_modalities: ["text"], output_modalities: ["decisions"] },
] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => vi.unstubAllGlobals());

describe("Qubax native provider", () => {
  it("is discoverable in the dashboard and routes aliases and future model IDs", () => {
    expect(APIKEY_PROVIDERS.qubax.name).toBe("Qubax AI");
    expect(getProviderByAlias("qubaxai").id).toBe("qubax");
    expect(parseModel("qubaxai/future-model")).toMatchObject({ provider: "qubax", model: "future-model" });
    const entry = REGISTRY.find(entry => entry.id === "qubax");
    expect(entry.passthroughModels).toBe(true);
    expect(deriveModelsEndpoint(entry)).toEqual({ url: QUBAX_MODELS_URL, style: "openai" });
  });

  it.each([["openai", "chat/completions", "Authorization", "Bearer test-key"],
    ["openai-responses", "responses", "Authorization", "Bearer test-key"],
    ["claude", "messages", "x-api-key", "test-key"]])("uses the shared executor for %s with native authentication", (format, path, header, auth) => {
    const executor = getExecutor("qubax");
    const credentials = { apiKey: "test-key", runtimeTransport: resolveTransport("qubax", format) };
    expect(executor.buildUrl(model.id, true, 0, credentials)).toBe(`${QUBAX_BASE_URL}/${path}`);
    expect(executor.buildHeaders(credentials)[header]).toBe(auth);
    if (format === "claude") expect(executor.buildHeaders(credentials)["anthropic-version"]).toBe("2023-06-01");
  });

  it("normalizes only chat models, current offer prices, limits and declared reasoning levels", () => {
    const models = normalizeQubaxModels(payload);
    expect(models).toHaveLength(1);
    expect(FILTERS.qubax(payload.data)).toEqual(models);
    expect(catalogMetadata(models[0])).toMatchObject({
      id: model.id, caps: { contextWindow: 1048576, maxOutput: 384000, reasoning: true, tools: true, vision: false, search: false, reasoningLevels: ["low", "medium", "high"] },
      pricing: { input: 0.0003, output: 0.013924, cached: 0.00025 },
    });
    expect(catalogMetadata(models[0]).pricing).not.toHaveProperty("cache_creation");
  });

  it("leaves unknown metadata absent and rejects malformed catalogs and IDs", () => {
    expect(normalizeQubaxModels({ data: {} })).toEqual([]);
    expect(normalizeQubaxModels([null, {}, { id: " " }])).toEqual([]);
    const [minimal] = normalizeQubaxModels([{ id: "future" }]);
    expect(catalogMetadata(minimal)).toEqual({ id: "future", caps: null, pricing: null });
    const [defaults] = normalizeQubaxModels([{ ...model, capabilities: { reasoning: true, reasoningEffortLevels: ["default"] } }]);
    expect(catalogMetadata(defaults).caps).not.toHaveProperty("reasoningLevels");
  });

  it("uses the normalized catalog in the actual model-list and catalog-import paths", async () => {
    fetch.mockImplementation(async () => json(payload));
    const response = await listModels(new Request("http://localhost/api/providers/conn-qubax/models?refresh=1"), { params: Promise.resolve({ id: "conn-qubax" }) });
    expect((await response.json()).models.map(model => model.id)).toEqual([model.id]);
    const catalog = await resolveProviderCatalog(mocks.connection);
    expect(catalog.source).toBe("provider");
    expect(catalog.models).toEqual(normalizeQubaxModels(payload));
    expect(fetch).toHaveBeenCalledWith(QUBAX_MODELS_URL, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-key" }) }));
  });

  it("validates new and saved keys with authenticated inference, never the public catalog", async () => {
    fetch.mockImplementation(async () => json({ choices: [] }));
    const response = await validate(new Request("http://localhost/api/providers/validate", { method: "POST", body: JSON.stringify({ provider: "qubax", apiKey: "test-key" }) }));
    expect(await response.json()).toEqual({ valid: true, error: null });
    expect((await testSingleConnection("conn-qubax")).valid).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe(`${QUBAX_BASE_URL}/chat/completions`);
      expect(options.headers.Authorization).toBe("Bearer test-key");
      expect(JSON.parse(options.body)).toMatchObject({ model: "gpt-4o-mini", max_tokens: 1, stream: false });
    }
  });

  it("reports network failures for saved keys and falls back to seed models for catalog failures", async () => {
    fetch.mockRejectedValue(new Error("network unavailable"));
    expect(await testSingleConnection("conn-qubax")).toMatchObject({ valid: false, error: "network unavailable" });
    const response = await listModels(new Request("http://localhost/api/providers/conn-qubax/models?refresh=1"), { params: Promise.resolve({ id: "conn-qubax" }) });
    const result = await response.json();
    expect(result.models.some(model => model.id === "gpt-6-astra")).toBe(true);
    expect(result.warning).toContain("network unavailable");
  });

  it.each([401, 403, 402, 429, 500])("does not accept HTTP %i as verified credentials", async status => {
    fetch.mockResolvedValue(json({}, status));
    const result = await probeQubaxApiKey("bad-key");
    expect(result.valid).toBe(false);
    expect(result.error).toBe(status === 401 || status === 403 ? "Invalid or inactive API key" : `Unable to verify API key (Qubax AI returned ${status})`);
  });
});
