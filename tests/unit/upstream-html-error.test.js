// Edge providers answer with an HTML page (Cloudflare interstitial, nginx error
// page) when they reject or challenge a request. Those bytes used to reach the
// client verbatim through BaseExecutor.parseError → parseUpstreamError, so a
// 500-character markup blob became the user-visible error message.
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock before importing the executor so its network call is fully scripted.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));

const { parseUpstreamError, sanitizeUpstreamBody, errorResponse, unavailableResponse, writeStreamError } = await import("../../open-sse/utils/error.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");

const INTERSTITIAL = `<!DOCTYPE html><html><head><title>503 Service Temporarily Unavailable</title></head>
<body><h1>Please wait while your request is being verified...</h1>
<div id="cf-challenge">cloudflare</div><script>var x=1;</script></body></html>`;

describe("sanitizeUpstreamBody", () => {
  it("extracts the page title instead of echoing markup", () => {
    expect(sanitizeUpstreamBody(INTERSTITIAL, "text/html")).toBe("503 Service Temporarily Unavailable");
  });

  it("falls back to the first heading when there is no title", () => {
    expect(sanitizeUpstreamBody("<html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>", "text/html"))
      .toBe("502 Bad Gateway");
  });

  it("keeps a short plain-text body as-is", () => {
    expect(sanitizeUpstreamBody("Upstream rejected the request", "text/plain"))
      .toBe("Upstream rejected the request");
  });

  it("names the shape when markup carries no readable text", () => {
    expect(sanitizeUpstreamBody("<html><body><div></div></body></html>", "text/html"))
      .toMatch(/^HTML error page/);
  });

  it("never returns markup for an empty body", () => {
    expect(sanitizeUpstreamBody("", "text/html")).toBe("");
  });
});

describe("error parsing", () => {
  it("sanitizes an HTML error page and names the delivered status", async () => {
    const response = new Response(INTERSTITIAL, { status: 502, headers: { "content-type": "text/html" } });
    const parsed = await parseUpstreamError(response, new BaseExecutor("apinex", {}));
    expect(parsed.statusCode).toBe(502);
    expect(parsed.message).toBe("HTTP 502 from the edge: 503 Service Temporarily Unavailable");
    expect(parsed.message).not.toContain("<");
  });

  it("keeps a provider's own JSON error message intact", async () => {
    const body = JSON.stringify({ error: { message: "Insufficient balance", type: "billing_error" } });
    const response = new Response(body, { status: 402, headers: { "content-type": "application/json" } });
    const parsed = await parseUpstreamError(response, new BaseExecutor("apinex", {}));
    expect(parsed).toMatchObject({ statusCode: 402, message: "Insufficient balance" });
  });

  it("reports the real HTTP status, not a status printed inside the page", async () => {
    // The page says 503; the router was answered with 502. The router's own
    // status is what callers branch on — the text must not contradict it.
    const response = new Response(INTERSTITIAL, { status: 502, headers: { "content-type": "text/html" } });
    const parsed = await parseUpstreamError(response, new BaseExecutor("apinex", {}));
    expect(parsed.statusCode).toBe(502);
  });
});

describe("HTML interstitial retry policy", () => {
  const html = (status = 200) => () => new Response(INTERSTITIAL, { status, headers: { "content-type": "text/html; charset=UTF-8" } });
  const json = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });

  const run = (retry) => new BaseExecutor("apinex", { baseUrl: "https://edge.test/v1/chat/completions", retry }).execute({
    model: "m", body: { messages: [] }, stream: false, credentials: { apiKey: "k" },
  });

  beforeEach(() => fetchMock.mockReset());

  it("retries a 2xx HTML page and then answers a clean 502", async () => {
    fetchMock.mockImplementation(html());
    const out = await run({ 502: { attempts: 2, delayMs: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.response.status).toBe(502);
    const parsed = await parseUpstreamError(out.response, new BaseExecutor("apinex", {}));
    expect(parsed.statusCode).toBe(502);
    expect(parsed.message).toBe("Edge HTML page instead of a completion: 503 Service Temporarily Unavailable");
    expect(parsed.message).not.toContain("<");
  });

  it("uses the retry after a challenge page when the provider recovers", async () => {
    fetchMock.mockImplementationOnce(html()).mockImplementation(json);
    const out = await run({ 502: { attempts: 2, delayMs: 0 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    expect((await out.response.json()).choices[0].message.content).toBe("ok");
  });
});

describe("client error boundary for Cloudflare pages", () => {
  const page = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<html><head><title>apinex.bond | 502: Bad gateway</title></head>
<body><div>2026-10-11 09:48:22 UTC</div><div class="cf-error-source">Host error</div>
${"<div>Cloudflare layout</div>".repeat(200)}</body></html>`;
  const prefix = "[openai-compatible-chat-a7560c5d-68ba-4525-a8e5-d0af3ea77fad/free/minimax-m3.1] [502]:";
  const message = prefix + " " + page;

  it("cleans a persisted upstream 502 surfaced as account-unavailable 503", async () => {
    const response = unavailableResponse(503, message, new Date(Date.now()+60000).toISOString(), "reset after 60s");
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toBe(prefix + " apinex.bond | 502: Bad gateway (reset after 60s)");
  });

  it("cleans HTML nested inside a JSON provider error before returning it to the client", async () => {
    const parsed = await parseUpstreamError(Response.json({error:{message:page}}, {status:502}), new BaseExecutor("apinex", {}));
    const response = errorResponse(parsed.statusCode, parsed.message);
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe("apinex.bond | 502: Bad gateway");
  });

  it("also cleans the final SSE error message", async () => {
    const write = vi.fn(async () => {});
    await writeStreamError({write},503,message);
    const text = new TextDecoder().decode(write.mock.calls[0][0]);
    expect(text).toContain("apinex.bond | 502: Bad gateway");
    expect(text).not.toContain("<html");
    expect(text).not.toContain("DOCTYPE");
  });

  it("preserves plain diagnostic messages including schema notation", async () => {
    const message = "Invalid argument <parameter>: " + "details ".repeat(100);
    expect((await errorResponse(400,message).json()).error.message).toBe(message);
  });
});
