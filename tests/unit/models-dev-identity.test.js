import { it, expect, vi } from "vitest";
const catalog = {
  tencent: { models: { "hy4-preview": { id: "hy4-preview", limit: { context: 1000000, output: 64000 }, reasoning: true } } },
  a: { models: { m: { id: "m", limit: { context: 100 } } } },
  b: { models: { m: { id: "m", limit: { context: 200 } } } },
};
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => ({ get: async key => key === "catalog" ? catalog : Date.now() }) }));
import { getExactModelFallbacks } from "../../src/lib/modelsDev/index.js";
it("uses canonical manufacturer aliases and rejects ambiguous cross-provider names", async () => {
  const result = await getExactModelFallbacks(["free/hy4", "tencent/hy4-preview", "m", "a/m", "bad/hy4-preview"]);
  expect(result["free/hy4"]).toMatchObject({modelsDevId:"tencent",match:"alias",caps:{contextWindow:1000000,maxOutput:64000}});
  expect(result["tencent/hy4-preview"].modelsDevId).toBe("tencent");
  expect(result["a/m"].modelsDevId).toBe("a");
  expect(result.m).toBeUndefined();expect(result["bad/hy4-preview"]).toBeUndefined();
});
