import { it, expect } from 'vitest';
import { selectedModelIds } from '../../src/shared/utils/modelSelection.js';
import { getProviderCustomModelRows } from '../../src/shared/utils/providerCustomModels.js';
it('uses explicit choices, including an empty selection, and unions account choices',()=>{
 const c=ids=>({providerSpecificData:{enabledModels:ids}});
 expect([...selectedModelIds([c(['req/a']),c(['b'])],['req'])]).toEqual(['a','b']);
 expect(selectedModelIds([c([])],['req']).size).toBe(0);
 expect(selectedModelIds([c(['a']),{}],['req'])).toBeNull();
});
it('keeps catalog discovery separate from selected models',()=>{
 const rows=getProviderCustomModelRows({providerAlias:'req',customModels:[{providerAlias:'req',id:'selected'},{providerAlias:'req',id:'available',catalogOnly:true}]});
 expect(rows.map(r=>r.id)).toEqual(['selected']);
});
