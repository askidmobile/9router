import { it, expect } from 'vitest';
import { selectedModelIds, existingProviderModelIds } from '../../src/shared/utils/modelSelection.js';
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

it('allows re-import after clearing and disables only genuinely selected rows',()=>{
 const common={providerAlias:'req',models:[{id:'built-in'}],customModels:[{providerAlias:'req',id:'catalog',catalogOnly:true},{providerAlias:'requesty',id:'chosen'}],modelAliases:{saved:'req/catalog'}};
 expect([...existingProviderModelIds({...common,disabledIds:['built-in','catalog','chosen'],connections:[{providerSpecificData:{enabledModels:[]}}]})]).toEqual([]);
 expect([...existingProviderModelIds({...common,connections:[{providerSpecificData:{enabledModels:['chosen']}}]})]).toEqual(['chosen']);
 expect(existingProviderModelIds(common).has('catalog')).toBe(false);
});
