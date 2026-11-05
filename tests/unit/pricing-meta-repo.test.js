import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const original = process.env.DATA_DIR;
let dir;
let db;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pricing-meta-"));
  process.env.DATA_DIR = dir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = original;
});

describe("price provenance", () => {
  it("records the source and timestamp of an import", async () => {
    await db.updatePricing(
      { gateway: { "model-a": { input: 1, output: 2 } } },
      { source: "provider", updatedAt: "2026-11-01T00:00:00.000Z" },
    );

    const meta = await db.getPricingMeta();
    expect(meta.gateway["model-a"].source).toBe("provider");
    expect(meta.gateway["model-a"].updatedAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("does not let a weaker source replace provider rates", async () => {
    await db.updatePricing(
      { gateway: { "model-a": { input: 99, output: 99 } } },
      { source: "models.dev", updatedAt: "2026-11-02T00:00:00.000Z" },
    );

    const meta = await db.getPricingMeta();
    expect(meta.gateway["model-a"].source).toBe("provider");
    // The number must not silently change under the provider label either.
    const pricing = await db.getPricing();
    expect(pricing.gateway["model-a"]).toEqual({ input: 1, output: 2 });
  });

  it("lets a manual edit outrank every automated source", async () => {
    await db.updatePricing({ gateway: { "model-a": { input: 3, output: 4 } } }, { source: "manual" });

    const meta = await db.getPricingMeta();
    expect(meta.gateway["model-a"].source).toBe("manual");
    const pricing = await db.getPricing();
    expect(pricing.gateway["model-a"]).toEqual({ input: 3, output: 4 });
  });

  it("accepts a fresher observation from an equal-ranked source", async () => {
    await db.updatePricing(
      { gateway: { "model-a": { input: 5, output: 6 } } },
      { source: "manual", updatedAt: "2030-01-01T00:00:00.000Z" },
    );

    expect((await db.getPricingMeta()).gateway["model-a"].updatedAt).toBe("2030-01-01T00:00:00.000Z");
    expect((await db.getPricing()).gateway["model-a"]).toEqual({ input: 5, output: 6 });
  });

  it("drops provenance together with the price on reset", async () => {
    await db.resetPricing("gateway", "model-a");

    const meta = await db.getPricingMeta();
    expect(meta.gateway?.["model-a"]).toBeUndefined();
  });

  it("keeps provenance through a backup export/import round trip", async () => {
    await db.updatePricing(
      { backupgw: { "model-b": { input: 7, output: 8 } } },
      { source: "provider", updatedAt: "2026-10-10T00:00:00.000Z" },
    );
    const exported = await db.exportDb();
    expect(exported.pricingMeta.backupgw["model-b"].source).toBe("provider");

    await db.importDb(exported);
    expect((await db.getPricingMeta()).backupgw["model-b"].source).toBe("provider");
  });

  it("writes without provenance when no source is given (legacy call sites)", async () => {
    await db.updatePricing({ legacygw: { "model-c": { input: 2, output: 3 } } });

    expect((await db.getPricing()).legacygw["model-c"]).toEqual({ input: 2, output: 3 });
    expect((await db.getPricingMeta()).legacygw).toBeUndefined();
  });
});