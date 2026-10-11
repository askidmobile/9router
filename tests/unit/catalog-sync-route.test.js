// The schedule stores registry ids while the UI and combos label providers by
// alias (`req` for Requesty). Canonicalising in the route is what keeps an alias
// from being rejected as an unknown provider or stored twice.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ settings: { catalogSyncProviders: [] }, updates: [] }));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ body, status: init?.status || 200, ok: !init?.status || init.status < 400 }) },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => mocks.settings,
  updateSettings: async (patch) => { mocks.updates.push(patch); return { ...mocks.settings, ...patch }; },
}));
vi.mock("@/lib/providerCatalog/sync.js", () => ({
  syncProviderCatalogs: async () => ({ synced: 0, failed: 0, providers: {} }),
  getCatalogSyncState: () => ({}),
  SYNC_INTERVAL_MS: 1,
}));

import { GET, PUT } from "@/app/api/providers/catalog-sync/route.js";

beforeEach(() => {
  mocks.settings = { catalogSyncProviders: [] };
  mocks.updates = [];
});

describe("catalog-sync route", () => {
  it("stores the registry id when given an alias", async () => {
    const res = await PUT({ json: async () => ({ providers: ["req"] }) });
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual(["requesty"]);
    expect(mocks.updates[0].catalogSyncProviders).toEqual(["requesty"]);
  });

  it("does not double-store an alias and its id", async () => {
    const res = await PUT({ json: async () => ({ providers: ["requesty", "req", "apx", "apinex"] }) });
    expect(res.body.providers).toEqual(["requesty", "apinex"]);
  });

  it("rejects an id that is not a provider", async () => {
    const res = await PUT({ json: async () => ({ providers: ["not-a-provider"] }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not-a-provider");
  });

  it("requires the providers array", async () => {
    expect((await PUT({ json: async () => ({}) })).status).toBe(400);
  });

  it("reports the saved set", async () => {
    mocks.settings = { catalogSyncProviders: ["cheaper"] };
    const res = await GET();
    expect(res.body.providers).toEqual(["cheaper"]);
  });
});
