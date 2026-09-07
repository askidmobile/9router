import { afterAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(() => true) }));
vi.mock("undici", () => ({
  Agent: class { dispatch(...args) { return mocks.dispatch(...args); } },
  ProxyAgent: class { dispatch(...args) { return mocks.dispatch(...args); } },
}));
const originalFetch = globalThis.fetch;
globalThis.fetch = vi.fn(async (_url, options) => {
  const dispatchOptions = { origin: "https://example.com", path: "/", method: "GET" };
  if (options.dispatcher) options.dispatcher.dispatch(dispatchOptions, {});
  else mocks.dispatch(dispatchOptions, {});
  return new Response("ok");
});
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
afterAll(() => { globalThis.fetch = originalFetch; });

describe("per-request dispatcher timeouts", () => {
  it.each([
    ["direct", { connectionProxyEnabled: false }],
    ["proxy", { connectionProxyEnabled: true, connectionProxyUrl: "http://localhost:3128" }],
    ["relay", { vercelRelayUrl: "https://relay.example.com" }],
  ])("extends the %s request without changing the next ordinary request", async (_, proxyOptions) => {
    mocks.dispatch.mockClear();
    await proxyAwareFetch("https://example.com", { headersTimeout: 900000, bodyTimeout: 900000 }, proxyOptions);
    await proxyAwareFetch("https://example.com", {}, proxyOptions);
    expect(mocks.dispatch.mock.calls[0][0]).toMatchObject({ headersTimeout: 900000, bodyTimeout: 900000 });
    expect(mocks.dispatch.mock.calls[1][0].headersTimeout).toBeUndefined();
    expect(mocks.dispatch.mock.calls[1][0].bodyTimeout).toBeUndefined();
  });
});
