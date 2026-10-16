import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNode: vi.fn(),
  getConnection: vi.fn(),
  updateConnection: vi.fn(),
  resolveProxy: vi.fn(),
  proxyFetch: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: Response.json } }));
vi.mock("@/models", () => ({ getProviderNodeById: mocks.getNode }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getConnection,
  updateProviderConnection: mocks.updateConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.resolveProxy }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyFetch }));

import { POST as validate } from "../../src/app/api/providers/validate/route.js";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";

let connection;
let fetchMock;

beforeEach(() => {
  vi.resetAllMocks();
  connection = { id: "anthropic-test", provider: "anthropic", authType: "apikey", apiKey: "test-key" };
  mocks.getConnection.mockImplementation(async () => connection);
  mocks.getNode.mockImplementation(async () => ({
    baseUrl: connection.providerSpecificData.baseUrl,
    defaultModel: connection.defaultModel,
  }));
  mocks.resolveProxy.mockResolvedValue({ connectionProxyEnabled: false });
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe.each(["validate", "saved"])("Anthropic %s connection probe", (entry) => {
  async function probe() {
    if (entry === "saved") return testSingleConnection(connection.id);
    const response = await validate(new Request("https://9router.test/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: connection.provider, apiKey: connection.apiKey }),
    }));
    return response.json();
  }

  it("checks credentials via Models API without invoking any model", async () => {
    connection.defaultModel = "claude-3-haiku-20240307";

    expect(await probe()).toMatchObject({ valid: true, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(options.method || "GET").toBe("GET");
    expect(options).not.toHaveProperty("body");
    expect(options.headers).toMatchObject({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    if (entry === "saved") {
      expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, {
        testStatus: "active", lastError: null, lastErrorAt: null,
      });
    }
  });

  it.each([401, 403, 404, 429, 500])("does not report HTTP %s as a valid connection", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status }));
    expect(await probe()).toMatchObject({ valid: false });
    if (entry === "saved") {
      expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({ testStatus: "error" }));
    }
  });

  it("reports network failure without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch connect timeout"));
    expect(await probe()).toMatchObject({ valid: false, error: "fetch connect timeout" });
  });

  it.each([undefined, "gateway-custom-model"])("uses a supported fallback or the configured compatible model: %s", async (defaultModel) => {
    connection.provider = "anthropic-compatible-test";
    connection.providerSpecificData = { baseUrl: "https://gateway.test" };
    connection.defaultModel = defaultModel;

    expect(await probe()).toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gateway.test/v1/messages");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      model: defaultModel || "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "test" }],
    });
  });
});

it("keeps saved Anthropic probes on the configured proxy with a timeout", async () => {
  const proxy = { vercelRelayUrl: "https://relay.test", connectionProxyEnabled: false };
  mocks.resolveProxy.mockResolvedValue(proxy);
  mocks.proxyFetch.mockResolvedValue(new Response("{}", { status: 200 }));

  expect(await testSingleConnection(connection.id)).toMatchObject({ valid: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocks.proxyFetch).toHaveBeenCalledExactlyOnceWith("https://api.anthropic.com/v1/models", expect.objectContaining({
    headers: { "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
    signal: expect.any(AbortSignal),
  }), proxy);
});
