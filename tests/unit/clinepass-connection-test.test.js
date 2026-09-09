import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  updateConnection: vi.fn(),
  resolveProxy: vi.fn(),
  testProxy: vi.fn(),
  proxyFetch: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getConnection,
  updateProviderConnection: mocks.updateConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveProxy,
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: mocks.testProxy }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyFetch }));

import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const USER_URL = "https://api.cline.bot/api/v1/users/me";
const REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";
const refreshedTokens = {
  accessToken: "new-access",
  refreshToken: "rotated-refresh",
  expiresAt: new Date(NOW + 3600_000).toISOString(),
};

function response(status, body = {}) {
  return new Response(JSON.stringify(body), { status });
}

describe.each(["cline", "clinepass"])("%s OAuth connection test", (provider) => {
  let connection;
  let fetchMock;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    connection = {
      id: "test-connection",
      provider,
      authType: "oauth",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(NOW + 3600_000).toISOString(),
    };
    mocks.getConnection.mockImplementation(async () => connection);
    mocks.resolveProxy.mockResolvedValue({ connectionProxyEnabled: false });
    mocks.testProxy.mockResolvedValue({ ok: true });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(["old-access", "workos:old-access"])("probes the account with Cline auth headers for %s", async (token) => {
    connection.accessToken = token;
    fetchMock.mockResolvedValueOnce(response(200));

    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({ valid: true, error: null, refreshed: false });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(USER_URL, expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({
        Authorization: "Bearer workos:old-access",
        "X-CLIENT-TYPE": "9router",
        Accept: "application/json",
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(mocks.updateConnection).toHaveBeenCalledExactlyOnceWith(connection.id, {
      testStatus: "active", lastError: null, lastErrorAt: null,
    });
  });

  it.each(["wrapped", "unwrapped"])("refreshes on 401 using the %s token response and persists rotation", async (envelope) => {
    fetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, envelope === "wrapped" ? { data: refreshedTokens } : refreshedTokens))
      .mockResolvedValueOnce(response(200));

    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({ valid: true, refreshed: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([USER_URL, REFRESH_URL, USER_URL]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      refreshToken: "old-refresh", grantType: "refresh_token", clientType: "extension",
    });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer workos:new-access");
    expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({
      testStatus: "active", accessToken: "new-access", refreshToken: "rotated-refresh",
      expiresIn: 3600, expiresAt: refreshedTokens.expiresAt,
    }));
  });

  it("refreshes an expired token before probing and never refreshes it twice", async () => {
    connection.expiresAt = new Date(NOW - 1000).toISOString();
    fetchMock
      .mockResolvedValueOnce(response(200, { data: refreshedTokens }))
      .mockResolvedValueOnce(response(401));

    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({ valid: false, error: "Token invalid or revoked", refreshed: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([REFRESH_URL, USER_URL]);
    expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({
      testStatus: "error", accessToken: "new-access", refreshToken: "rotated-refresh",
    }));
  });

  it("rejects a successful refresh response without an access token", async () => {
    connection.expiresAt = new Date(NOW - 1000).toISOString();
    fetchMock.mockResolvedValueOnce(response(200, { data: { refreshToken: "invalid-refresh" } }));

    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({ valid: false, error: "Token expired and refresh failed", refreshed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.updateConnection.mock.calls[0][1]).not.toHaveProperty("accessToken");
    expect(mocks.updateConnection.mock.calls[0][1]).not.toHaveProperty("refreshToken");
  });

  it("preserves rotated credentials when the post-refresh probe encounters a network failure", async () => {
    fetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, { data: refreshedTokens }))
      .mockRejectedValueOnce(new Error("fetch connect timeout"));

    const result = await testSingleConnection(connection.id);

    expect(result).toMatchObject({ valid: false, error: "fetch connect timeout", refreshed: true });
    expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({
      testStatus: "error", lastError: "fetch connect timeout",
      accessToken: "new-access", refreshToken: "rotated-refresh",
    }));
  });

  it.each([
    [401, "Token invalid or revoked"],
    [403, "Access denied"],
    [502, "API returned 502"],
  ])("reports upstream %s as a failed connection", async (status, error) => {
    delete connection.refreshToken;
    fetchMock.mockResolvedValueOnce(response(status));

    expect(await testSingleConnection(connection.id)).toMatchObject({ valid: false, error, refreshed: false });
    expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({
      testStatus: "error", lastError: error,
    }));
  });

  it("reports network failure through the connection result and DB instead of throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch connect timeout"));

    expect(await testSingleConnection(connection.id)).toMatchObject({
      valid: false, error: "fetch connect timeout", refreshed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({
      testStatus: "error", lastError: "fetch connect timeout",
    }));
  });

  it.each([
    { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:3128", connectionNoProxy: "localhost" },
    { vercelRelayUrl: "https://relay.test", connectionProxyEnabled: false },
  ])("uses the configured proxy for probe, refresh, and retry: %j", async (proxy) => {
    mocks.resolveProxy.mockResolvedValue(proxy);
    mocks.proxyFetch
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, { data: refreshedTokens }))
      .mockResolvedValueOnce(response(200));

    expect(await testSingleConnection(connection.id)).toMatchObject({ valid: true, refreshed: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.proxyFetch.mock.calls.map(([url]) => url)).toEqual([USER_URL, REFRESH_URL, USER_URL]);
    for (const [, options, usedProxy] of mocks.proxyFetch.mock.calls) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(usedProxy).toEqual(proxy.vercelRelayUrl ? { vercelRelayUrl: proxy.vercelRelayUrl } : proxy);
    }
  });
});

