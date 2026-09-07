import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getApiKeys: async () => [{ key: "test-key", isActive: true }] }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "cli-token" }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));

describe("AI Studio model test timeout", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    mocks.fetch.mockReset().mockImplementation(async () => response());
    vi.spyOn(AbortSignal, "timeout");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(["gemini/gemini-3.8-flash:flex", "gemini/models/gemini-3.8-flash:flex(thinking)"])("allows Flex queueing for %s", async (model) => {
    expect((await pingModelByKind(model, "llm")).ok).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/chat/completions"), expect.objectContaining({
      headersTimeout: 900000, bodyTimeout: 900000,
    }));
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).model).toBe(model);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(900000);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["gemini/gemini-3.8-flash", "openai/example:flex"])("keeps the ordinary timeout for %s", async (model) => {
    expect((await pingModelByKind(model, "llm")).ok).toBe(true);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15000);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
