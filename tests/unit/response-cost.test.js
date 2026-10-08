import { describe, expect, it } from 'vitest';
import { calculateResponseCost } from '../../open-sse/utils/responseCost.js';
const pricing = { input: 2, output: 4, cached: 0, cache_creation: 3, reasoning: 4 };
describe('response cost accounting', () => {
  it('keeps a provider-reported cost including zero and its breakdown', () => {
    expect(calculateResponseCost({ cost: 0, cost_details: { upstream_inference_cost: 0.01 } }, pricing)).toEqual({ cost: 0, cost_details: { currency: 'USD', source: 'provider', estimated: false, upstream_inference_cost: 0.01 } });
  });
  it('prices OpenAI cache and output reasoning subsets without charging them twice', () => {
    const r = calculateResponseCost({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 6 } }, pricing);
    expect(r.cost).toBeCloseTo(0.00008, 10);
    expect(r.cost_details).toMatchObject({ currency: 'USD', source: 'pricing', estimated: true, billable_tokens: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 80, reasoning_tokens: 6 } });
  });
  it('folds Claude uncached input, cache reads and writes', () => {
    expect(calculateResponseCost({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 30 }, pricing).cost).toBeCloseTo(0.00017, 10);
  });
  it('prices native Responses cache details and separate Gemini thought tokens', () => {
    expect(calculateResponseCost({ input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 6 } }, pricing).cost).toBeCloseTo(0.00008, 10);
    expect(calculateResponseCost({ prompt_tokens: 20, completion_tokens: 10, reasoning_tokens: 6 }, pricing).cost).toBeCloseTo(0.000104, 10);
  });
  it('distinguishes unknown prices or missing usage from known zero pricing', () => {
    expect(calculateResponseCost({ prompt_tokens: 20, completion_tokens: 10 }, null).cost).toBeNull();
    expect(calculateResponseCost({}, pricing).cost).toBeNull();
    expect(calculateResponseCost({ prompt_tokens: 20, completion_tokens: 10 }, { input: 0, output: 0 }).cost).toBe(0);
    expect(calculateResponseCost({ prompt_tokens: -10, completion_tokens: 3 }, pricing).cost).toBeNull();
  });
});
