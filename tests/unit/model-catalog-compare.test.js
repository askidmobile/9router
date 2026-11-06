import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const original = process.env.DATA_DIR;
let dir;
let compare;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-model-catalog-"));
  process.env.DATA_DIR = dir;
  compare = await import("@/lib/modelCatalog/compare.js");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = original;
});

const providerModels = {
  alpha: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
  beta: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
  gamma: [{ id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (free)" }],
  delta: [{ id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017" }],
};

function buildRows(overrides = {}) {
  return compare.buildCatalogRows({
    providerModels,
    customModels: [],
    disabled: {},
    aliases: {},
    modelNames: {},
    capsOverrides: {},
    capsMetadata: {},
    pricing: {},
    pricingMeta: {},
    ...overrides,
  });
}

describe("buildCatalogRows", () => {
  it("emits one row per provider|model and skips nothing at this level", () => {
    const rows = buildRows();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.key).sort()).toEqual([
      "alpha|deepseek-v4.1-flash",
      "beta|deepseek-v4.1-flash",
      "delta|deepseek-v4.1-flash-1017",
      "gamma|deepseek-v4.1-flash:free",
    ]);
  });

  it("attaches provenance when a stored price exists", () => {
    const rows = buildRows({
      pricing: { alpha: { "deepseek-v4.1-flash": { input: 0.1, output: 0.2 } } },
      pricingMeta: {
        alpha: {
          "deepseek-v4.1-flash": { source: "provider", updatedAt: "2026-11-01T00:00:00.000Z" },
        },
      },
    });

    const alpha = rows.find((row) => row.key === "alpha|deepseek-v4.1-flash");
    expect(alpha.pricing).toEqual({ input: 0.1, output: 0.2 });
    expect(alpha.pricingSource.source).toBe("provider");
    expect(alpha.pricingSource.updatedAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("falls back to the static chain per provider, not per model", () => {
    const rows = buildRows();
    const staticRow = rows.find((row) => row.key === "beta|deepseek-v4.1-flash");
    const freeRow = rows.find((row) => row.key === "gamma|deepseek-v4.1-flash:free");

    expect(staticRow.pricingSource.source).toBe("model-table");
    expect(freeRow.pricingSource.source).toBe("free");
    expect(freeRow.pricing).toEqual({ input: 0, output: 0, cached: 0, cache_creation: 0 });
  });

  it("marks a disabled model and keeps its alias", () => {
    const rows = buildRows({
      disabled: { alpha: ["deepseek-v4.1-flash"] },
      aliases: { "alpha/deepseek-v4.1-flash": "deepseek" },
    });

    const row = rows.find((entry) => entry.key === "alpha|deepseek-v4.1-flash");
    expect(row.disabled).toBe(true);
    expect(row.alias).toBe("deepseek");
  });

  it("replaces a built-in model with the saved custom row instead of duplicating it", () => {
    const rows = buildRows({
      customModels: [
        { providerAlias: "alpha", id: "deepseek-v4.1-flash", name: "My Saved Name", type: "llm" },
      ],
    });

    const matches = rows.filter((row) => row.key === "alpha|deepseek-v4.1-flash");
    expect(matches).toHaveLength(1);
    expect(matches[0].isCustom).toBe(true);
    expect(matches[0].name).toBe("My Saved Name");
  });

  it("hides catalog-only discoveries", () => {
    const rows = buildRows({
      customModels: [
        { providerAlias: "alpha", id: "hidden-model", type: "llm", catalogOnly: true },
        { providerAlias: "alpha", id: "visible-model", type: "llm" },
      ],
    });

    const ids = rows.map((row) => row.id);
    expect(ids).not.toContain("hidden-model");
    expect(ids).toContain("visible-model");
  });

  it("ignores media models", () => {
    const rows = buildRows({
      providerModels: { alpha: [{ id: "tts-model", kind: "tts" }, { id: "chat-model", kind: "llm" }] },
    });

    expect(rows.map((row) => row.id)).toEqual(["chat-model"]);
  });
});

describe("groupRows", () => {
  it("groups by the display name and keeps the free lane in the group", () => {
    const groups = compare.groupRows(buildRows());
    const deepseek = groups.find((group) => group.identity === "deepseekv41flash");

    expect(deepseek.providers).toHaveLength(3);
    // Cheapest first: the free lane, then the paid entries.
    expect(deepseek.providers[0].providerAlias).toBe("gamma");
  });

  it("uses one readable label for the whole group", () => {
    const groups = compare.groupRows(buildRows());
    const deepseek = groups.find((group) => group.identity === "deepseekv41flash");

    // "(free)" is a delivery marker, not a different model.
    expect(deepseek.name).toBe("DeepSeek V4.1 Flash");
    // The representative id is the shortest spelling, without a vendor prefix.
    expect(deepseek.id).toBe("deepseek-v4.1-flash");
  });

  it("keeps a dated variant in its own group", () => {
    const groups = compare.groupRows(buildRows());
    const identities = groups.map((group) => group.identity);
    expect(identities).toContain("deepseekv41flash");
    expect(identities).toContain("deepseekv41flash1017");
  });

  it("keeps a single-provider group intact", () => {
    const groups = compare.groupRows(buildRows());
    const single = groups.find((group) => group.identity === "deepseekv41flash1017");
    expect(single.providers).toHaveLength(1);
  });

  it("merges the same model that arrives under different id shapes", () => {
    // The reported case: a vendor-prefixed id, a flat id and a dated one with the
    // same display name are one model for anyone comparing prices.
    const rows = [
      { key: "rc|a", providerAlias: "rc", providerId: "rc", id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek V4.1 Flash 1017", pricing: {} },
      { key: "uno|b", providerAlias: "uno", providerId: "uno", id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", pricing: {} },
      { key: "exp|c", providerAlias: "experiential", providerId: "experiential", id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash 1017", pricing: {} },
    ];

    const groups = compare.groupRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].providers).toHaveLength(3);
    expect(groups[0].name).toBe("DeepSeek V4.1 Flash 1017");
    expect(groups[0].id).toBe("deepseek-v4.1-flash-1017");
  });

  it("does not fold a plus-suffixed model into its base", () => {
    const rows = [
      { key: "a|r", providerAlias: "a", providerId: "a", id: "command-r", name: "Command R (Aug 2024)", pricing: {} },
      { key: "b|rp", providerAlias: "b", providerId: "b", id: "command-r-plus", name: "Command R+ (Aug 2024)", pricing: {} },
    ];

    expect(compare.groupRows(rows)).toHaveLength(2);
  });

  it("sorts providers by input price inside a group", () => {
    const groups = compare.groupRows(buildRows({
      pricing: {
        alpha: { "deepseek-v4.1-flash": { input: 5, output: 6 } },
        beta: { "deepseek-v4.1-flash": { input: 1, output: 2 } },
      },
      pricingMeta: {
        alpha: { "deepseek-v4.1-flash": { source: "provider" } },
        beta: { "deepseek-v4.1-flash": { source: "provider" } },
      },
    }));
    const group = groups.find((entry) => entry.identity === "deepseekv41flash");
    const prices = group.providers.map((row) => row.pricing.input);

    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });
});