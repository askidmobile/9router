import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: {}, pools: [], save: vi.fn() }));
vi.mock("@/models", () => ({ getProxyPoolById: async id => mocks.pools.find(pool => pool.id === id) || null }));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({ getSettings: async () => mocks.settings, updateProviderProxyPolicy: mocks.save }));
vi.mock("@/lib/db/repos/proxyPoolsRepo.js", () => ({ getProxyPools: async () => mocks.pools }));

const { resolveProviderProxyConfig } = await import("@/lib/network/connectionProxy.js");
const { GET, PATCH } = await import("@/app/api/settings/provider-proxy/[id]/route.js");
const policy = (override, id = "opencode") => { mocks.settings.providerStrategies = { ...mocks.settings.providerStrategies, [id]: override }; };
const patch = body => PATCH(new Request("http://localhost/api/settings/provider-proxy/opencode", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "opencode" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {};
  mocks.pools = [
    { id: "a", name: "a", proxyUrl: "http://1.1.1.1:80", isActive: true },
    { id: "b", name: "b", proxyUrl: "http://1.0.0.1:80", isActive: true },
    { id: "unselected", name: "new import", proxyUrl: "http://9.9.9.9:80", isActive: true },
  ];
});

describe("provider proxy policy", () => {
  it("defaults to direct even when active imported pools exist", async () => {
    expect(await resolveProviderProxyConfig("opencode")).toMatchObject({ connectionProxyEnabled: false, useEnvProxy: false, proxyRequired: false });
    const response = await GET(null, { params: Promise.resolve({ id: "opencode" }) });
    expect(await response.json()).toMatchObject({ proxyEnabled: false, proxyPoolIds: [], rotateStrategy: "none" });
  });

  it("never enables other providers when one provider opts in", async () => {
    policy({ proxyEnabled: true, proxyPoolIds: ["a"], rotateStrategy: "none" });
    expect(await resolveProviderProxyConfig("opencode")).toMatchObject({ proxyPoolId: "a", proxyRequired: true, strictProxy: true });
    expect(await resolveProviderProxyConfig("codex")).toMatchObject({ connectionProxyEnabled: false, proxyRequired: false });
  });

  it("rotates only over the explicit selection and ignores new imports", async () => {
    policy({ proxyEnabled: true, proxyPoolIds: ["a", "b"], rotateStrategy: "round-robin" }, "rotation-fixture");
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push((await resolveProviderProxyConfig("rotation-fixture")).proxyPoolId);
    expect(seen).toEqual(["a", "b", "a", "b"]);
  });

  it("keeps a fixed proxy fixed when it fails, without selecting another active pool", async () => {
    policy({ proxyEnabled: true, proxyPoolIds: ["a"], rotateStrategy: "none" });
    mocks.pools[0].isActive = false;
    expect(await resolveProviderProxyConfig("opencode")).toMatchObject({ proxyPoolId: "a", connectionProxyEnabled: false, proxyRequired: true, strictProxy: true, useEnvProxy: false });
  });

  it("fails closed when all selected proxies disappear", async () => {
    policy({ proxyEnabled: true, proxyPoolIds: ["deleted"], rotateStrategy: "random" });
    expect(await resolveProviderProxyConfig("opencode")).toMatchObject({ connectionProxyEnabled: false, proxyRequired: true });
  });

  it("ignores stale or failed health checks on auto-imported proxies", async () => {
    Object.assign(mocks.pools[0], { managedBy: "free-proxy-sync", testStatus: "active", lastTestedAt: new Date(Date.now() - 7200000).toISOString() });
    policy({ proxyEnabled: true, proxyPoolIds: ["a", "b"], rotateStrategy: "random" });
    expect((await resolveProviderProxyConfig("opencode")).proxyPoolId).toBe("b");
  });

  it("explicit off overrides legacy connection proxy settings", async () => {
    policy({ proxyEnabled: false });
    expect(await resolveProviderProxyConfig("opencode", { proxyPoolId: "a" })).toMatchObject({ connectionProxyEnabled: false, useEnvProxy: false });
  });

  it("preserves existing connection assignments on upgrade, with no direct fallback", async () => {
    expect(await resolveProviderProxyConfig("codex", { proxyPoolId: "a" })).toMatchObject({ proxyPoolId: "a", connectionProxyEnabled: true, proxyRequired: true, strictProxy: true });
  });

  it.each([
    { proxyEnabled: "true", proxyPoolIds: ["a"], rotateStrategy: "none" },
    { proxyEnabled: true, proxyPoolIds: [], rotateStrategy: "none" },
    { proxyEnabled: true, proxyPoolIds: ["a"], rotateStrategy: "random" },
    { proxyEnabled: true, proxyPoolIds: ["missing"], rotateStrategy: "none" },
    { proxyEnabled: true, proxyPoolIds: ["a"], rotateStrategy: "unknown" },
  ])("rejects an invalid or ambiguous policy: %j", async body => {
    expect((await patch(body)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves only the intended provider policy through an atomic partial update", async () => {
    const body = { proxyEnabled: true, proxyPoolIds: ["a"], rotateStrategy: "none", outboundProxyEnabled: true };
    expect((await patch(body)).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith("opencode", { proxyEnabled: true, proxyPoolIds: ["a"], rotateStrategy: "none" });
  });
});
