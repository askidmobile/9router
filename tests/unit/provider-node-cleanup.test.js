// Regression cover for three "leftovers" bugs:
//  1. combos kept routing to models/providers the user switched off
//  2. the provider page opened the model editor without the configured data
//  3. deleting a self-created provider node left its models/aliases/combo
//     members behind, so the provider stayed alive in the dashboard
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let modelService;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-node-cleanup-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  modelService = await import("@/sse/services/model.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("deleteProviderNode — cascade cleanup", () => {
  it("removes the node's models, aliases, overrides and combo members, and nothing else", async () => {
    const node = await db.createProviderNode({
      id: "openai-compatible-chat-cleanup", type: "openai-compatible",
      name: "Zen", prefix: "oc-zen", apiType: "chat", baseUrl: "https://example.test/v1",
    });
    const keeper = await db.createProviderNode({
      id: "openai-compatible-chat-keeper", type: "openai-compatible",
      name: "Keep", prefix: "oc-keep", apiType: "chat", baseUrl: "https://example.test/v1",
    });

    await db.addCustomModel({ providerAlias: node.id, id: "glm-4.7" });
    await db.addCustomModel({ providerAlias: keeper.id, id: "glm-4.7" });
    await db.setModelAlias("zen-fast", `${node.id}/glm-4.7`);
    await db.setModelAlias("keep-fast", `${keeper.id}/glm-4.7`);
    await db.disableModels(node.id, ["glm-4.7"]);
    await db.disableModels(keeper.id, ["glm-4.7"]);
    await db.setCapsOverride(node.id, "glm-4.7", { vision: true });
    await db.setCapsOverride(keeper.id, "glm-4.7", { vision: true });
    await db.updatePricing({ [node.id]: { "glm-4.7": { input: 1 } }, [keeper.id]: { "glm-4.7": { input: 1 } } });

    const combo = await db.createCombo({
      name: "cleanup-combo",
      models: ["oc-zen/glm-4.7", `${node.id}/glm-4.7`, "oc-keep/glm-4.7", "oai/gpt-4o"],
    });

    const removed = await db.deleteProviderNode(node.id);
    expect(removed?.id).toBe(node.id);
    expect(removed.purgedCombos).toContain("cleanup-combo");

    const customModels = await db.getCustomModels();
    expect(customModels.some((m) => m.providerAlias === node.id)).toBe(false);
    expect(customModels.some((m) => m.providerAlias === keeper.id)).toBe(true);

    const aliases = await db.getModelAliases();
    expect(aliases["zen-fast"]).toBeUndefined();
    expect(aliases["keep-fast"]).toBe(`${keeper.id}/glm-4.7`);

    const disabled = await db.getDisabledModels();
    expect(disabled[node.id]).toBeUndefined();
    expect(disabled[keeper.id]).toEqual(["glm-4.7"]);

    const overrides = await db.getCapsOverrides();
    expect(overrides[`${node.id}|glm-4.7`]).toBeUndefined();
    expect(overrides[`${keeper.id}|glm-4.7`]).toEqual({ vision: true });

    const pricing = await db.getPricing();
    expect(pricing[node.id]).toBeUndefined();
    expect(pricing[keeper.id]["glm-4.7"].input).toBe(1);

    // Only this node's members drop out — by prefix and by raw id.
    const updated = await db.getComboById(combo.id);
    expect(updated.models).toEqual(["oc-keep/glm-4.7", "oai/gpt-4o"]);

    await db.deleteProviderNode(keeper.id);
  });
});

