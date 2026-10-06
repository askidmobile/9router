import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_COPILOT } from "../../open-sse/config/appConstants.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), refresh: vi.fn(), update: vi.fn(), getConnection: vi.fn(), proxy: vi.fn(),
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("open-sse/services/tokenRefresh.js", async original => ({ ...await original(), refreshCopilotToken: mocks.refresh }));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getConnection }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) } }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: mocks.update, refreshCodexToken: vi.fn(), refreshGoogleToken: vi.fn() }));
const { clearCopilotModelCache, parseCopilotModels, resolveCopilotModels } = await import("open-sse/services/copilotModels.js");
const { GET } = await import("@/app/api/providers/[id]/models/route.js");
const model = (id, state, extra = {}) => ({ id, name: id, capabilities: { type: "chat" }, model_picker_enabled: true, ...(state ? { policy: { state } } : {}), ...extra });
const page = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const request = (query = "") => GET(new Request("http://localhost/api/providers/gh-test/models" + query), { params: Promise.resolve({ id: "gh-test" }) });
let connection;
beforeEach(() => {
  vi.clearAllMocks(); clearCopilotModelCache();
  connection = { id: "gh-test", provider: "github", accessToken: "github-oauth", providerSpecificData: { copilotToken: "old-copilot", prefix: "gh", keepMe: true } };
  mocks.getConnection.mockImplementation(async () => connection);
  mocks.fetch.mockResolvedValue(page({ data: [] }));
  mocks.refresh.mockResolvedValue(null); mocks.update.mockResolvedValue(true);
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid", strictProxy: true });
});
afterEach(() => vi.useRealTimers());

