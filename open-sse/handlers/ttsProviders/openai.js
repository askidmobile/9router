// OpenAI TTS — model format: "tts-model/voice" (a bare voice keeps the default model).
import { Buffer } from "node:buffer";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../providers/index.js";
import { getTtsVoicesForModel } from "../../config/ttsModels.js";
import { parseModelVoice } from "./_base.js";

const DEFAULT_TTS_MODEL = PROVIDER_MEDIA["openai"]?.ttsConfig?.defaultModel;

function ttsModels() {
  return (PROVIDER_MODELS.openai || []).filter((m) => (m.kind || m.type) === "tts");
}

export default {
  async synthesize(text, model, credentials) {
    if (!credentials?.apiKey) throw new Error("No OpenAI API key configured");
    // Legacy form: a bare voice id keeps the default model.
    if (model && !model.includes("/") && !ttsModels().some((m) => m.id === model)) {
      model = `${DEFAULT_TTS_MODEL}/${model}`;
    }

    const known = ttsModels();
    const { modelId, voiceId } = parseModelVoice(model, DEFAULT_TTS_MODEL, "", known);
    const ttsModel = modelId || DEFAULT_TTS_MODEL;
    const knownVoice = (getTtsVoicesForModel("openai", ttsModel) || []).some((v) => v.id === voiceId);
    const voice = knownVoice ? voiceId : "alloy";

    const baseUrl = (credentials.baseUrl || "https://api.openai.com").replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${credentials.apiKey}` },
      body: JSON.stringify({ model: ttsModel, voice, input: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString("base64"), format: "mp3", model: ttsModel };
  },
};
