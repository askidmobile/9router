import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ credentials: vi.fn(), lock: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}) }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials, markAccountUnavailable: mocks.lock,
  clearAccountError: vi.fn(), extractApiKey: () => null, isValidApiKey: () => true,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (id) => ({ provider: "gemini", model: id.slice("gemini/".length) }),
  getComboModels: async () => null,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(), checkAndRefreshToken: vi.fn(),
}));
const { handleChat } = await import("../../src/sse/handlers/chat.js");
beforeEach(() => { vi.clearAllMocks(); });

describe("AI Studio client tier errors do not lock accounts", () => {
  it.each([
    { model: "gemini/gemini-3.8-flash:flex", service_tier: "standard" },
    { model: "gemini/gemini-3.8-flash", service_tier: "free" },
    { model: "gemini/gemini-3.8-flash", service_tier: "flex", serviceTier: "priority" },
  ])("returns HTTP400 before account selection for $model", async (body) => {
    const response = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });
});