describe("Copilot account model import", () => {
  it("shows disabled public models with account restrictions, omitting internal and embedding entries", async () => {
    mocks.fetch.mockResolvedValue(page({ data: [
      model("gpt-6-sol", "disabled"), model("claude-opus-5.5", "disabled"),
      model("gpt-6-luna", "enabled"), model("grok-4.7"),
      model("copilot-search-a", undefined, { model_picker_enabled: false }),
      model("embedding", undefined, { capabilities: { type: "embeddings" } }),
    ] }));
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.body.models).toEqual([
      { id: "gpt-6-sol", name: "gpt-6-sol", available: false, policyState: "disabled" },
      { id: "claude-opus-5.5", name: "claude-opus-5.5", available: false, policyState: "disabled" },
      { id: "gpt-6-luna", name: "gpt-6-luna", available: true, policyState: "enabled" },
      { id: "grok-4.7", name: "grok-4.7", available: true },
    ]);
    expect(result.body.warning).toContain("GitHub has disabled access");
    expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
    const [url, options, proxy] = mocks.fetch.mock.calls[0];
    expect(url).toBe(GITHUB_COPILOT.MODELS_URL);
    expect(options.headers.Authorization).toBe("Bearer old-copilot");
    expect(options.headers["editor-plugin-version"]).toBe(`copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`);
    expect(options.headers["editor-version"]).toBe(`vscode/${GITHUB_COPILOT.VSCODE_VERSION}`);
    expect(options.cache).toBe("no-store"); expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(proxy.strictProxy).toBe(true);
  });

  it("keeps denied models out of default discovery even after import populates the cache", async () => {
    mocks.fetch.mockResolvedValue(page({ data: [model("blocked", "disabled"), model("allowed", "enabled")] }));
    await request();
    expect(await resolveCopilotModels(connection)).toEqual({ models: [{ id: "allowed", name: "allowed" }] });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("reopens with fresh policy and new model IDs without a static allowlist", async () => {
    mocks.fetch.mockResolvedValueOnce(page({ data: [model("gpt-future", "disabled")] }))
      .mockResolvedValueOnce(page({ data: [model("gpt-future", "enabled"), model("gpt-future-2", "enabled")] }));
    expect((await request()).body.models[0].available).toBe(false);
    const second = (await request()).body;
    expect(second.models.map(m => m.id)).toEqual(["gpt-future", "gpt-future-2"]);
    expect(second.models.every(m => m.available)).toBe(true);
    expect(second.warning).toBeUndefined(); expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired token and preserves provider data before the retry", async () => {
    const events = [];
    mocks.fetch.mockImplementation(async (_, options) => {
      events.push(options.headers.Authorization);
      return options.headers.Authorization === "Bearer old-copilot" ? new Response("private token", { status: 401 }) : page({ data: [model("new", "enabled")] });
    });
    mocks.refresh.mockResolvedValue({ token: "fresh-copilot", expiresAt: 1900000000 });
    mocks.update.mockImplementation(async () => { events.push("persisted"); return true; });
    expect((await request()).status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledWith("github-oauth");
    expect(mocks.update).toHaveBeenCalledWith("gh-test", { copilotToken: "fresh-copilot", copilotTokenExpiresAt: 1900000000, existingProviderSpecificData: connection.providerSpecificData });
    expect(events).toEqual(["Bearer old-copilot", "persisted", "Bearer fresh-copilot"]);
  });

  it("keeps refreshed credentials when retry fails and redacts error bodies", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("private token", { status: 401 })).mockResolvedValueOnce(new Response("private token", { status: 503 }));
    mocks.refresh.mockResolvedValue({ token: "fresh-copilot", expiresAt: 1900000000 });
    expect(await request()).toEqual({ status: 503, body: { error: "Failed to fetch Copilot models: 503" } });
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("does not retry when refreshed credentials cannot be saved", async () => {
    mocks.fetch.mockResolvedValue(new Response("private token", { status: 401 }));
    mocks.refresh.mockResolvedValue({ token: "fresh-copilot" }); mocks.update.mockResolvedValue(false);
    expect((await request()).status).toBe(502); expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("does not refresh permission denials", async () => {
    mocks.fetch.mockResolvedValue(new Response("private token", { status: 403 }));
    expect(await request()).toEqual({ status: 403, body: { error: "Failed to fetch Copilot models: 403" } });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reports refresh failure without losing the 401 status", async () => {
    mocks.fetch.mockResolvedValue(new Response("private token", { status: 401 }));
    expect((await request()).status).toBe(401); expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("probes support without an upstream call and reports missing credentials", async () => {
    expect((await request("?check=1")).body.supported).toBe(true);
    connection.accessToken = null; connection.providerSpecificData = {};
    expect((await request()).status).toBe(401); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("handles empty catalogs and rejects invalid shapes", async () => {
    expect((await request()).body.models).toEqual([]);
    mocks.fetch.mockResolvedValue(page({ data: {} }));
    expect((await request()).status).toBe(502);
    mocks.fetch.mockRejectedValue(new Error("private token and email"));
    expect(await request()).toEqual({ status: 502, body: { error: "Failed to fetch Copilot models" } });
  });

  it("honors caller cancellation alongside its own bounded timeout", async () => {
    const caller = new AbortController();
    mocks.fetch.mockImplementation((_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const result = resolveCopilotModels(connection, { signal: caller.signal });
    caller.abort(); expect((await result).status).toBe(504);
  });

  it("also aborts stalled response bodies", async () => {
    mocks.fetch.mockImplementation(async (_, { signal }) => new Response(new ReadableStream({ start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    } })));
    expect(await request()).toEqual({ status: 504, body: { error: "Copilot models request timed out" } });
  }, 15000);

  it("isolates catalogs by account and expires the default cache", async () => {
    mocks.fetch.mockImplementation(async (_, options) => page({ data: [model(options.headers.Authorization, "enabled")] }));
    const second = { ...connection, providerSpecificData: { copilotToken: "another-account" } };
    expect((await resolveCopilotModels(connection)).models[0].id).toBe("Bearer old-copilot");
    expect((await resolveCopilotModels(second)).models[0].id).toBe("Bearer another-account");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + GITHUB_COPILOT.MODELS_CACHE_TTL_MS + 1);
    await resolveCopilotModels(connection); expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("Copilot catalog normalization", () => {
  it("accepts legacy chat entries without picker or policy flags; ignores hidden, malformed and duplicate entries", () => {
    expect(parseCopilotModels({ data: [null, {}, model("public", "enabled"), model("public", "disabled"), model("hidden", "enabled", { model_picker_enabled: false }), model("internal", "enabled", { isInternal: true }), model(" "), model(23), { id: "legacy", capabilities: { type: "chat" } }] })).toEqual([
      { id: "public", name: "public", available: true, policyState: "enabled" }, { id: "legacy", name: "legacy", available: true },
    ]);
  });
  it("does not treat an unknown policy state as access", () => {
    const models = parseCopilotModels({ data: [model("new", "unconfigured"), model("incomplete", undefined, { policy: {} })] });
    expect(models.every(model => !model.available)).toBe(true);
  });
});
