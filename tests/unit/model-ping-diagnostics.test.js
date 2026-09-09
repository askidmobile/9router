import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => []) }));
vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "test-cli-token") }));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");

describe("model ping response diagnostics", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["llm", "embedding", "image", "stt"])("preserves a body-read abort after HTTP 200 for %s", async (kind) => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/json" } }));

    const result = await pingModelByKind("openai/test", kind);

    expect(result).toMatchObject({
      ok: false,
      status: 200,
      error: "Failed to read response body: AbortError: The operation was aborted.",
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves a request timeout before response headers", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    const result = await pingModelByKind("openai/test", "llm");

    expect(result).toMatchObject({ ok: false, error: "TimeoutError: The operation was aborted due to timeout" });
    expect(result).not.toHaveProperty("status");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports unexpected SSE as invalid JSON instead of missing choices", async () => {
    fetchMock.mockResolvedValue(new Response(': keepalive\n\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const result = await pingModelByKind("openai/test", "llm");

    expect(result).toMatchObject({ ok: false, status: 200 });
    expect(result.error).toMatch(/Invalid JSON response.*text\/event-stream/);
    expect(result.error).not.toMatch(/no completion choices/);
  });

  it.each([
    ["", "Empty response body"],
    ['{"choices":', "Invalid JSON response"],
  ])("distinguishes incomplete response %j from a valid completion", async (body, error) => {
    fetchMock.mockResolvedValue(new Response(body, { headers: { "Content-Type": "application/json" } }));

    const result = await pingModelByKind("openai/test", "llm");

    expect(result).toMatchObject({ ok: false, status: 200 });
    expect(result.error).toContain(error);
  });

  it("keeps the specific diagnostic for valid JSON with no completion choices", async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [] }));

    expect(await pingModelByKind("openai/test", "llm")).toMatchObject({
      ok: false,
      status: 200,
      error: "Provider returned no completion choices for this model",
    });
  });

  it("retains the HTTP error when an intermediary returns plain text", async () => {
    fetchMock.mockResolvedValue(new Response("upstream unavailable", { status: 503 }));

    expect(await pingModelByKind("openai/test", "llm")).toMatchObject({
      ok: false,
      status: 503,
      error: "HTTP 503: upstream unavailable",
    });
  });

  it("includes body-read time in successful probe latency", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => {
        now = 1750;
        return JSON.stringify({ choices: [{ message: { content: "Hi" } }] });
      },
    });

    expect(await pingModelByKind("openai/test", "llm")).toMatchObject({ ok: true, latencyMs: 750 });
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe("application/json");
  });
});
