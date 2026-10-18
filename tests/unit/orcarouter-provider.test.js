import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import orcarouter from "../../open-sse/providers/registry/orcarouter.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { FREE_TIER_PROVIDERS, resolveProviderId } from "@/shared/constants/providers";
import { parseModel } from "../../open-sse/services/model.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getPricingForModel, ZERO_PRICING } from "../../open-sse/providers/pricing.js";
import { normalizeOrcaRouterFreeModels } from "../../open-sse/services/orcarouter.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  updateConnection: vi.fn(),
  resolveProxy: vi.fn(),
  proxyFetch: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: {
  json: (body, init = {}) => new Response(JSON.stringify(body), {
    status: init.status || 200, headers: { "Content-Type": "application/json" },
  }),
} }));
vi.mock("@/models", () => ({
  getProviderNodeById: vi.fn(), getProviderConnectionById: mocks.getConnection,
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getConnection, updateProviderConnection: mocks.updateConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveProxy }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyFetch }));

const { POST: validateProvider } = await import("../../src/app/api/providers/validate/route.js");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const { GET: listModels } = await import("../../src/app/api/providers/[id]/models/route.js");
const { GET: suggestModels } = await import("../../src/app/api/providers/suggested-models/route.js");

const modelsUrl = "https://api.orcarouter.ai/v1/models";
const freeModel = "deepseek/deepseek-v4.1-flash-free";
const catalog = [
  { id: "orcarouter/free", supported_endpoint_types: ["openai", "anthropic"] },
  { id: freeModel, name: "DeepSeek V4.1 Flash (Free)", supported_endpoint_types: null,
    pricing: { prompt: "0.0000000000", completion: "0.0000000000" } },
  { id: "z-ai/glm-5.3-flash-free", pricing: { request: "0.000000" } },
  { id: "deepseek/deepseek-v4.1-flash", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
];
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const validationRequest = () => new Request("http://localhost/api/providers/validate", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "orcarouter", apiKey: "sk-orca-test" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  mocks.resolveProxy.mockResolvedValue({});
  mocks.getConnection.mockResolvedValue({
    id: "orca-connection", provider: "orcarouter", authType: "apikey",
    apiKey: "sk-orca-test", providerSpecificData: {},
  });
  mocks.updateConnection.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("OrcaRouter free tier", () => {
  it("is visible in Free Tier and preserves vendor-qualified IDs through both prefixes", () => {
    expect(FREE_TIER_PROVIDERS.orcarouter).toMatchObject({ authType: "apikey", hasFree: true });
    expect(resolveProviderId("orca")).toBe("orcarouter");
    for (const prefix of ["orcarouter", "orca"]) {
      expect(parseModel(`${prefix}/${freeModel}`)).toMatchObject({ provider: "orcarouter", model: freeModel });
      expect(parseModel(`${prefix}/orcarouter/free`)).toMatchObject({ provider: "orcarouter", model: "orcarouter/free" });
    }
    expect(PROVIDERS.orcarouter.validateUrl).toBe(modelsUrl);
    expect(PROVIDER_MODELS.orcarouter).toHaveLength(7);
    expect(PROVIDER_MODELS.orcarouter.every((m) => m.id === "orcarouter/free" || m.id.endsWith("-free"))).toBe(true);
  });

  it("keeps the free catalog stubs despite their null endpoint list", () => {
    const normalized = FILTERS[orcarouter.modelsFetcher.type](catalog);
    expect(normalized.map((m) => m.id)).toEqual(["orcarouter/free", freeModel, "z-ai/glm-5.3-flash-free"]);
    expect(normalized[1].name).toBe("DeepSeek V4.1 Flash (Free)");
  });

  it("excludes paid, unpriced, malformed and non-chat entries even if named free", () => {
    expect(normalizeOrcaRouterFreeModels([
      null, {}, { id: 1 }, { id: "vendor/unpriced-free" },
      { id: "vendor/paid-free", pricing: { request: "0", prompt: "0.1", completion: "0" } },
      { id: "vendor/blank-free", pricing: { request: "" } },
      { id: "vendor/boolean-free", pricing: { request: false } },
      { id: "vendor/invalid-free", pricing: { request: "unknown" } },
      { id: "vendor/image-free", pricing: { request: "0" }, supported_endpoint_types: ["image"] },
    ])).toEqual([]);
  });

  it("does not assign paid family prices to free calls or zero prices to paid models", () => {
    for (const model of orcarouter.models) {
      expect(getPricingForModel("orcarouter", model.id)).toEqual(ZERO_PRICING);
    }
    expect(getPricingForModel("orca", freeModel)).toEqual(ZERO_PRICING);
    expect(getPricingForModel("orcarouter", "deepseek/deepseek-v4.1-flash")?.input).toBeGreaterThan(0);
    expect(getPricingForModel("openrouter", freeModel)).not.toEqual(ZERO_PRICING);
  });

  it("sends an authenticated streaming chat/tool request through DefaultExecutor", async () => {
    const executor = getExecutor("orcarouter");
    expect(executor).toBeInstanceOf(DefaultExecutor);
    const sse = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n';
    mocks.proxyFetch.mockResolvedValue(new Response(sse, { headers: { "Content-Type": "text/event-stream" } }));
    const body = { model: freeModel, stream: true, messages: [{ role: "user", content: "ping" }],
      tools: [{ type: "function", function: { name: "ping", parameters: { type: "object", properties: {} } } }] };
    const result = await executor.execute({ model: freeModel, body, stream: true,
      credentials: { apiKey: "sk-orca-test" }, proxyOptions: { connectionProxyEnabled: false } });
    const [url, options, proxy] = mocks.proxyFetch.mock.calls[0];
    expect(url).toBe("https://api.orcarouter.ai/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer sk-orca-test");
    expect(JSON.parse(options.body)).toMatchObject(body);
    expect(proxy).toEqual({ connectionProxyEnabled: false });
    expect(await result.response.text()).toBe(sse);
  });
});

describe("OrcaRouter dashboard routes", () => {
  it.each([200, 401, 403, 503])("validates a key using the authenticated catalog (HTTP %s)", async (status) => {
    fetch.mockResolvedValue(jsonResponse({}, status));
    const response = await validateProvider(validationRequest());
    expect((await response.json()).valid).toBe(status === 200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(modelsUrl, expect.objectContaining({
      headers: { Authorization: "Bearer sk-orca-test" },
    }));
  });

  it.each([200, 401])("supports the saved connection Test button (HTTP %s)", async (status) => {
    fetch.mockResolvedValue(jsonResponse({}, status));
    const result = await testSingleConnection("orca-connection");
    expect(result.valid).toBe(status === 200);
    expect(fetch).toHaveBeenCalledWith(modelsUrl, expect.objectContaining({
      headers: { Authorization: "Bearer sk-orca-test" },
    }));
    expect(mocks.updateConnection).toHaveBeenCalledWith("orca-connection", expect.objectContaining({
      testStatus: status === 200 ? "active" : "error",
    }));
  });

  it("uses the configured proxy for connection testing", async () => {
    mocks.resolveProxy.mockResolvedValue({ proxyRequired: true });
    mocks.proxyFetch.mockResolvedValue(jsonResponse({}));
    expect((await testSingleConnection("orca-connection")).valid).toBe(true);
    expect(mocks.proxyFetch).toHaveBeenCalledWith(modelsUrl, expect.objectContaining({
      headers: { Authorization: "Bearer sk-orca-test" },
    }), { proxyRequired: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discovers only free models with IDs that route back to OrcaRouter", async () => {
    fetch.mockResolvedValue(jsonResponse({ data: catalog }));
    const response = await listModels(new Request("http://localhost/api/providers/orca-connection/models"), {
      params: Promise.resolve({ id: "orca-connection" }),
    });
    const payload = await response.json();
    expect(payload.models).toHaveLength(3);
    for (const model of payload.models) {
      expect(parseModel(model.id)).toMatchObject({ provider: "orcarouter", model: model.upstreamModelId });
    }
    expect(fetch).toHaveBeenCalledWith(modelsUrl, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-orca-test" }),
    }));
  });

  it("fetches public free suggestions without an Authorization header", async () => {
    fetch.mockResolvedValue(jsonResponse({ data: catalog }));
    const request = new Request(`http://localhost/api/providers/suggested-models?${new URLSearchParams(orcarouter.modelsFetcher)}`);
    const response = await suggestModels(request);
    expect((await response.json()).data.map((m) => m.id)).toEqual(["orcarouter/free", freeModel, "z-ai/glm-5.3-flash-free"]);
    expect(fetch).toHaveBeenCalledWith(modelsUrl);
  });
});
