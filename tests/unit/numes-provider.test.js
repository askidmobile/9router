import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { parseModel } from "../../open-sse/services/model.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { GET as listModels } from "../../src/app/api/providers/[id]/models/route.js";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";
import { POST as validate } from "../../src/app/api/providers/validate/route.js";
import { resolveProviderCatalog } from "../../src/lib/providerCatalog/import.js";
import { catalogMetadata } from "../../src/lib/providerCatalog/metadata.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { normalizeProviderImportModels } from "../../src/shared/utils/providerImportModels.js";

const { connection } = vi.hoisted(() => ({
  connection: { id: "numes-fixture", provider: "numes", authType: "apikey", apiKey: "test-key" },
}));
vi.mock("@/models", () => ({ getProviderConnectionById: async () => connection }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: async () => connection, updateProviderConnection: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({ getPricing: async () => ({ numes: { "openai/gpt-6-luna": { input: 2, output: 4 } } }) }));
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}), trackPendingRequest: vi.fn(),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", async original => ({ ...await original(), proxyAwareFetch: vi.fn() }));

const base = "https://api.numes.ai/api/v1";
const catalogUrl = `${base}/models?output_modalities=text`;
const upstreamId = "openai/gpt-6-luna";
const model = {
  id: upstreamId, name: "GPT-6 Luna", billing_currency: "USD", context_length: 1047576, maximum_output_length: 32768,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["tools"], pricing: { prompt: "0.0000001", completion: "0.0000004" },
};

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => vi.unstubAllGlobals());

it.each([200, 401])("checks new and saved keys without calling inference (HTTP %i)", async status => {
  expect(APIKEY_PROVIDERS.numes?.name).toBe("Numes");
  fetch.mockImplementation(async () => Response.json({}, { status }));
  const result = await validate(new Request("http://localhost/api/providers/validate", {
    method: "POST", body: JSON.stringify({ provider: "numes", apiKey: connection.apiKey }),
  }));
  expect((await result.json()).valid).toBe(status === 200);
  expect((await testSingleConnection(connection.id)).valid).toBe(status === 200);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url, options] of fetch.mock.calls) {
    expect(url).toBe(catalogUrl);
    expect(options.method ?? "GET").toBe("GET");
    expect(options.headers.Authorization).toBe("Bearer test-key");
  }
});

it.each(["USD", "BTC", undefined])("routes live chat IDs and imports only USD rates (currency %s)", async currency => {
  fetch.mockImplementation(async () => Response.json({ data: [{ ...model, billing_currency: currency }] }));
  const response = await listModels(new Request(`http://localhost/api/providers/${connection.id}/models`), {
    params: Promise.resolve({ id: connection.id }),
  });
  const { models } = await response.json();
  expect(models[0].id).toBe(`numes/${upstreamId}`);
  expect(normalizeProviderImportModels(models)[0].id).toBe(upstreamId);
  const catalog = await resolveProviderCatalog(connection);
  const metadata = catalogMetadata(catalog.models[0]);
  expect(metadata).toMatchObject({
    id: upstreamId,
    caps: { contextWindow: 1047576, maxOutput: 32768, vision: true, tools: true },
  });
  if (currency === "USD") {
    expect(metadata.pricing.input).toBeCloseTo(0.1);
    expect(metadata.pricing.output).toBeCloseTo(0.4);
  } else {
    expect(metadata.pricing).toBeNull();
  }
  for (const [url, options] of fetch.mock.calls) {
    expect(url).toBe(catalogUrl);
    expect(options.headers.Authorization).toBe("Bearer test-key");
  }
});

it.each([false, true])("runs chat through the default executor without treating satoshis as USD (stream=%s)", async stream => {
  const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, cost: 12, cost_details: { upstream_inference_cost: 12 } };
  const chunk = { id: "fixture", object: "chat.completion.chunk", model: upstreamId };
  const message = { role: "assistant", content: "Hello" };
  const upstream = stream ? new Response([
    { ...chunk, choices: [{ index: 0, delta: message, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...chunk, choices: [], usage },
    "[DONE]",
  ].map(frame => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } })
    : Response.json({ id: "fixture", object: "chat.completion", model: upstreamId, choices: [{ index: 0, message, finish_reason: "stop" }], usage });
  proxyAwareFetch.mockResolvedValueOnce(upstream);
  const routedId = `numes/${upstreamId}`;
  const result = await handleChatCore({
    body: { model: routedId, messages: [{ role: "user", content: "Hello" }], stream, reasoning_effort: "high" },
    modelInfo: parseModel(routedId),
    credentials: { apiKey: connection.apiKey },
  });

  expect(result.success).toBe(true);
  const [url, options] = proxyAwareFetch.mock.calls[0];
  expect(url).toBe(`${base}/chat/completions`);
  expect(options.headers.Authorization).toBe("Bearer test-key");
  expect(JSON.parse(options.body)).toMatchObject({ model: upstreamId, stream, reasoning_effort: "high" });
  const output = await result.response.text();
  const final = stream ? output.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(event => event.usage)
    : JSON.parse(output);
  expect(output).toContain("Hello");
  expect(final.usage).toMatchObject({ cost: null, cost_details: { source: "unavailable" } });
  expect(result.response.headers.has("x-9router-cost")).toBe(false);
});
