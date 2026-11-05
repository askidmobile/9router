import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const original = process.env.DATA_DIR;
let dir;
let db;
let revision;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-revision-"));
  process.env.DATA_DIR = dir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  revision = await import("@/lib/db/helpers/revision.js");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = original;
});

describe("catalog revision", () => {
  it("is stable until something writes", () => {
    const first = revision.catalogRevision();
    expect(revision.catalogRevision()).toBe(first);
    expect(revision.bumpCatalogRevision()).toBe(first + 1);
  });

  it("moves when a capability override is written", async () => {
    const before = revision.catalogRevision();
    await db.setCapsOverride("provider-a", "model-a", { contextWindow: 123000 });
    expect(revision.catalogRevision()).toBeGreaterThan(before);
  });

  it("moves when a capability override is deleted", async () => {
    const before = revision.catalogRevision();
    await db.deleteCapsOverride("provider-a", "model-a");
    expect(revision.catalogRevision()).toBeGreaterThan(before);
  });

  it("moves when a bulk capability import lands", async () => {
    const before = revision.catalogRevision();
    await db.setCapsOverridesBulk("provider-a", { "model-b": { maxOutput: 32000 } }, { source: "provider" });
    expect(revision.catalogRevision()).toBeGreaterThan(before);
  });

  it("moves when prices are imported or reset", async () => {
    const beforeImport = revision.catalogRevision();
    await db.updatePricing({ "provider-a": { "model-b": { input: 1, output: 2 } } }, { source: "provider" });
    expect(revision.catalogRevision()).toBeGreaterThan(beforeImport);

    const beforeReset = revision.catalogRevision();
    await db.resetPricing("provider-a");
    expect(revision.catalogRevision()).toBeGreaterThan(beforeReset);
  });
});