import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: Response.json } }));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn() }));

import { POST as validate } from "../../src/app/api/providers/validate/route.js";

let fetchMock;

function validateKey(provider, apiKey) {
  return validate(new Request("https://9router.test/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  }));
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["typesafe", "https://api.typesafe.ai/v1/systemone", "jev-latest"],
  ["v1m", "https://v1m.ir/v1/systemone", "rev-latest"],
])("System One key validation (%s)", (provider, url, model) => {
  it("accepts a working key via a decision-shaped probe", async () => {
    const res = await validateKey(provider, "good-key");
    expect(await res.json()).toEqual({ valid: true, error: null });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer good-key");
    expect(JSON.parse(options.body)).toEqual({
      model,
      state: "ping",
      questions: { ping: { type: "noul", instructions: "Is this a connection test?" } },
    });
  });

  it("rejects a key the upstream refuses (401)", async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ detail: { message: "Cannot authenticate with the server." } }),
      { status: 401 },
    ));
    const res = await validateKey(provider, "bad-key");
    expect(await res.json()).toEqual({ valid: false, error: "Invalid API key" });
  });

  it("treats non-auth failures (422) as key accepted", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 422 }));
    const res = await validateKey(provider, "good-key");
    expect(await res.json()).toEqual({ valid: true, error: null });
  });
});
