// Locks BaseExecutor.execute retry/fallback behavior (docs 04 GAP #1, docs 11 §7).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network layer so we can script upstream responses.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { isUpstreamTimeoutError, createUpstreamTimeoutError } = await import("../../open-sse/utils/abort.js");

function res(status) {
  return { status, headers: { get: () => "" } };
}

function makeExec(config) {
  const ex = new BaseExecutor("test", config);
  // make headers trivial; credentials empty
  return ex;
}

const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("BaseExecutor.execute — retry by status (config-driven)", () => {
  it("retries 502 `attempts` times then succeeds", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(502))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after exhausting 502 attempts on a single url and throws", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 2, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(502));
    // single url: 1 initial + 2 retries = 3 calls, then returns the 502 response (no fallback url)
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("BaseExecutor.execute — caller deadline", () => {
  it("honors Retry-After instead of reconnecting before the provider allows it", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 2, delayMs: 0 } } });
    fetchMock.mockImplementation(async () => new Response("Unavailable", {
      status: 503, headers: { "retry-after": "120" },
    }));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      requestPolicy: { maxRetries: 1, deadlineAtMs: Date.now() + 60_000, retryStatuses: [502, 503] },
    });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps a caller's retries without changing the direct provider policy", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockImplementation(async () => new Response("Unavailable", { status: 503 }));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      requestPolicy: { maxRetries: 1, deadlineAtMs: Date.now() + 60_000 },
    });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries only the statuses the caller allows", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 429: { attempts: 2, delayMs: 0 }, 503: { attempts: 2, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      requestPolicy: { deadlineAtMs: Date.now() + 60_000, retryStatuses: [502, 503] },
    });
    expect(out.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 inside the caller's window", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 2, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      requestPolicy: { deadlineAtMs: Date.now() + 60_000, retryStatuses: [502, 503] },
    });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("declines a retry whose delay does not fit the window", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 2, delayMs: 5_000 } } });
    fetchMock.mockResolvedValue(res(503));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      requestPolicy: { deadlineAtMs: Date.now() + 1_000, retryStatuses: [502, 503] },
    });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — baseUrls fallback", () => {
  it("falls over to the next url on 429 (shouldRetry)", async () => {
    const ex = makeExec({ baseUrls: ["https://a/api", "https://b/api"], retry: { 429: { attempts: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(429)) // url[0] → fallback
      .mockResolvedValueOnce(res(200)); // url[1] ok
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("BaseExecutor.execute — network error retry/fallback", () => {
  it("maps network exception to 502 retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 1, delayMs: 0 } } });
    fetchMock
      .mockImplementationOnce(async () => { throw new Error("ECONNRESET"); })
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the only url fails with network error and no retries left", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 0 } } });
    // mockImplementationOnce (not persistent) avoids vitest flagging a reused rejection.
    fetchMock.mockImplementationOnce(async () => { throw new Error("boom"); });
    let thrown = null;
    try {
      await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    } catch (e) {
      thrown = e;
    }
    expect(thrown?.message).toBe("boom");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — computeRetryDelay hook veto", () => {
  it("only invokes computeRetryDelay when status has retry config", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(0);
    fetchMock.mockResolvedValueOnce(res(500));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(500);
    expect(ex.computeRetryDelay).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hook returning false skips retry (uses fallback path)", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 429: { attempts: 5, delayMs: 0 } } });
    ex.computeRetryDelay = vi.fn().mockResolvedValue(false);
    fetchMock.mockResolvedValueOnce(res(429));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    // hook vetoes retry → no fallback url → returns the 429 response as-is
    expect(out.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor.execute — connect timeout classification", () => {
  // A hanging transport that only settles when the executor's own timer aborts it.
  // The runner also probes mocks with no arguments — those calls get a parked promise.
  const hangUntilAborted = (rejectWith) => (...args) => {
    const signal = args.find((arg) => arg && typeof arg === "object" && arg.signal)?.signal;
    if (!signal) return Promise.resolve({ status: 200, ok: true, headers: { get: () => "application/json" }, text: async () => "{}", json: async () => ({}) });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(rejectWith(signal)), { once: true });
    });
  };
  const noRetry = { 502: { attempts: 0, delayMs: 0 }, 503: { attempts: 0, delayMs: 0 } };

  it("marks its own header timeout as UPSTREAM_TIMEOUT, not a bare error", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", timeoutMs: 20, retry: noRetry });
    fetchMock.mockImplementation(hangUntilAborted((signal) => signal.reason));
    const error = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds }).catch((e) => e);
    expect(isUpstreamTimeoutError(error)).toBe(true);
    expect(error.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("keeps the timeout class when the transport hands back an AbortError", async () => {
    // undici reports a plain AbortError when the signal carries no reason; that must not read
    // as a caller cancellation downstream (chatCore answers 499 for those).
    const ex = makeExec({ baseUrl: "https://x/api", timeoutMs: 20, retry: noRetry });
    fetchMock.mockImplementation(hangUntilAborted(() => new DOMException("aborted", "AbortError")));
    const error = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds }).catch((e) => e);
    expect(error.name).not.toBe("AbortError");
    expect(isUpstreamTimeoutError(error)).toBe(true);
  });

  it("keeps the timeout class when a proxy wrapper replaces the error object", async () => {
    // strictProxy wraps transport failures in a fresh Error with no cause; the abort signal is
    // then the only reliable marker of "this request was too slow".
    const ex = makeExec({ baseUrl: "https://x/api", timeoutMs: 20, retry: noRetry });
    fetchMock.mockImplementation(hangUntilAborted(() => new Error("[ProxyFetch] Proxy required but failed (strictProxy=true)")));
    const error = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds }).catch((e) => e);
    expect(isUpstreamTimeoutError(error)).toBe(true);
  });

  it("does not treat a caller cancellation as an upstream timeout", async () => {
    const controller = new AbortController();
    const ex = makeExec({ baseUrl: "https://x/api", timeoutMs: 5000, retry: noRetry });
    fetchMock.mockImplementation((...args) => {
      const signal = args.find((arg) => arg && typeof arg === "object" && arg.signal)?.signal;
      if (!signal) return Promise.resolve({ status: 200, ok: true, headers: { get: () => "application/json" }, text: async () => "{}", json: async () => ({}) });
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const task = ex.execute({ model: "m", body: {}, stream: false, credentials: creds, signal: controller.signal }).catch((e) => e);
    setTimeout(() => controller.abort(), 5);
    const error = await task;
    expect(isUpstreamTimeoutError(error)).toBe(false);
  });

  it("classifies undici header/body timeouts and ignores connect timeouts", () => {
    expect(isUpstreamTimeoutError({ code: "UND_ERR_HEADERS_TIMEOUT" })).toBe(true);
    expect(isUpstreamTimeoutError({ cause: { code: "UND_ERR_BODY_TIMEOUT" } })).toBe(true);
    expect(isUpstreamTimeoutError({ code: "UPSTREAM_TIMEOUT" })).toBe(true);
    expect(isUpstreamTimeoutError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe(false);
    expect(isUpstreamTimeoutError(createUpstreamTimeoutError("x", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }))).toBe(true);
    expect(isUpstreamTimeoutError(null)).toBe(false);
  });
});
