import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildEditModel } from "@/shared/utils/editModel.js";
import { resolveModelName } from "@/shared/utils/modelNames.js";

vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) } }));
const originalDir = process.env.DATA_DIR;
let dir, db, namesRoute, modelsRoute;
const request = (body) => ({ json: async () => body });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-display-names-"));
  process.env.DATA_DIR = dir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  namesRoute = await import("@/app/api/models/names/route.js");
  modelsRoute = await import("@/app/api/models/route.js");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDir;
});

describe("display names for every model source", () => {
  it("renames a built-in model without registering a custom model or changing routing", async () => {
    await db.setModelAlias("coding", "codex/gpt-5.4");
    await db.setCapsOverride("cx", "gpt-5.4", { contextWindow: 400000 });
    const before = (await modelsRoute.GET()).body.models.find((m) => m.routedModel === "cx/gpt-5.4");
    const res = await namesRoute.PUT(request({ provider: "codex", model: "gpt-5.4", name: "  Основная модель  " }));
    expect(res.status).toBe(200);
    const names = (await namesRoute.GET()).body.overrides;
    expect(names).toEqual({ "cx|gpt-5.4": "Основная модель" });
    expect(await db.getCustomModels()).toEqual([]);
    expect(await db.getModelAliases()).toEqual({ coding: "codex/gpt-5.4" });
    expect(await db.getCapsOverrides()).toEqual({ "cx|gpt-5.4": { contextWindow: 400000 } });
    const model = (await modelsRoute.GET()).body.models.find((m) => m.routedModel === "cx/gpt-5.4");
    expect(model).toEqual({ ...before, name: "Основная модель" });
    const editor = buildEditModel({ id: "gpt-5.4", providerId: "codex", providerAlias: "cx", name: "GPT 5.4", alias: "coding", nameOverrides: names });
    expect(editor).toMatchObject({ name: "Основная модель", defaultName: "GPT 5.4", alias: "coding", aliasKey: "codex/gpt-5.4", isCustom: false });
  });

  it("keeps separate names for the same model ID at different providers and supports media IDs", async () => {
    for (const [provider, model, name] of [
      ["node-a", "vendor/model", "Модель A"],
      ["node-b", "vendor/model", "Модель B"],
      ["openai", "tts-1", "Диктор"],
    ]) expect((await namesRoute.PUT(request({ provider, model, name }))).status).toBe(200);
    const names = (await namesRoute.GET()).body.overrides;
    expect(resolveModelName(names, "node-a", "vendor/model")).toBe("Модель A");
    expect(resolveModelName(names, "node-b", "vendor/model")).toBe("Модель B");
    expect(resolveModelName(names, "openai", "tts-1")).toBe("Диктор");
    expect(await db.getCustomModels()).toEqual([]);
  });

  it("preserves existing custom names and resets overrides to the original catalog name", async () => {
    await db.addCustomModel({ providerAlias: "cx", id: "gpt-6-astra", name: "Моя Astra", caps: { vision: true } });
    await namesRoute.PUT(request({ provider: "cx", model: "gpt-6-astra", name: "Рабочая Astra" }));
    let row = (await modelsRoute.GET()).body.models.find((m) => m.routedModel === "cx/gpt-6-astra");
    expect(row.name).toBe("Рабочая Astra");
    expect((await db.getCustomModels())[0]).toMatchObject({ name: "Моя Astra", caps: { vision: true } });
    await namesRoute.PUT(request({ provider: "cx", model: "gpt-6-astra", name: " " }));
    row = (await modelsRoute.GET()).body.models.find((m) => m.routedModel === "cx/gpt-6-astra");
    expect(row.name).toBe("Моя Astra");
    await namesRoute.PUT(request({ provider: "cx", model: "gpt-5.4", name: "" }));
    row = (await modelsRoute.GET()).body.models.find((m) => m.routedModel === "cx/gpt-5.4");
    expect(row.name).toBe("GPT 5.4");
  });

  it("rejects invalid values without writing them", async () => {
    const before = await db.getModelNameOverrides();
    for (const body of [{ provider: "cx", model: "x" }, { provider: "", model: "x", name: "A" }, { provider: "cx", model: "x", name: {} }, { provider: "cx", model: "x", name: "x".repeat(257) }]) {
      expect((await namesRoute.PUT(request(body))).status).toBe(400);
    }
    expect(await db.getModelNameOverrides()).toEqual(before);
  });

  it("exports and restores names, and clears them when importing an older backup", async () => {
    const exported = await db.exportDb();
    expect(exported.modelNames).toEqual(await db.getModelNameOverrides());
    await db.setModelNameOverride("cx", "temporary", "Удалить при восстановлении");
    await db.importDb(exported);
    expect(await db.getModelNameOverrides()).toEqual(exported.modelNames);
    const { modelNames, ...legacy } = exported;
    await db.importDb(legacy);
    expect(await db.getModelNameOverrides()).toEqual({});
  });

  it("retains names across a node prefix change and removes them with the node", async () => {
    const node = await db.createProviderNode({ id: "openai-compatible-chat-names", type: "openai-compatible", prefix: "before", name: "Test" });
    await db.setModelNameOverride(node.id, "m", "Stable name");
    await db.setModelNameOverride("before", "m", "Prefix name");
    await db.setModelNameOverride("other", "m", "Keep");
    await db.updateProviderNode(node.id, { prefix: "after" });
    expect(await db.getModelNameOverrides()).toEqual({ [`${node.id}|m`]: "Stable name", "after|m": "Prefix name", "other|m": "Keep" });
    await db.deleteProviderNode(node.id);
    expect(await db.getModelNameOverrides()).toEqual({ "other|m": "Keep" });
  });
});
