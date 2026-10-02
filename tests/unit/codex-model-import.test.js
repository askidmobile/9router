import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import codex from "../../open-sse/providers/registry/codex.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const mocks = vi.hoisted(() => ({ connection: vi.fn(), refresh: vi.fn(), persist: vi.fn() }));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.connection }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshCodexToken: mocks.refresh, updateProviderCredentials: mocks.persist, refreshGoogleToken: vi.fn(),
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ body, status: init?.status || 200 }) } }));
const { GET } = await import("@/app/api/providers/[id]/models/route.js");
const request = (check = "") => GET(new Request(`http://localhost/api/providers/codex-fixture/models${check}`), { params: Promise.resolve({ id: "codex-fixture" }) });
const page = models => new Response(JSON.stringify({ models }), { headers: { "content-type": "application/json" } });
let fetchMock;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connection.mockResolvedValue({ id: "codex-fixture", provider: "codex", accessToken: "fixture-access", refreshToken: "fixture-refresh" });
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Codex account model import", () => {
  it("uses the inference client identity so version-gated models are returned", async () => {
    fetchMock.mockImplementation(async url => {
      const version = new URL(url).searchParams.get("client_version");
      return page(version === codex.transport.cliVersion ? [{ slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol" }] : []);
    });
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.body.models.map(m => m.id)).toContain("gpt-6.1-sol");
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("client_version")).toBe(codex.transport.cliVersion);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer fixture-access");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("imports account models absent from the static registry without manual configuration", async () => {
    const id = "gpt-fixture-future-sol";
    expect(codex.models.some(m => m.id === id)).toBe(false);
    fetchMock.mockResolvedValue(page([{ slug: id, display_name: "Future Sol", context_window: 272000 }]));
    const result = await request();
    expect(result.body.models).toEqual([
      expect.objectContaining({ id, name: "Future Sol", context_window: 272000 }),
      expect.objectContaining({ id: `${id}-review`, upstreamModelId: id, quotaFamily: "review" }),
    ]);
  });

  it("fetches a fresh catalog on each import instead of freezing the first result", async () => {
    fetchMock.mockResolvedValueOnce(page([{ slug: "gpt-5.5" }]))
      .mockResolvedValueOnce(page([{ slug: "gpt-6.1-sol" }, { slug: "gpt-fixture-new" }]));
    await request();
    expect((await request()).body.models.map(m => m.id)).toContain("gpt-fixture-new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("persists a rotated token and retries the account catalog after a 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(page([{ slug: "gpt-fixture-new" }]));
    mocks.refresh.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
    expect((await request()).body.models.map(m => m.id)).toContain("gpt-fixture-new");
    expect(mocks.persist).toHaveBeenCalledWith("codex-fixture", { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer new-access");
  });

  it("probes import support without sending credentials upstream", async () => {
    expect((await request("?check=1")).body.supported).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps native gateway windows on review and Kiro virtual variants", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6.1-sol").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("codex", "gpt-6.1-sol-review").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("codex", "gpt-6-sol[1m]-review").contextWindow).toBe(872000);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-luna-thinking-agentic").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("openai", "gpt-6.1-sol").contextWindow).toBe(1050000);
  });
});
