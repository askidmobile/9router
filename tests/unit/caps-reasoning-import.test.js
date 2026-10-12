import { beforeEach, describe, expect, it, vi } from "vitest";
const { storage, kv } = vi.hoisted(() => {
  const storage = {};
  return { storage, kv: {
    getAll: async () => ({...storage}), get: async k => storage[k] || null,
    setMany: async obj => Object.assign(storage,obj), set: async (k,v) => {storage[k]=v},
    remove: async k => {delete storage[k]},
    updateMany: async (keys, update) => {for (const key of keys) {const value=update(storage[key]||null,key);if(value===null) delete storage[key];else storage[key]=value}},
  }};
});
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => kv }));
const { setCapsOverridesBulk, setCapsOverride, getCapsOverrides, getCapsMetadata, deleteCapsOverride, getManualCapsOverrides } = await import("../../src/lib/db/repos/capsRepo.js");
beforeEach(() => { for(const k of Object.keys(storage)) delete storage[k]; });

describe("catalog and manual capability layers", () => {
  it("reads only the requested model while preserving the full-list contract", async () => {
    storage["p|m"] = { contextWindow: 123 };
    storage["p|other"] = { maxOutput: 456 };
    expect(await getCapsOverrides("p|m")).toEqual({ "p|m": { contextWindow: 123 } });
    expect(await getCapsOverrides("p|missing")).toEqual({});
    expect(Object.keys(await getCapsOverrides())).toHaveLength(2);
  });
  it.each([["xhigh","max"],[],null].map(reasoningLevels=>({reasoningLevels})))("preserves legacy edits and labels uncertain provenance: %j", async ({reasoningLevels}) => {
    storage["ocg|space-bunny"]={reasoning:true,reasoningLevels,contextWindow:999};
    await setCapsOverridesBulk("ocg",{"space-bunny":{contextWindow:1000000,reasoning:false,tools:true}});
    expect((await getCapsOverrides())["ocg|space-bunny"]).toEqual({contextWindow:999,reasoning:true,reasoningLevels,tools:true});
    expect((await getCapsMetadata())["ocg|space-bunny"].contextWindow).toMatchObject({source:"legacy",updatedAt:null,verified:false,catalog:{value:1000000}});
  });
  it("auto sync updates observations without overwriting explicit CTX, OUT or reasoning edits",async()=>{
    await setCapsOverridesBulk("p",{m:{contextWindow:1000000,maxOutput:128000,reasoningLevels:["low","high"]}},{source:"provider"});
    await setCapsOverride("p","m",{maxOutput:32000,reasoningLevels:["high"]});
    await setCapsOverridesBulk("p",{m:{contextWindow:2000000,maxOutput:256000,reasoningLevels:["low","medium","high"]}},{source:"provider"});
    expect((await getCapsOverrides())["p|m"]).toEqual({contextWindow:2000000,maxOutput:32000,reasoningLevels:["high"]});
    const sources=(await getCapsMetadata())["p|m"];
    expect(sources.contextWindow.source).toBe("provider");
    expect(sources.maxOutput.source).toBe("manual");
    expect(sources.maxOutput.updatedAt).toMatch(/^20/);
    await deleteCapsOverride("p","m");
    expect((await getCapsOverrides())["p|m"].maxOutput).toBe(256000);
    expect((await getManualCapsOverrides())["p|m"]).toBeUndefined();
  });
  it("retains previously observed output when a subsequent catalog only publishes context",async()=>{
    await setCapsOverridesBulk("p",{m:{contextWindow:1000000,maxOutput:64000}});
    await setCapsOverridesBulk("p",{m:{contextWindow:500000}});
    expect((await getCapsOverrides())["p|m"]).toEqual({contextWindow:500000,maxOutput:64000});
  });
  it("null reasoning reset uses refreshed automatic levels",async()=>{
    await setCapsOverride("p","m",{reasoningLevels:null});
    await setCapsOverridesBulk("p",{m:{reasoningLevels:["low","high"]}});
    expect((await getCapsOverrides())["p|m"].reasoningLevels).toEqual(["low","high"]);
  });
});
