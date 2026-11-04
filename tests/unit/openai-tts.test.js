import { describe, expect, it, vi, afterEach } from "vitest";
import openaiTts from "../../open-sse/handlers/ttsProviders/openai.js";

function mockFetch(response) {
  const spy = vi.fn(async () => response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

const audio = () => new Response(new Uint8Array(256), { status: 200, headers: { "content-type": "audio/mpeg" } });

describe("OpenAI TTS model/voice parsing", () => {
  it("treats a bare model id as the model, not the voice", async () => {
    const spy = mockFetch(audio());
    const result = await openaiTts.synthesize("hello", "tts-1", { apiKey: "k" });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.model).toBe("tts-1");
    expect(body.voice).toBe("alloy");
    expect(result.model).toBe("tts-1");
  });

  it("accepts model/voice", async () => {
    const spy = mockFetch(audio());
    await openaiTts.synthesize("hello", "tts-1-hd/nova", { apiKey: "k" });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "tts-1-hd", voice: "nova" });
  });

  it("keeps the legacy bare-voice form", async () => {
    const spy = mockFetch(audio());
    await openaiTts.synthesize("hello", "nova", { apiKey: "k" });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-4o-mini-tts");
    expect(body.voice).toBe("nova");
  });

  it("defaults the voice when only the model is provided", async () => {
    const spy = mockFetch(audio());
    await openaiTts.synthesize("hello", "gpt-4o-mini-tts", { apiKey: "k" });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "alloy" });
  });
});
