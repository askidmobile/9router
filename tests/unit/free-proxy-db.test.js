import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let tempDir;
let pools;
let settings;
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-free-proxy-db-"));
  vi.stubEnv("DATA_DIR", tempDir);
  delete global._dbAdapter;
  vi.resetModules();
  pools = await import("@/lib/db/repos/proxyPoolsRepo.js");
  settings = await import("@/lib/db/repos/settingsRepo.js");
});
afterAll(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("proxy persistence", () => {
  it("keeps health provenance across database round trips", async () => {
    const created = await pools.createProxyPool({ name: "fixture", proxyUrl: "http://1.1.1.1:80", managedBy: "free-proxy-sync", source: "iplocate", strictProxy: true, testStatus: "active", lastTestedAt: new Date().toISOString(), latencyMs: 120, exitIp: "9.9.9.9" });
    expect(await pools.getProxyPoolById(created.id)).toMatchObject({ source: "iplocate", managedBy: "free-proxy-sync", strictProxy: true, latencyMs: 120, exitIp: "9.9.9.9" });
  });

  it("updates one provider atomically without overwriting account strategy or other providers", async () => {
    await settings.updateSettings({ providerStrategies: { paid: { strategy: "fill-first", stickyRoundRobinLimit: 8 }, opencode: { strategy: "round-robin" } } });
    await Promise.all([
      settings.updateProviderProxyPolicy("paid", { proxyEnabled: false, proxyPoolIds: [], rotateStrategy: "none" }),
      settings.updateProviderProxyPolicy("opencode", { proxyEnabled: true, proxyPoolIds: ["selected"], rotateStrategy: "none" }),
    ]);
    expect((await settings.getSettings()).providerStrategies).toEqual({
      paid: { strategy: "fill-first", stickyRoundRobinLimit: 8, proxyEnabled: false, proxyPoolIds: [], rotateStrategy: "none" },
      opencode: { strategy: "round-robin", proxyEnabled: true, proxyPoolIds: ["selected"], rotateStrategy: "none" },
    });
  });

  it("prunes only unselected failed imports, preserving provider and connection assignments", async () => {
    const entries = await Promise.all(["selected", "connection", "unused", "manual"].map(id => pools.createProxyPool({ id, name: id, proxyUrl: `http://1.1.1.1:${8000 + id.length}`, ...(id !== "manual" ? { managedBy: "free-proxy-sync", source: "proxifly" } : {}), testStatus: "error" })));
    for (const entry of entries) await pools.updateProxyPool(entry.id, { autoDisabled: true });
    const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    await createProviderConnection({ provider: "openai", authType: "apikey", apiKey: "fixture", providerSpecificData: { proxyPoolId: "connection" } });
    await pools.pruneUnusedFreeProxies();
    expect(await pools.getProxyPoolById("unused")).toBeNull();
    for (const id of ["selected", "connection", "manual"]) expect(await pools.getProxyPoolById(id)).not.toBeNull();
  });
});
