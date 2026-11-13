import { expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] }));
vi.mock("undici", () => {
  class Dispatcher {
    constructor(options) { this.options = options; }
  }
  return {
    Agent: Dispatcher,
    ProxyAgent: Dispatcher,
    fetch: async (url, { dispatcher }) => {
      calls.push({ url: String(url), dispatcher });
      return new Response("{}");
    },
  };
});

it("uses the AWS OIDC TLS curve for refresh, proxy tunnels and Kiro login only", async () => {
  const original = globalThis.fetch;
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  try {
    const aws = "https://oidc.us-east-1.amazonaws.com/token";
    const proxy = { enabled: true, url: "http://127.0.0.1:3128", strictProxy: true, useEnvProxy: false };
    await proxyAwareFetch(aws, { method: "POST" }, { useEnvProxy: false });
    await proxyAwareFetch(aws, { method: "POST" }, proxy);
    await globalThis.fetch("https://oidc.eu-west-1.amazonaws.com/client/register");
    await proxyAwareFetch("https://oidc.us-east-1.amazonaws.com.example.test/token", {}, proxy);
    expect(calls[0].dispatcher.options.connect.ecdhCurve).toBe("X25519:P-256");
    expect(calls[1].dispatcher.options.requestTls).toMatchObject({ ecdhCurve: "X25519:P-256" });
    expect(calls[1].dispatcher.options.requestTls.rejectUnauthorized).not.toBe(false);
    expect(calls[2].dispatcher).toBe(calls[0].dispatcher);
    expect(calls[3].dispatcher).not.toBe(calls[1].dispatcher);
    expect(calls[3].dispatcher.options.requestTls.ecdhCurve).not.toBe("X25519:P-256");
  } finally {
    globalThis.fetch = original;
  }
});
