import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const original = process.env.DATA_DIR;
let dir, db;
beforeAll(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),"9router-caps-atomic-"));
  process.env.DATA_DIR=dir;
  db=await import("@/lib/db/index.js");
  await db.initDb();
});
afterAll(()=>{
  fs.rmSync(dir,{recursive:true,force:true});
  if(original===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=original;
});
describe("real database capability writes",()=>{
  it.each([false,true])("does not lose edits during overlapping catalog sync (manual first=%s)",async manualFirst=>{
    const model=manualFirst?"manual-first":"catalog-first";
    const catalog=()=>db.setCapsOverridesBulk("p",{[model]:{contextWindow:1000000,maxOutput:128000}},{source:"provider"});
    const manual=()=>db.setCapsOverride("p",model,{maxOutput:32000,reasoningLevels:["high"]});
    await Promise.all(manualFirst?[manual(),catalog()]:[catalog(),manual()]);
    expect((await db.getCapsOverrides())["p|"+model]).toEqual({contextWindow:1000000,maxOutput:32000,reasoningLevels:["high"]});
  });
  it("preserves manual/automatic layers and provenance through backup export/import",async()=>{
    const before=await db.getCapsOverrides();
    const sources=await db.getCapsMetadata();
    const exported=await db.exportDb();
    expect(exported.modelCaps["p|manual-first"].version).toBe(1);
    await db.importDb(exported);
    expect(await db.getCapsOverrides()).toEqual(before);
    expect(await db.getCapsMetadata()).toEqual(sources);
  });
});

describe('catalog models are available without being selected',()=>{
  it('clears provider selection atomically and explicit add selects only that model',async()=>{
    const {setProviderModelSelection}=await import('@/lib/db/repos/modelSelectionRepo.js');
    const connection=await db.createProviderConnection({provider:'requesty',authType:'apikey',apiKey:'fixture',isActive:true});
    await db.addCustomModel({providerAlias:'req',id:'clear-me'});
    await db.setModelAlias('legacy-choice','req/legacy-clear');
    await setProviderModelSelection('req','clear');
    expect((await db.getProviderConnectionById(connection.id)).providerSpecificData.enabledModels).toEqual([]);
    expect((await db.getCustomModels()).find(m=>m.id==='clear-me').catalogOnly).toBe(true);
    expect((await db.getDisabledModels()).req).toContain('legacy-clear');
    await db.addCustomModel({providerAlias:'req',id:'reselected'});
    const saved=await db.getProviderConnectionById(connection.id);
    expect(saved.providerSpecificData.enabledModels).toEqual(['reselected']);
    expect(saved.apiKey).toBe('fixture');
  });
  it('promotes a catalog entry on explicit add and does not demote manual models on sync',async()=>{
    await db.addCustomModel({providerAlias:'req',id:'manual'});
    await db.addCustomModelsBulk({providerAlias:'req',ids:['manual','catalog'],catalogOnly:true});
    let list=await db.getCustomModels();
    expect(list.find(m=>m.id==='manual').catalogOnly).not.toBe(true);
    expect(list.find(m=>m.id==='catalog').catalogOnly).toBe(true);
    await db.addCustomModel({providerAlias:'req',id:'catalog'});
    await db.addCustomModelsBulk({providerAlias:'req',ids:['catalog'],catalogOnly:true});
    list=await db.getCustomModels();expect(list.find(m=>m.id==='catalog').catalogOnly).toBe(false);
  });
});
