import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnections: vi.fn(), updateConnection: vi.fn(), listComboHealth: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getConnections,
  updateProviderConnection: mocks.updateConnection,
}));
vi.mock("open-sse/services/comboHealth.js", () => ({ listComboHealth: mocks.listComboHealth }));

const { GET, POST } = await import("../../src/app/api/models/availability/route.js");
const NOW = 1_800_000_000_000;
const circuit = {
  provider: "commandcode", model: "glm-5.3-flash", state: "open", failureCount: 2,
  nextProbeAt: NOW - 1000, lastStatus: 504, lastReason: "First response timeout",
  probeToken: "private-probe-token", leaseUntil: NOW + 30_000,
};

describe("availability API combo circuit contract", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    mocks.getConnections.mockResolvedValue([]);
    mocks.listComboHealth.mockResolvedValue([circuit]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("adds safe combo circuits without changing account lock records or their count", async () => {
    const until = new Date(NOW + 60_000).toISOString();
    mocks.getConnections.mockResolvedValue([{
      id: "account-1", provider: "commandcode", name: "Test account", lastError: "HTTP 429",
      "modelLock_glm-5.3-flash": until,
    }]);
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.models).toEqual([{
      provider: "commandcode", model: "glm-5.3-flash", status: "cooldown", until,
      connectionId: "account-1", connectionName: "Test account", lastError: "HTTP 429",
    }]);
    expect(body.unavailableCount).toBe(1);
    expect(body.comboCircuits).toEqual([expect.objectContaining({
      state: "open", nextProbeAt: NOW - 1000, failureCount: 2,
    })]);
    expect(JSON.stringify(body.comboCircuits)).not.toMatch(/private|probeToken|leaseUntil/);
  });

  it("does not let the legacy account cooldown reset reopen a combo circuit", async () => {
    mocks.getConnections.mockResolvedValue([{
      id: "account-1", provider: "commandcode", "modelLock_glm-5.3-flash": new Date(NOW + 60_000).toISOString(),
    }]);
    const response = await POST(new Request("http://router/api/models/availability", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clearCooldown", provider: "commandcode", model: "glm-5.3-flash" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateConnection).toHaveBeenCalledExactlyOnceWith("account-1", { "modelLock_glm-5.3-flash": null });
    expect((await (await GET()).json()).comboCircuits).toHaveLength(1);
  });

  it("returns a failed read instead of reporting frozen models healthy when state storage fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listComboHealth.mockRejectedValue(new Error("state storage unavailable"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to fetch model availability" });
  });
});
