import { it,expect,vi } from 'vitest';
const db=vi.hoisted(()=>({getManualCapsOverrides:vi.fn(async()=>({'p|m':{maxOutput:8}})),getCapsOverrides:vi.fn(async()=>({'p|m':{maxOutput:8,contextWindow:100}})),getAutomaticCapsOverrides:vi.fn(),getCapsMetadata:vi.fn(),getAutomaticCapsMetadata:vi.fn(),setCapsOverride:vi.fn(),deleteCapsOverride:vi.fn()}));
vi.mock('@/lib/db/index.js',()=>db);
import { GET } from '../../src/app/api/models/caps/route.js';
it('returns UI values without loading the large provenance maps',async()=>{
 const data=await (await GET(new Request('http://localhost/api/models/caps?summary=1'))).json();
 expect(data).toEqual({overrides:{'p|m':{maxOutput:8}},effective:{'p|m':{maxOutput:8,contextWindow:100}}});
 expect(db.getCapsMetadata).not.toHaveBeenCalled();expect(db.getAutomaticCapsOverrides).not.toHaveBeenCalled();
});
