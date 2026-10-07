import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BaseExecutor calls proxyAwareFetch, which keeps its own native fetch reference.
// Mock that network boundary too so executor-backed image tests stay offline.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => globalThis.fetch(...args),
  default: (...args) => globalThis.fetch(...args),
}));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { handleVideoProxyCore } from "../../open-sse/handlers/videoCore.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

const credentials = { apiKey: "test-key" };
const log = { info() {}, warn() {}, debug() {}, error() {} };
const bytes = new Uint8Array([0, 255, 12, 0, 129, 10]);
const b64 = Buffer.from(bytes).toString("base64");

function expectHeaders(response, provider, model) {
  expect(response.headers.get("x-9router-provider")).toBe(provider);
  expect(response.headers.get("x-9router-model")).toBe(model);
  expect(response.headers.get("access-control-expose-headers")).toContain("X-9Router-Provider");
  if (model) expect(response.headers.get("access-control-expose-headers")).toContain("X-9Router-Model");
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("media response identity", () => {
  it("uses the model actually dispatched by the Antigravity image executor", async () => {
    fetch.mockResolvedValueOnce(Response.json({ response: { candidates: [{ content: { parts: [{ inlineData: { data: b64 } }] } }] } }));
    const result = await handleImageGenerationCore({
      body: { prompt: "Draw a square", size: "1024x1024" },
      modelInfo: { provider: "antigravity", model: "chat-model" },
      credentials: { accessToken: "test-token", projectId: "test-project" },
    });
    expect(result.success, result.error).toBe(true);
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.model).toBe("gemini-3.1-flash-image");
    expectHeaders(result.response, "antigravity", sent.model);
    expect(await result.response.json()).toMatchObject({ provider: "antigravity", model: sent.model, data: [{ b64_json: b64 }] });
  });

  it.each([null, "actual-checkpoint"])("uses the SD WebUI checkpoint when reported, not the ignored client model (%s)", async model => {
    fetch.mockResolvedValueOnce(Response.json({ images: [b64], info: JSON.stringify({ sd_model_name: model }) }));
    const result = await handleImageGenerationCore({ body: { prompt: "Draw a square" }, modelInfo: { provider: "sdwebui", model: "client-alias" }, credentials: {} });
    expect(result.success).toBe(true);
    expectHeaders(result.response, "sdwebui", model);
    expect(await result.response.json()).toMatchObject({ provider: "sdwebui", model, data: [{ b64_json: b64 }] });
  });

  it.each([false, true])("preserves the actual Gemini image model before normalization (binary=%s)", async binaryOutput => {
    fetch.mockResolvedValueOnce(Response.json({
      modelVersion: "gemini-image-revision",
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: b64 } }] } }],
    }));
    const result = await handleImageGenerationCore({
      body: { prompt: "Draw a square" }, modelInfo: { provider: "gemini", model: "gemini-image-alias" },
      credentials, binaryOutput,
    });
    expect(result.success).toBe(true);
    expectHeaders(result.response, "gemini", "gemini-image-revision");
    if (binaryOutput) {
      expect(result.response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(bytes);
    } else {
      expect(await result.response.json()).toMatchObject({ provider: "gemini", model: "gemini-image-revision", data: [{ b64_json: b64 }] });
    }
  });

  it.each([false, true])("reports the successful image Combo fallback (binary=%s)", async binaryOutput => {
    fetch.mockResolvedValueOnce(new Response("quota exhausted", { status: 429 }));
    fetch.mockResolvedValueOnce(Response.json({ created: 123, model: "image-revision", data: [{ b64_json: b64 }] }));
    const result = await handleComboChat({
      body: { model: "ImageCombo", prompt: "Draw a square" }, models: ["xai/grok-imagine-image", "openai/gpt-image-1"], log,
      comboName: "ImageCombo", skipCooldown: true,
      handleSingleModel: async (body, id) => {
        const [provider, model] = id.split("/");
        return (await handleImageGenerationCore({ body, modelInfo: { provider, model }, credentials, binaryOutput })).response;
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expectHeaders(result, "openai", "image-revision");
    if (binaryOutput) expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    else expect(await result.json()).toMatchObject({ provider: "openai", model: "image-revision", data: [{ b64_json: b64 }] });
  });

  it.each([false, true])("uses the Codex image tool model for generation/edit output (stream=%s)", async streamToClient => {
    fetch.mockResolvedValueOnce(new Response([
      'event: response.created\ndata: {"response":{"model":"controller-model"}}\n\n',
      `event: response.output_item.done\ndata: ${JSON.stringify({ item: { type: "image_generation_call", result: b64 } })}\n\n`,
    ].join(""), { headers: { "content-type": "text/event-stream" } }));
    const result = await handleImageGenerationCore({
      body: { prompt: "Make it blue", image: `data:image/png;base64,${b64}` },
      modelInfo: { provider: "codex", model: "gpt-image-2" }, credentials: { accessToken: "test-token" }, streamToClient,
    });
    expect(result.success).toBe(true);
    expectHeaders(result.response, "codex", "gpt-image-2");
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.tools[0]).toMatchObject({ type: "image_generation", model: "gpt-image-2", action: "edit" });
    if (streamToClient) {
      const events = (await result.response.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(event).toMatchObject({ provider: "codex", model: "gpt-image-2" });
      expect(events.at(-1).data).toEqual([{ b64_json: b64 }]);
    } else {
      expect(await result.response.json()).toMatchObject({ provider: "codex", model: "gpt-image-2", data: [{ b64_json: b64 }] });
    }
  });

  it.each(["mp3", "json"])("keeps the actual TTS model after Combo fallback and voice parsing (%s)", async responseFormat => {
    fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    fetch.mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "audio/mpeg" } }));
    const result = await handleComboChat({
      body: { model: "SpeechCombo", input: "Hello" }, models: ["elevenlabs/voice", "openai/tts-1/alloy"], log,
      comboName: "SpeechCombo", skipCooldown: true,
      handleSingleModel: async (body, id) => {
        const slash = id.indexOf("/");
        return (await handleTtsCore({ provider: id.slice(0, slash), model: id.slice(slash + 1), input: body.input, credentials, responseFormat })).response;
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ model: "tts-1", voice: "alloy" });
    expectHeaders(result, "openai", "tts-1");
    if (responseFormat === "json") expect(await result.json()).toEqual({ provider: "openai", model: "tts-1", audio: b64, format: "mp3" });
    else {
      expect(result.headers.get("content-length")).toBe(String(bytes.length));
      expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    }
  });

  it.each(["text/plain", "application/json"])("decorates transcription without changing its format (%s)", async contentType => {
    const text = "Привет\n";
    fetch.mockResolvedValueOnce(new Response(contentType === "application/json" ? JSON.stringify({ text, model: "whisper-revision" }) : text, { headers: { "content-type": contentType } }));
    const formData = new FormData();
    formData.set("file", new Blob([bytes], { type: "audio/wav" }), "speech.wav");
    const result = await handleSttCore({
      provider: "openai", model: "whisper-1", formData, credentials,
      sttConfig: { baseUrl: "https://upstream.test/transcriptions", format: "openai", authType: "apiKey", authHeader: "bearer" },
    });
    expect(result.success).toBe(true);
    expectHeaders(result.response, "openai", contentType === "application/json" ? "whisper-revision" : "whisper-1");
    if (contentType === "application/json") expect(await result.response.json()).toEqual({ text, model: "whisper-revision", provider: "openai" });
    else expect(await result.response.text()).toBe(text);
  });

  it("keeps the upstream embedding model and vectors", async () => {
    const data = [{ object: "embedding", index: 0, embedding: [0.25, -0.5] }];
    fetch.mockResolvedValueOnce(Response.json({ object: "list", model: "embedding-revision", data, usage: { prompt_tokens: 2, total_tokens: 2 } }));
    const result = await handleEmbeddingsCore({ body: { input: "hello" }, modelInfo: { provider: "openai", model: "text-embedding-3-small" }, credentials });
    expect(result.success).toBe(true);
    expectHeaders(result.response, "openai", "embedding-revision");
    expect(await result.response.json()).toMatchObject({ provider: "openai", model: "embedding-revision", data });
  });

  it("keeps the Gemini transcription revision before normalizing its text", async () => {
    fetch.mockResolvedValueOnce(Response.json({ modelVersion: "gemini-stt-revision", candidates: [{ content: { parts: [{ text: "Hello" }] } }] }));
    const formData = new FormData();
    formData.set("file", new Blob([bytes], { type: "audio/wav" }), "speech.wav");
    const result = await handleSttCore({
      provider: "gemini", model: "gemini-alias", formData, credentials,
      sttConfig: { baseUrl: "https://upstream.test/models", format: "gemini-stt", authType: "apikey" },
    });
    expectHeaders(result.response, "gemini", "gemini-stt-revision");
    expect(await result.response.json()).toEqual({ provider: "gemini", model: "gemini-stt-revision", text: "Hello" });
  });

  it("preserves the upstream model revision in chat-based web search", async () => {
    fetch.mockResolvedValueOnce(Response.json({ modelVersion: "gemini-search-revision", candidates: [{ content: { parts: [{ text: "An answer" }] } }] }));
    const result = await handleSearchCore({ body: { query: "A question" }, provider: { id: "gemini", searchViaChat: { defaultModel: "gemini-alias" } }, credentials });
    expect(result.success).toBe(true);
    expectHeaders(result.response, "gemini", "gemini-search-revision");
    expect(await result.response.json()).toMatchObject({ provider: "gemini", model: "gemini-search-revision", answer: { text: "An answer", model: "gemini-search-revision" } });
  });

  it("reports video creation identity and preserves the asynchronous job", async () => {
    fetch.mockResolvedValueOnce(Response.json({ request_id: "job-test", status: "pending" }, { status: 202 }));
    const result = await handleVideoProxyCore({ provider: "xai", action: "generations", rawBody: JSON.stringify({ model: "grok-imagine-video", prompt: "A square" }), contentType: "application/json", credentials });
    expect(result.response.status).toBe(202);
    expectHeaders(result.response, "xai", "grok-imagine-video");
    expect(await result.response.json()).toEqual({ provider: "xai", model: "grok-imagine-video", request_id: "job-test", status: "pending" });
  });

  it("does not invent a model when a video poll does not report it", async () => {
    fetch.mockResolvedValueOnce(Response.json({ request_id: "job-test", status: "pending" }));
    const result = await handleVideoProxyCore({ provider: "xai", requestId: "job-test", credentials });
    expectHeaders(result.response, "xai", null);
    expect(await result.response.json()).toMatchObject({ provider: "xai", model: null, request_id: "job-test" });
  });
});
