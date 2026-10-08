import { describe, expect, it } from 'vitest';
import { handleFusionChat } from '../../open-sse/services/combo.js';
const log={info(){},warn(){},error(){},debug(){}};
const completion=(provider,model,cost)=>({id:'c',object:'chat.completion',provider,model,choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:2,cost,cost_details:{estimated:true}}});
const response=b=>new Response(JSON.stringify(b),{headers:{'content-type':'application/json'}});
const frames=text=>text.split('\n').filter(x=>x.startsWith('data:')&&!x.includes('[DONE]')).map(x=>JSON.parse(x.slice(5)));
describe('Fusion response cost',()=>{
  it.each([false,true])('accounts for both panels and the actual judge (stream=%s)',async stream=>{
    const handleSingleModel=async (_b,model,panel)=>{
      const b=completion(model.split('/')[0],model.split('/')[1],panel?0.01:0.03);
      if(!panel&&stream)return new Response(`data: ${JSON.stringify({...b,object:'chat.completion.chunk'})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
      return response(b);
    };
    const r=await handleFusionChat({body:{model:'Fusion',stream,messages:[{role:'user',content:'hi'}]},models:['a/one','b/two'],judgeModel:'c/judge',handleSingleModel,log});
    const b=stream?frames(await r.text())[0]:await r.json();
    expect(b).toMatchObject({provider:'c',model:'judge'});
    expect(b.usage.cost).toBeCloseTo(0.05);
    expect(b.usage.cost_details.requests).toEqual([
      {role:'panel',provider:'a',model:'one',cost:0.01,estimated:true},
      {role:'panel',provider:'b',model:'two',cost:0.01,estimated:true},
      {role:'final',provider:'c',model:'judge',cost:0.03,estimated:true},
    ]);
  });
  it('keeps an unknown panel price unknown while exposing the known subtotal',async()=>{
    const r=await handleFusionChat({body:{model:'Fusion',stream:false,messages:[]},models:['a/one','b/two'],handleSingleModel:async (_b,m,panel)=>response(completion(m.split('/')[0],m.split('/')[1],panel&&m==='b/two'?null:0.01)),log});
    const b=await r.json();expect(b.usage.cost).toBeNull();expect(b.usage.cost_details.known_cost).toBeCloseTo(0.02);
  });
});
