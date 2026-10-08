import { describe, expect, it } from 'vitest';
import '../translator/registerAll.js';
import { FORMATS } from '../../open-sse/translator/formats.js';
import { translateRequest } from '../../open-sse/translator/index.js';
import { normalizeClaudePassthrough } from '../../open-sse/translator/formats/claude.js';
import { getCapabilitiesForModel } from '../../open-sse/providers/capabilities.js';
describe('Haiku 5.5 adaptive thinking',()=>{
  it.each(['claude-haiku-5.5','claude-haiku-5-5','anthropic/claude-haiku-5.5'])('uses adaptive capabilities for %s',model=>{
    expect(getCapabilitiesForModel('github',model).thinkingFormat).toBe('claude-adaptive');
  });
  it.each(['low','medium'])('translates Copilot %s effort to its accepted wire format',effort=>{
    for(const source of [FORMATS.OPENAI,FORMATS.CLAUDE,FORMATS.OPENAI_RESPONSES]){
      const body=source===FORMATS.OPENAI_RESPONSES
        ?{input:'hello',max_output_tokens:256,reasoning:{effort}}
        :{messages:[{role:'user',content:'hello'}],max_tokens:256,reasoning_effort:effort};
      const wire=translateRequest(source,FORMATS.CLAUDE,'claude-haiku-5.5',body,false,{},'github');
      expect(wire.thinking).toMatchObject({type:'adaptive'});
      expect(wire.thinking).not.toHaveProperty('budget_tokens');
      expect(wire.output_config.effort).toBe(effort);
      expect(wire).not.toHaveProperty('reasoning_effort');
      expect(normalizeClaudePassthrough(wire,'claude-haiku-5.5').thinking).toMatchObject({type:'adaptive'});
      expect(wire.output_config.effort).toBe(effort);
    }
  });
  it('preserves explicit adaptive effort for native Claude clients and keeps 4.5 budget behavior',()=>{
    const make=()=>({thinking:{type:'adaptive'},output_config:{effort:'medium'}});
    expect(normalizeClaudePassthrough(make(),'claude-haiku-5.5')).toMatchObject(make());
    const old=normalizeClaudePassthrough(make(),'claude-haiku-4-5');
    expect(old.thinking).toEqual({type:'enabled',budget_tokens:10000});expect(old.output_config).toBeUndefined();
  });
});
