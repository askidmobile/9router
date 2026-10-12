import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({ getPricing: vi.fn(async () => ({})) }));
const { saveRequestUsage } = await import("@/lib/usageDb.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

describe("mixed gateway JSON usage", () => {
  it("persists output tokens, key and cost from the real non-streaming handler", async () => {
    const body = { model: "claude-opus-5.5", messages: [] };
    const result = await handleNonStreamingResponse({
      providerResponse: Response.json({
        id: "chatcmpl-fixture", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { input_tokens: 14739, prompt_tokens: 14739, completion_tokens: 1154,
          cost: 0.0079, cost_details: { currency: "USD", source: "provider" } },
      }),
      provider: "apinex", model: body.model, sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
      body, stream: false, requestStartTime: Date.now(), apiKey: "sk-test-client-key",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
      appendLog: vi.fn(), trackDone: vi.fn(),
    });
    expect(result.success).toBe(true);
    expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "sk-test-client-key",
      tokens: expect.objectContaining({ prompt_tokens: 14739, completion_tokens: 1154, total_tokens: 15893, cost: 0.0079 }),
    }));
  });
});
