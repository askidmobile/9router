import { describe, expect, it, vi } from "vitest";

const { core, resolveProxy } = vi.hoisted(() => ({ core: vi.fn(), resolveProxy: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: resolveProxy }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/auth.js", () => ({
  extractApiKey: vi.fn(), isValidApiKey: vi.fn(), getProviderCredentials: async () => null, markAccountUnavailable: vi.fn(),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "ollama-local", model: "phonon" }), getComboModels: async () => null,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({ getKeyAccessContext: vi.fn(), enforceKeyAccess: vi.fn() }));
vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: core }));
import { handleTts } from "../../src/sse/handlers/tts.js";

describe("Ollama TTS without saved credentials", () => {
  it("preserves the provider proxy policy on the default-host fallback", async () => {
    const policy = { proxyRequired: true, strictProxy: true, useEnvProxy: false };
    resolveProxy.mockResolvedValue(policy);
    const response = new Response("fixture audio");
    core.mockResolvedValue({ success: true, response });
    expect(await handleTts(new Request("http://localhost/v1/audio/speech", {
      method: "POST", body: JSON.stringify({ model: "ollama-local/phonon", input: "hello" }),
    }))).toBe(response);
    expect(resolveProxy).toHaveBeenCalledWith({}, "ollama-local");
    expect(core).toHaveBeenCalledWith(expect.objectContaining({ credentials: { providerSpecificData: { proxyConfig: policy } } }));
  });
});
