import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({ performance: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
  recordModelPerformance: telemetry.performance,
}));
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({ getPricing: async () => ({}) }));

import { buildOnStreamComplete, handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { summarizeGroup } from "@/app/(dashboard)/dashboard/models/compare/summary.js";
import { buildCatalogCsv } from "@/app/(dashboard)/dashboard/models/compare/exportCsv.js";
import "../translator/registerAll.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); telemetry.performance.mockClear(); });
afterEach(() => vi.useRealTimers());

describe("streaming throughput through the response handler", () => {
  it.each([
    { sourceFormat: "openai", failed: false }, { sourceFormat: "claude", failed: false },
    { sourceFormat: "openai-responses", failed: false },
    { sourceFormat: "openai", failed: true },
  ])("measures first output for a $sourceFormat client, failed=$failed", async ({ sourceFormat, failed }) => {
    const upstream = new TransformStream();
    const writer = upstream.writable.getWriter();
    const native = sourceFormat === "openai-responses";
    const context = {
      provider: native ? "codex" : "openai", model: "gpt-4o", requestStartTime: 10000,
      sourceFormat, targetFormat: native ? "openai-responses" : "openai", stream: true,
      body: { messages: [{ role: "user", content: "ping" }] },
      reqLogger: {}, log: {}, streamController: createStreamController({}),
    };
    const completion = buildOnStreamComplete(context);
    const result = await handleStreamingResponse({ ...context, ...completion,
      providerResponse: new Response(upstream.readable, { headers: { "content-type": "text/event-stream" } }),
    });
    const reading = result.response.text();
    const send = async (time, frame) => {
      vi.setSystemTime(time);
      await writer.write(new TextEncoder().encode(`${native ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`));
      await vi.advanceTimersByTimeAsync(0);
    };
    await send(11000, native ? { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } } : { choices: [{ index: 0, delta: { role: "assistant" } }] });
    await send(14000, native ? { type: "response.reasoning_summary_text.delta", delta: "Thinking" } : { choices: [{ index: 0, delta: { reasoning_content: "Thinking" } }] });
    await send(15000, native ? { type: "response.output_text.delta", delta: "Done" } : { choices: [{ index: 0, delta: { content: "Done" } }] });
    if (failed) await send(15500, { error: { message: "fixture upstream failure" } });
    await send(16000, native ? { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 100, total_tokens: 104 } } } : { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 100, total_tokens: 104 } });
    await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
    await writer.close();
    expect(await reading).toContain("Done");
    if (failed) expect(telemetry.performance).not.toHaveBeenCalled();
    else expect(telemetry.performance).toHaveBeenCalledExactlyOnceWith({
      provider: context.provider, model: "gpt-4o", outputTokens: 100, generationMs: 2000, ttftMs: 4000, estimated: false,
    });
  });

  it("does not measure a cancelled response", () => {
    const controller = new AbortController(); controller.abort();
    buildOnStreamComplete({ provider: "p", model: "m", requestStartTime: 1000, body: {}, signal: controller.signal })
      .onStreamComplete({}, { completion_tokens: 20 }, 5000, 5000);
    expect(telemetry.performance).not.toHaveBeenCalled();
  });
});

it("uses the fastest measured provider in a group and retains sample provenance", () => {
  const result = summarizeGroup({ providers: [
    { providerAlias: "a", health: { tokensPerSecond: 20, speedSamples: 10, avgTtft: 500 } },
    { providerAlias: "b", health: { tokensPerSecond: 80, speedSamples: 2, avgTtft: 1000 } },
    { providerAlias: "unmeasured", health: {} },
  ] });
  expect(result).toMatchObject({ tokensPerSecond: 80, speedProvider: "b", speedSamples: 2, avgTtft: 1000 });
  expect(summarizeGroup({ providers: [] }).tokensPerSecond).toBeNull();
});

it("exports throughput, first-output latency and sample size", () => {
  const csv = buildCatalogCsv([{ name: "model", providers: [{ id: "m", providerAlias: "p", health: { tokensPerSecond: 80, avgTtft: 1000, speedSamples: 2 } }] }]);
  expect(csv.split("\n")[0]).toContain("output_tokens_per_second,time_to_first_output_ms,speed_samples_24h");
  expect(csv.split("\n")[1]).toMatch(/,80,1000,2$/);
});
