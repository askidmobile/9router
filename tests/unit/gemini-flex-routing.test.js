import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GEMINI_FLEX_TIMEOUT_MS } from "../../open-sse/config/gemini.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => mocks.fetch(...args) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => Object.fromEntries(["logClientRawRequest", "logRawRequest", "logTargetRequest", "logProviderResponse", "logConvertedResponse", "logError"].map((name) => [name, vi.fn()])),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const googleReply = {
  candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP", index: 0 }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
};
const googleResponse = () => new Response(JSON.stringify(googleReply), { headers: { "content-type": "application/json" } });
beforeEach(() => { mocks.fetch.mockReset().mockImplementation(async () => googleResponse()); });
afterEach(() => vi.useRealTimers());

async function run(model, body, sourceFormatOverride) {
  return handleChatCore({
    modelInfo: { provider: "gemini", model }, body: { model, stream: false, ...body }, sourceFormatOverride,
    credentials: { apiKey: "test-key", providerSpecificData: {} }, connectionId: "studio-test",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
  });
}
const chat = { messages: [{ role: "user", content: "hello" }] };

describe("AI Studio tier through chatCore and the real executor", () => {
  it.each([
    ["chat", chat, "openai"],
    ["responses", { input: "hello" }, "openai-responses"],
    ["claude", { max_tokens: 64, messages: [{ role: "user", content: "hello" }] }, "claude"],
    ["native", { contents: [{ role: "user", parts: [{ text: "hello" }] }] }, "gemini"],
  ])("routes a Flex variant from %s to a canonical Google model with a top-level tier", async (_, body, format) => {
    const result = await run("gemini-3.8-flash:flex", body, format);
    expect(result.response.status).toBe(200);
    await result.response.text();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(options.headers["x-goog-api-key"]).toBe("test-key");
    const sent = JSON.parse(options.body);
    expect(sent.model).toBe("gemini-3.8-flash");
    expect(sent.serviceTier).toBe("flex");
    expect(sent.service_tier).toBeUndefined();
    expect(sent.generationConfig?.serviceTier).toBeUndefined();
    expect(options.headersTimeout).toBe(GEMINI_FLEX_TIMEOUT_MS);
    expect(options.bodyTimeout).toBe(GEMINI_FLEX_TIMEOUT_MS);
  });

  it("supports service_tier on the normal model and preserves ordinary Standard requests", async () => {
    await run("gemini-3.8-flash", { ...chat, service_tier: "flex" });
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).serviceTier).toBe("flex");
    await run("models/gemini-3.8-flash", chat);
    const [url, options] = mocks.fetch.mock.calls[1];
    expect(url).not.toContain("/models/models/");
    expect(JSON.parse(options.body).serviceTier).toBeUndefined();
    expect(options.headersTimeout).toBeUndefined();
    expect(new DefaultExecutor("gemini").getRequestTimeoutMs("gemini-3.8-flash", {})).toBe(FETCH_CONNECT_TIMEOUT_MS);
  });

  it("maps the OpenAI default tier to standard and preserves native serviceTier", async () => {
    await run("gemini-3.8-flash", { ...chat, service_tier: "default" });
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).serviceTier).toBe("standard");
    await run("gemini-3.8-flash", { contents: [{ role: "user", parts: [{ text: "hello" }] }], serviceTier: "flex" }, "gemini");
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).serviceTier).toBe("flex");
  });

  it.each([
    ["gemini-3.8-flash:flex", { service_tier: "standard" }],
    ["gemini-3.8-flash", { service_tier: "flex", serviceTier: "priority" }],
    ["gemini-3.8-flash", { service_tier: "free" }],
  ])("rejects conflicting or unsupported tiers before sending %s", async (model, extra) => {
    const result = await run(model, { ...chat, ...extra });
    expect(result.response.status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("streams Flex and preserves the tier in the outgoing request", async () => {
    mocks.fetch.mockResolvedValue(new Response(`data: ${JSON.stringify(googleReply)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const result = await run("gemini-3.8-flash:flex(high)", { ...chat, stream: true });
    const text = await result.response.text();
    expect(text).toContain("ok");
    expect(text).toContain('"finish_reason":"stop"');
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toContain("/gemini-3.8-flash:streamGenerateContent?alt=sse");
    expect(JSON.parse(options.body).serviceTier).toBe("flex");
    expect(JSON.parse(options.body).generationConfig.thinkingConfig).toBeDefined();
  });

  it("does not upgrade unavailable Flex to Standard", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "Flex capacity unavailable" } }), { status: 503 }));
    const pending = run("gemini-3.8-flash:flex", chat);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.response.status).toBe(503);
    expect(mocks.fetch.mock.calls.length).toBeGreaterThan(0);
    for (const [, options] of mocks.fetch.mock.calls) expect(JSON.parse(options.body).serviceTier).toBe("flex");
  });

  it("keeps waiting for a queued Flex request beyond the normal connection timeout", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      setTimeout(() => resolve(googleResponse()), FETCH_CONNECT_TIMEOUT_MS + 10_000);
    }));
    const executor = new DefaultExecutor("gemini");
    const pending = executor.execute({ model: "gemini-3.8-flash", body: { serviceTier: "flex" }, stream: false, credentials: { apiKey: "test-key" } });
    await vi.advanceTimersByTimeAsync(FETCH_CONNECT_TIMEOUT_MS + 10_001);
    expect((await pending).response.status).toBe(200);
  });
});
