import { describe, it, expect, vi, beforeEach } from "vitest";
const storage = vi.hoisted(() => ({}));
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => ({ get: async k => storage[k], set: async (k, v) => { storage[k] = v; } }) }));
import { matchModel } from "../../src/lib/modelSources/identity.js";
import { supplementaryMetadata, getSupplementaryCatalog, getSupplementaryMetadata, mergeModelCapabilities } from "../../src/lib/modelSources/index.js";
import { parseOfficialDocument, getManufacturerCatalog, OFFICIAL_DOCUMENTS } from "../../src/lib/modelSources/manufacturer.js";
const hy4 = { id: "tencent/hy4-preview", context_length: 1048576, top_provider: { max_completion_tokens: 64000 }, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: ["high", "low", "none"], mandatory: false } };
const tokenhub = (context="1M",output="64k") => `<table><tr><th>model（调用参数）</th><th>上下文窗口（Token）</th><th>最大输出（Token）</th><th>能力支持</th></tr><tr><td>hy4-preview</td><td>${context}</td><td>${output}</td><td>Function Calling 深度思考</td></tr></table>`;
const cloudbase = `<table><tr><th>Model</th><th>Context</th><th>Image</th><th>Video</th><th>Deep Thinking</th><th>Tool Calling</th></tr><tr><td><code>hy4-preview</code></td><td>1M</td><td>❌</td><td>❌</td><td>✅</td><td>✅</td></tr></table>`;
beforeEach(() => { for (const key of Object.keys(storage)) delete storage[key]; vi.unstubAllGlobals(); });

describe("model identity matching", () => {
  it("matches free IDs, explicit aliases and unique names", () => {
    expect(matchModel("free/hy4", [hy4])).toMatchObject({ match: "alias", model: hy4 });
    expect(matchModel("Hy4-preview", [hy4]).match).toBe("unique-name");
  });
  it("rejects ambiguous names, wrong namespaces and different versions", () => {
    expect(matchModel("m", [{id:"a/m"}, {id:"b/m"}])).toBeNull();
    expect(matchModel("b/hy4-preview", [hy4])).toBeNull();
    expect(matchModel("hy4-preview-20270101", [hy4])).toBeNull();
  });
});
describe("user-triggered official metadata", () => {
  it("parses real named columns and explicit flags without inventing absent values", () => {
    expect(parseOfficialDocument(tokenhub(),"tokenhub")[0].caps).toMatchObject({contextWindow:1e6,maxOutput:64000,tools:true,reasoning:true});
    expect(parseOfficialDocument(cloudbase,"cloudbase")[0].caps.vision).toBe(false);
    expect(()=>parseOfficialDocument('<html>upstream unavailable</html>',"tokenhub")).toThrow();
  });
  it("makes no requests unless the user asks to refresh", async () => {
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect((await getSupplementaryMetadata(['free/hy4'])).models).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refreshes changing CTX/OUT and reasoning instead of reusing a static snapshot", async () => {
    let output='64k',efforts=['none','low','high'];
    const fetcher=vi.fn(async url=>String(url).includes('openrouter')?{ok:true,json:async()=>({data:[{...hy4,reasoning:{supported_efforts:efforts}}]})}:{ok:true,text:async()=>String(url).includes('cloudbase')?cloudbase:tokenhub('1M',output)});
    vi.stubGlobal('fetch',fetcher);
    const first=await getSupplementaryMetadata(['free/hy4'],{refresh:true});
    expect(first.models['free/hy4'].caps).toMatchObject({maxOutput:64000,vision:false,reasoningLevels:['none','low','high']});
    expect(first.models['free/hy4'].sources.maxOutput).toMatchObject({source:'manufacturer-docs',stale:false,verified:false});
    expect(first.models['free/hy4'].sources.maxOutput).not.toHaveProperty('snapshot');
    output='96k';efforts=['low','high'];
    const second=await getSupplementaryMetadata(['free/hy4'],{refresh:true});
    expect(second.models['free/hy4'].caps).toMatchObject({maxOutput:96000,reasoningLevels:['low','high']});
    const n=fetcher.mock.calls.length;await getSupplementaryMetadata(['free/hy4']);expect(fetcher).toHaveBeenCalledTimes(n);
    for(const [,options] of fetcher.mock.calls)expect(options.headers).not.toHaveProperty('Authorization');
  });
  it("does not replace cached data when document structure changes or fetching fails",async()=>{
    storage[OFFICIAL_DOCUMENTS[0].url]={url:OFFICIAL_DOCUMENTS[0].url,fetchedAt:1234,models:parseOfficialDocument(tokenhub(),'tokenhub')};
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,text:async()=>'<html>Error</html>'})));
    const result=await getManufacturerCatalog({refresh:true});
    expect(result.models[0].caps.maxOutput).toBe(64000);expect(result.models[0].sources.maxOutput.stale).toBe(true);expect(result.warning).toContain('no recognized');
  });
  it("shares an explicitly requested public catalog fetch",async()=>{
    const fetcher=vi.fn(async()=>({ok:true,json:async()=>({data:[hy4]})}));vi.stubGlobal('fetch',fetcher);
    await Promise.all([getSupplementaryCatalog({refresh:true}),getSupplementaryCatalog({refresh:true})]);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains provider declarations over supplementary limits and flags",()=>{
    const extra=supplementaryMetadata(['free/hy4'],{models:[hy4],fetchedAt:1000})['free/hy4'];
    expect(mergeModelCapabilities({vision:true,maxOutput:32000},null,{},extra,'apinex','now').caps).toMatchObject({vision:true,maxOutput:32000});
  });
});
