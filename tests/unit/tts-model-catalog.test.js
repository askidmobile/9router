import { describe, expect, it } from "vitest";
import { getTtsModels } from "@/shared/utils/ttsModels.js";

describe("TTS models shared by cards and the example selector", () => {
  it("exposes OpenAI models with their routing IDs", () => {
    const models = getTtsModels("openai");
    expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]));
    expect(models.every((m) => m.kind === "tts")).toBe(true);
    expect(models.some((m) => m.id === "alloy")).toBe(false);
  });

  it("uses a provider's configured catalog when the registry has no model entries", () => {
    expect(getTtsModels("cartesia").map((m) => m.id)).toEqual(["sonic-2", "sonic-3"]);
  });

  it.each(["google-tts", "edge-tts", "local-device"])("does not offer language or voice IDs as models for %s", (provider) => {
    expect(getTtsModels(provider)).toEqual([]);
  });
});
