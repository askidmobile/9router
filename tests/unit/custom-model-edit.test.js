import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildEditModel } from "@/shared/utils/editModel.js";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let customRoute;
let modelsRoute;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-custom-model-edit-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  customRoute = await import("@/app/api/models/custom/route.js");
  modelsRoute = await import("@/app/api/models/route.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("custom model display name and capability editing", () => {
  it("renames through the API without changing the ID, alias or saved capabilities", async () => {
    await db.addCustomModel({ providerAlias: "cx", id: "gpt-6-astra", caps: { vision: true, reasoning: true } });
    await db.setModelAlias("astra-fast", "cx/gpt-6-astra");
    const caps = { contextWindow: 400000, maxOutput: 128000, pdf: true };
    await db.setCapsOverride("cx", "gpt-6-astra", caps);

    const response = await customRoute.POST({ json: async () => ({
      providerAlias: "cx", id: "gpt-6-astra", name: "GPT-6 Astra — основная",
    }) });
    expect(response.status).toBe(200);
    expect(response.body.added).toBe(false);
    const stored = await db.getCustomModels();
    expect(stored).toEqual([{
      providerAlias: "cx", id: "gpt-6-astra", type: "llm",
      name: "GPT-6 Astra — основная", caps: { vision: true, reasoning: true },
    }]);
    expect(await db.getModelAliases()).toEqual({ "astra-fast": "cx/gpt-6-astra" });
    expect(await db.getCapsOverrides()).toEqual({ "cx|gpt-6-astra": caps });

    const list = await modelsRoute.GET();
    const row = list.body.models.find((m) => m.fullModel === "cx/gpt-6-astra");
    expect(row.name).toBe(stored[0].name);
    expect(row.caps).toMatchObject(caps);
    const editor = buildEditModel({
      ...stored[0], isCustom: true, alias: "astra-fast",
      overrides: await db.getCapsOverrides(), getCaps: () => row.caps,
    });
    expect(editor).toMatchObject({
      name: stored[0].name, isCustom: true, alias: "astra-fast",
      id: "gpt-6-astra", aliasKey: "cx/gpt-6-astra",
    });
    expect(editor.caps.contextWindow).toBe(row.caps.contextWindow);
    expect(editor.caps.maxOutput).toBe(row.caps.maxOutput);
    expect(editor.staticCaps.contextWindow).not.toBe(400000);
  });
});
