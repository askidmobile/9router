import { describe, it, expect, vi, beforeEach } from "vitest";
const storage = vi.hoisted(() => ({}));
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => ({ get: async k => storage[k], set: async (k, v) => { storage[k] = v; } }) }));
import { matchModel } from "../../src/lib/modelSources/identity.js";
import { supplementaryMetadata, getSupplementaryCatalog, mergeModelCapabilities } from "../../src/lib/modelSources/index.js";
import { catalogMetadata } from "../../src/lib/providerCatalog/metadata.js";
const hy4 = { id: "tencent/hy4-preview", context_length: 1048576, top_provider: { max_completion_tokens: 64000 }, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: ["high", "low", "none"], mandatory: false } };
beforeEach(() => { delete storage.openrouter; vi.unstubAllGlobals(); });

describe("model identity matching", () => {
  it("matches free IDs, explicit aliases and unique names", () => {
    expect(matchModel("free/hy4", [hy4])).toMatchObject({ match: "alias", model: hy4 });
    expect(matchModel("Hy4-preview", [hy4]).match).toBe("unique-name");
    expect(matchModel("tencent/hy4-preview", [hy4]).match).toBe("exact");
  });
  it("rejects ambiguous names, wrong namespaces and different versions", () => {
    expect(matchModel("m", [{id:"a/m"}, {id:"b/m"}])).toBeNull();
    expect(matchModel("b/hy4-preview", [hy4])).toBeNull();
    expect(matchModel("hy4-preview-20270101", [hy4])).toBeNull();
  });
});
describe("additional official metadata", () => {
  it("parses published modalities, tools and effort enums without borrowing prices", () => {
    expect(catalogMetadata(hy4).caps).toMatchObject({maxOutput:64000,vision:false,tools:true,reasoningLevels:["none","low","high"],thinkingCanDisable:true});
  });
  it("uses manufacturer documentation ahead of the cross-provider catalog and retains review dates", () => {
    const data = supplementaryMetadata(["free/hy4"], {models:[{...hy4,top_provider:{max_completion_tokens:131072}}],fetchedAt:1000000,stale:false})["free/hy4"];
    expect(data.caps).toMatchObject({contextWindow:1000000,maxOutput:64000,vision:false,tools:true,reasoningLevels:["none","low","high"]});
    expect(data.sources.maxOutput).toMatchObject({source:"manufacturer-docs",modelId:"tencent/hy4-preview",snapshot:true,verified:false,updatedAt:"2026-10-12T08:00:00.000Z"});
    expect(data).not.toHaveProperty("pricing");
  });
  it("preserves provider false values, explicit tiers and broker limits over every supplement", () => {
    const additional=supplementaryMetadata(["free/hy4"], {models:[hy4],fetchedAt:1000})["free/hy4"];
    const result=mergeModelCapabilities({contextWindow:900000,maxOutput:32000,vision:true,reasoning:false,reasoningLevels:[]}, {caps:{contextWindow:2e6,vision:true}}, {fetchedAt:1000}, additional, "apinex", "2026-10-12T08:00:00Z");
    expect(result.caps).toMatchObject({contextWindow:900000,maxOutput:32000,vision:true,reasoning:false,reasoningLevels:[]});
    expect(result.sources.maxOutput.source).toBe("provider");
  });
  it("uses additional sources when a models.dev provider catalog is the only available list", () => {
    const additional=supplementaryMetadata(["hy4-preview"], {models:[hy4],fetchedAt:1000})["hy4-preview"];
    const result=mergeModelCapabilities(null, {id:"hy4-preview",caps:{vision:true,maxOutput:1000}}, {modelsDevId:"tencent",fetchedAt:1000}, additional, "hunyuan");
    expect(result.caps).toMatchObject({vision:false,maxOutput:64000});
    expect(result.sources.vision.source).toBe("manufacturer-docs");
  });
  it("caches one shared public fetch and never sends account credentials", async () => {
    const fetcher=vi.fn(async()=>({ok:true,json:async()=>({data:[hy4]})}));vi.stubGlobal("fetch",fetcher);
    const [a,b]=await Promise.all([getSupplementaryCatalog(),getSupplementaryCatalog()]);
    expect(a.models).toEqual(b.models);expect(fetcher).toHaveBeenCalledTimes(1);
    await getSupplementaryCatalog();expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers).toEqual({Accept:"application/json"});
  });
  it("retains a stale catalog when the public source is unavailable", async () => {
    storage.openrouter={models:[hy4],fetchedAt:1};vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("offline")}));
    expect(await getSupplementaryCatalog()).toMatchObject({stale:true,models:[hy4]});
  });
});
