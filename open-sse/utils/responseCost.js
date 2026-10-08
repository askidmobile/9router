import { calculateCostFromTokens } from "../providers/pricing.js";
import { canonicalizeUsage } from "./usageTracking.js";

/** USD accounting shared by client responses and the usage journal. */
export function calculateResponseCost(usage, pricing) {
  const reported = usage?.cost;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return { cost: reported, cost_details: { ...usage.cost_details, currency: "USD", source: usage.cost_details?.source || "provider", estimated: usage.cost_details?.estimated ?? false } };
  }
  const tokens = canonicalizeUsage(usage);
  const countFields = ["prompt_tokens", "input_tokens", "completion_tokens", "output_tokens"];
  const known = usage && countFields.some(key => typeof usage[key] === "number")
    && countFields.every(key => usage[key] === undefined || Number.isFinite(usage[key]) && usage[key] >= 0);
  if (!pricing || !known || !Number.isFinite(pricing.input) || !Number.isFinite(pricing.output)) {
    return { cost: null, cost_details: { currency: "USD", source: "unavailable", estimated: false } };
  }
  // OpenAI/Responses reasoning tokens are an output subset. Gemini thoughts
  // are separate from candidatesTokenCount. Never charge a subset twice.
  const includedReasoning = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens;
  const billable = includedReasoning === undefined ? tokens : {
    ...tokens, completion_tokens: Math.max(0, tokens.completion_tokens - (tokens.reasoning_tokens || 0)),
  };
  const cost = calculateCostFromTokens(billable, pricing);
  return Number.isFinite(cost) && cost >= 0
    ? { cost, cost_details: { currency: "USD", source: "pricing", estimated: true, billable_tokens: tokens } }
    : { cost: null, cost_details: { currency: "USD", source: "unavailable", estimated: false } };
}
