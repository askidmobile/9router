import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_VERSION } from "../../open-sse/providers/shared.js";
import { parseAntigravityModels } from "../../open-sse/services/antigravityModels.js";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(), fetch: vi.fn(), refresh: vi.fn(), update: vi.fn(), proxy: vi.fn(),
}));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getConnection }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) } }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: mocks.refresh, updateProviderCredentials: mocks.update, refreshCodexToken: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
const { GET } = await import("@/app/api/providers/[id]/models/route.js");
const page = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const request = (query = "") => GET(new Request("http://localhost/api/providers/ag-test/models" + query), { params: Promise.resolve({ id: "ag-test" }) });
const modelsUrl = antigravity.transport.usage.quotaApiUrl;
let connection;
beforeEach(() => {
  vi.clearAllMocks();
  connection = { id: "ag-test", provider: "antigravity", accessToken: "old-token", refreshToken: "refresh-token", projectId: { id: "stored-project" } };
  mocks.getConnection.mockResolvedValue(connection);
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid", strictProxy: true });
  mocks.fetch.mockImplementation(async url => url === modelsUrl ? page({ models: {} }) : page({ cloudaicompanionProject: { id: "live-project" } }));
  mocks.refresh.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe("Antigravity model import", () => {
  it("imports all six live Claude variants through the API and keeps effort routing", async () => {
    const models = {};
    for (const family of ["sonnet", "opus"]) for (const effort of ["low", "medium", "high"]) {
      models[`claude-${family}-5-5-${effort}`] = { displayName: `Claude ${family} 5.5 (${effort})`, maxTokens: 1000000, quotaInfo: { remainingFraction: 1 } };
    }
    models.hidden = { isInternal: true };
    mocks.fetch.mockImplementation(async url => url === modelsUrl ? page({ models }) : page({ cloudaicompanionProject: { id: "live-project" } }));
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.body.models).toHaveLength(6);
    expect(result.body.models.find(m => m.id === "claude-sonnet-5-5-medium")).toEqual({
      id: "claude-sonnet-5-5-medium", name: "Claude sonnet 5.5 (medium)",
      upstreamModelId: "claude-sonnet-5-5-medium(medium)", contextWindow: 1000000,
    });
    for (const [url, options, proxy] of mocks.fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/(?:daily-)?cloudcode-pa\.googleapis\.com\//);
      expect(url).not.toContain("sandbox");
      expect(options.headers.Authorization).toBe("Bearer old-token");
      expect(options.headers["User-Agent"]).toBe(ANTIGRAVITY_IDE_USER_AGENT);
      expect(options.cache).toBe("no-store");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(proxy.strictProxy).toBe(true);
    }
    const [, options] = mocks.fetch.mock.calls.find(([url]) => url === modelsUrl);
    expect(options.headers["X-Client-Version"]).toBe(ANTIGRAVITY_IDE_VERSION);
    expect(JSON.parse(options.body)).toEqual({ project: "live-project" });
  });

  it("reads a fresh catalog and accepts new IDs without a static allowlist", async () => {
    let id = "claude-future-v1";
    mocks.fetch.mockImplementation(async url => url === modelsUrl ? page({ models: { [id]: { displayName: id } } }) : page({}));
    expect((await request()).body.models.map(m => m.id)).toEqual(["claude-future-v1"]);
    id = "claude-future-v2";
    expect((await request()).body.models.map(m => m.id)).toEqual(["claude-future-v2"]);
    expect(mocks.fetch.mock.calls.filter(([url]) => url === modelsUrl)).toHaveLength(2);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({ project: "stored-project" });
  });

  it("refreshes a 401 with the Antigravity client and persists before retry", async () => {
    const events = [];
    mocks.fetch.mockImplementation(async (url, options) => {
      if (url !== modelsUrl) return page({});
      events.push(options.headers.Authorization);
      return options.headers.Authorization === "Bearer old-token" ? new Response("private error", { status: 401 }) : page({ models: { new: { displayName: "New" } } });
    });
    mocks.refresh.mockResolvedValue({ accessToken: "fresh-token", refreshToken: "fresh-refresh", expiresIn: 3600 });
    mocks.update.mockImplementation(async () => events.push("persisted"));
    expect((await request()).status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledWith("refresh-token", antigravity.transport.clientId, antigravity.transport.clientSecret);
    expect(mocks.update).toHaveBeenCalledWith("ag-test", { accessToken: "fresh-token", refreshToken: "fresh-refresh", expiresIn: 3600 });
    expect(events).toEqual(["Bearer old-token", "persisted", "Bearer fresh-token"]);
  });

  it("retains refreshed credentials even if the second catalog request fails", async () => {
    let catalogs = 0;
    mocks.fetch.mockImplementation(async url => url === modelsUrl ? new Response("private error", { status: ++catalogs === 1 ? 401 : 503 }) : page({}));
    mocks.refresh.mockResolvedValue({ accessToken: "fresh-token", expiresIn: 3600 });
    const result = await request();
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "Failed to fetch Antigravity models: 503" });
    expect(mocks.update).toHaveBeenCalledWith("ag-test", { accessToken: "fresh-token", refreshToken: "refresh-token", expiresIn: 3600 });
    expect(catalogs).toBe(2);
  });

  it("does not refresh a permission denial or expose upstream error details", async () => {
    mocks.fetch.mockImplementation(async url => url === modelsUrl ? new Response("private token/email", { status: 403 }) : page({}));
    const result = await request();
    expect(result).toEqual({ status: 403, body: { error: "Failed to fetch Antigravity models: 403" } });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reports missing credentials and probes support without making Google requests", async () => {
    expect((await request("?check=1")).body.supported).toBe(true);
    connection.accessToken = "";
    expect((await request()).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed catalog and redacts network failures", async () => {
    mocks.fetch.mockImplementation(async url => url === modelsUrl ? page({ invalid: [] }) : page({}));
    expect((await request()).status).toBe(502);
    mocks.fetch.mockRejectedValue(new Error("private token/email"));
    expect(await request()).toEqual({ status: 502, body: { error: "Failed to fetch Antigravity models" } });
  });

  it("reports a bounded catalog timeout", async () => {
    mocks.fetch.mockRejectedValue(new DOMException("request timeout", "AbortError"));
    expect(await request()).toEqual({ status: 504, body: { error: "Antigravity models request timed out" } });
  });

  it("also aborts a stalled response body after receiving HTTP headers", async () => {
    mocks.fetch.mockImplementation(async (url, options) => url !== modelsUrl ? page({}) : new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
      },
    })));
    expect(await request()).toEqual({ status: 504, body: { error: "Antigravity models request timed out" } });
  }, 15000);

  it("normalizes arrays, deduplicates and omits per-account quota metadata", () => {
    expect(parseAntigravityModels({ models: [null, {}, { id: "new", displayName: "New", quotaInfo: { remainingFraction: 0.5 } }, { id: "new" }, { id: "internal", isInternal: true }] })).toEqual([{ id: "new", name: "New" }]);
  });
});
