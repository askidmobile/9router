import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGeminiModels } from "@/lib/providerModels/geminiModels.js";
import gemini from "../../open-sse/providers/registry/gemini.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const mocks = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getConnection }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) } }));
const { GET } = await import("@/app/api/providers/[id]/models/route.js");

const connection = { id: "studio-test", provider: "gemini", apiKey: "test-api-key" };
let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mocks.getConnection.mockResolvedValue(connection);
});
afterEach(() => vi.unstubAllGlobals());
const page = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

describe("AI Studio model import", () => {
  it("uses canonical IDs, display names and every page through the real catalog route", async () => {
    fetchMock.mockResolvedValueOnce(page({
      models: [{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576 }],
      nextPageToken: "second+/page=",
    })).mockResolvedValueOnce(page({ models: [
      { name: "models/gemini-2.5-flash" },
      { name: "/models/gemma-4-31b-it", displayName: "Gemma 4 31B" },
      { name: "models/" }, null,
    ] }));
    const response = await GET(new Request("http://localhost/api/providers/studio-test/models"), { params: Promise.resolve({ id: connection.id }) });
    expect(response.status).toBe(200);
    expect(response.body.models.map((m) => m.id)).toEqual(["gemini-2.5-flash", "gemini-2.5-flash:flex", "gemma-4-31b-it"]);
    expect(response.body.models[0]).toMatchObject({ name: "Gemini 2.5 Flash", inputTokenLimit: 1048576 });
    expect(response.body.models[1].name).toBe("Gemini 2.5 Flash (Flex)");
    const [firstUrl, options] = fetchMock.mock.calls[0];
    expect(new URL(firstUrl).searchParams.get("pageSize")).toBe("1000");
    expect(firstUrl).not.toContain(connection.apiKey);
    expect(options.headers["x-goog-api-key"]).toBe(connection.apiKey);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("pageToken")).toBe("second+/page=");
  });

  it("probes support without a Google request", async () => {
    const response = await GET(new Request("http://localhost/api/providers/studio-test/models?check=1"), { params: Promise.resolve({ id: connection.id }) });
    expect(response.body.supported).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a failed later page instead of importing an incomplete list", async () => {
    fetchMock.mockResolvedValueOnce(page({ models: [{ name: "models/first" }], nextPageToken: "more" }))
      .mockResolvedValueOnce(new Response("secret upstream details", { status: 403 }));
    const result = await resolveGeminiModels(connection);
    expect(result).toEqual({ error: "Failed to fetch AI Studio models: 403", status: 403 });
  });

  it("bounds broken pagination and rejects malformed responses", async () => {
    fetchMock.mockImplementation(async () => page({ models: [], nextPageToken: "same" }));
    expect((await resolveGeminiModels(connection)).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValue(page({ invalid: [] }));
    expect((await resolveGeminiModels(connection)).status).toBe(502);
  });

  it("requires a key and redacts network errors", async () => {
    expect((await resolveGeminiModels({})).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValue(new Error("failure with secret test-api-key"));
    expect(await resolveGeminiModels(connection)).toEqual({ error: "Failed to fetch AI Studio models", status: 502 });
  });

  it("renames the provider without changing its routing identity and offers valid Flex variants", () => {
    expect(gemini.display.name).toBe("Google AI Studio");
    expect(gemini.id).toBe("gemini");
    expect(gemini.alias).toBe("gemini");
    const ids = gemini.models.filter((m) => !m.kind).map((m) => m.id);
    expect(ids).toContain("gemini-3.8-flash");
    expect(ids).toContain("gemini-3.8-flash:flex");
    expect(ids).not.toContain("gemma-4-31b-it:flex");
    expect(new Set(ids).size).toBe(ids.length);
    expect(getModelUpstreamId("gemini", "/models/gemini-3.8-flash:flex(high)")).toBe("gemini-3.8-flash(high)");
    expect(getModelUpstreamId("openrouter", "models/example:flex")).toBe("models/example:flex");
    expect(getCapabilitiesForModel("gemini", "gemini-3.8-flash:flex")).toEqual(getCapabilitiesForModel("gemini", "gemini-3.8-flash"));
  });
});