describe("ClinePass API key connection test", () => {
  let connection;
  let fetchMock;

  beforeEach(() => {
    vi.resetAllMocks();
    connection = {
      id: "apikey-connection",
      provider: "clinepass",
      authType: "apikey",
      apiKey: "account-key",
      // A converted OAuth connection may retain these fields. API key tests
      // must use the API key and must not refresh stale OAuth credentials.
      accessToken: "stale-oauth-access",
      refreshToken: "stale-oauth-refresh",
      expiresAt: "2020-01-01T00:00:00Z",
    };
    mocks.getConnection.mockImplementation(async () => connection);
    mocks.resolveProxy.mockResolvedValue({ connectionProxyEnabled: false });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(["account-key", "  account-key  ", "workos:account-key"])("probes the account using API key %s with no OAuth refresh", async (key) => {
    connection.apiKey = key;
    fetchMock.mockResolvedValueOnce(response(200));

    expect(await testSingleConnection(connection.id)).toMatchObject({ valid: true, error: null, refreshed: false });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(USER_URL, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${key.trim()}` }),
      signal: expect.any(AbortSignal),
    }));
    expect(mocks.updateConnection).toHaveBeenCalledExactlyOnceWith(connection.id, {
      testStatus: "active", lastError: null, lastErrorAt: null,
    });
  });

  it.each([
    [401, "Token invalid or revoked"],
    [403, "Access denied"],
    [502, "API returned 502"],
  ])("reports upstream %s without trying OAuth refresh", async (status, error) => {
    fetchMock.mockResolvedValueOnce(response(status));

    expect(await testSingleConnection(connection.id)).toMatchObject({ valid: false, error, refreshed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({
      testStatus: "error", lastError: error,
    }));
  });

  it("reports a network failure as the connection error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch connect timeout"));

    expect(await testSingleConnection(connection.id)).toMatchObject({
      valid: false, error: "fetch connect timeout", refreshed: false,
    });
    expect(mocks.updateConnection).toHaveBeenCalledWith(connection.id, expect.objectContaining({
      testStatus: "error", lastError: "fetch connect timeout",
    }));
  });

  it("uses the connection relay for the API key probe", async () => {
    const proxy = { vercelRelayUrl: "https://relay.test", connectionProxyEnabled: false };
    mocks.resolveProxy.mockResolvedValue(proxy);
    mocks.proxyFetch.mockResolvedValueOnce(response(200));

    expect(await testSingleConnection(connection.id)).toMatchObject({ valid: true, refreshed: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.proxyFetch).toHaveBeenCalledExactlyOnceWith(USER_URL, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer account-key" }),
      signal: expect.any(AbortSignal),
    }), { vercelRelayUrl: proxy.vercelRelayUrl });
  });
});