describe("getComboModels — members the user switched off", () => {
  it("skips disabled models and providers whose connections are all off", async () => {
    await db.createCombo({
      name: "routing-combo",
      models: ["oai/gpt-4o", "oai/gpt-4o-mini", "anthropic/claude-sonnet-4-5"],
    });

    // Nothing off yet → full list.
    expect(await modelService.getComboModels("routing-combo")).toEqual([
      "oai/gpt-4o", "oai/gpt-4o-mini", "anthropic/claude-sonnet-4-5",
    ]);

    // Disabled list is keyed by provider alias, combo members use the same alias.
    await db.disableModels("oai", ["gpt-4o"]);
    expect(await modelService.getComboModels("routing-combo")).toEqual([
      "oai/gpt-4o-mini", "anthropic/claude-sonnet-4-5",
    ]);

    // Connection switched off → every model of that provider drops out. Members
    // spell the provider by alias ("anthropic"), the connection by id.
    const conn = await db.createProviderConnection({
      provider: "anthropic", authType: "apikey", name: "Claude", apiKey: "x", isActive: true,
    });
    expect(await modelService.getComboModels("routing-combo")).toEqual([
      "oai/gpt-4o-mini", "anthropic/claude-sonnet-4-5",
    ]);
    await db.updateProviderConnection(conn.id, { isActive: false });
    expect(await modelService.getComboModels("routing-combo")).toEqual(["oai/gpt-4o-mini"]);

    // Re-enabling restores the member — the combo was never rewritten.
    await db.updateProviderConnection(conn.id, { isActive: true });
    await db.enableModels("oai", ["gpt-4o"]);
    expect(await modelService.getComboModels("routing-combo")).toEqual([
      "oai/gpt-4o", "oai/gpt-4o-mini", "anthropic/claude-sonnet-4-5",
    ]);

    await db.deleteProviderConnection(conn.id);
  });
});

describe("buildEditModel", () => {
  it("carries alias, effective caps, override and pricing into the editor", async () => {
    const { buildEditModel } = await import("@/shared/utils/editModel.js");
    const model = buildEditModel({
      id: "gpt-4o",
      providerAlias: "oai",
      providerId: "openai",
      alias: "fast",
      overrides: { "oai|gpt-4o": { contextWindow: 999 } },
      getCaps: () => ({ vision: true }),
      getPricing: (provider, id) => (provider === "oai" && id === "gpt-4o" ? { input: 2.5 } : null),
    });

    expect(model.alias).toBe("fast");
    expect(model.aliasKey).toBe("openai/gpt-4o"); // alias PUT would 400 without this
    expect(model.caps.contextWindow).toBe(999);
    expect(model.caps.vision).toBe(true);
    expect(model.override).toEqual({ contextWindow: 999 });
    expect(model.pricing).toEqual({ input: 2.5 });
    // staticCaps must stay the un-overridden baseline: EditModelModal saves the
    // diff against it, so an override-tainted baseline would delete the override.
    expect(model.staticCaps.contextWindow).not.toBe(999);
  });

  it("keys custom models on the provider alias", async () => {
    const { buildEditModel } = await import("@/shared/utils/editModel.js");
    const model = buildEditModel({ id: "glm-4.7", providerAlias: "openai-compatible-chat-x" });
    expect(model.aliasKey).toBe("openai-compatible-chat-x/glm-4.7");
    expect(model.override).toBeNull();
  });
});

describe("getProviderCustomModelRows", () => {
  it("carries the alias of a registered custom model", async () => {
    const { getProviderCustomModelRows } = await import("@/shared/utils/providerCustomModels.js");
    const rows = getProviderCustomModelRows({
      customModels: [{ providerAlias: "node-1", id: "glm-5.3-flash", name: "GLM-5.3 Flash" }],
      modelAliases: { flash: "node-1/glm-5.3-flash", other: "node-1/glm-5.3" },
      providerAlias: "node-1",
    });

    // The custom row must carry both labels: the provider pages show them and
    // EditModelModal saves the alias back.
    const custom = rows.find((r) => r.id === "glm-5.3-flash");
    expect(custom.source).toBe("custom");
    expect(custom.name).toBe("GLM-5.3 Flash");
    expect(custom.alias).toBe("flash");

    // An alias with no registered model still gets its own row.
    expect(rows.find((r) => r.id === "glm-5.3")).toMatchObject({ source: "legacyAlias", alias: "other" });
  });
});
