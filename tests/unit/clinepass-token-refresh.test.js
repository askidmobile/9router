import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateProviderConnection: vi.fn(),
}));

vi.mock("../../src/lib/localDb.js", () => ({
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const EXPIRES_AT = new Date(NOW + 3600_000).toISOString();

function connection(overrides = {}) {
  return {
    id: "clinepass-connection",
    provider: "clinepass",
    authType: "oauth",
    isActive: true,
    accessToken: "expired-access",
    refreshToken: "old-refresh",
    expiresAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function mockRefresh(tokens = {}) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    success: true,
    data: { accessToken: "new-access", refreshToken: "rotated-refresh", expiresAt: EXPIRES_AT, ...tokens },
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectRefreshContract(fetchMock, oldRefreshToken = "old-refresh") {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.cline.bot/api/v1/auth/refresh");
  expect(init.method).toBe("POST");
  expect(init.headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(init.body)).toEqual({
    refreshToken: oldRefreshToken,
    grantType: "refresh_token",
    clientType: "extension",
  });
}

function expectPersistedRotation() {
  expect(mocks.updateProviderConnection).toHaveBeenCalledExactlyOnceWith(
    "clinepass-connection",
    expect.objectContaining({
      accessToken: "new-access",
      refreshToken: "rotated-refresh",
      expiresAt: EXPIRES_AT,
      lastRefreshAt: new Date(NOW).toISOString(),
    })
  );
}

describe("ClinePass OAuth refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.updateProviderConnection.mockResolvedValue({ id: "clinepass-connection" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refreshes and persists rotating credentials on the proactive request path", async () => {
    const fetchMock = mockRefresh();
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    const result = await checkAndRefreshToken("clinepass", connection());

    expectRefreshContract(fetchMock);
    expectPersistedRotation();
    expect(result).toMatchObject({ accessToken: "new-access", refreshToken: "rotated-refresh", expiresAt: EXPIRES_AT });
  });

  it("refreshes and persists ClinePass through the real background refresh handler", async () => {
    const fetchMock = mockRefresh();
    const { runBackgroundTokenRefreshTick } = await import("../../src/sse/services/backgroundTokenRefresh.js");

    // Ten minutes is outside the request lead; the scheduler must force refresh.
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [connection({ expiresAt: new Date(NOW + 600_000).toISOString() })],
    });

    expectRefreshContract(fetchMock);
    expectPersistedRotation();
  });

  it("shares one rotating refresh between Cline and ClinePass dispatch entrypoints", async () => {
    const fetchMock = mockRefresh();
    const { getAccessToken, refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js");

    const results = await Promise.all([
      getAccessToken("clinepass", connection()),
      refreshTokenByProvider("clinepass", connection()),
      refreshTokenByProvider("cline", connection()),
    ]);

    expectRefreshContract(fetchMock);
    for (const result of results) {
      expect(result).toEqual({ accessToken: "new-access", refreshToken: "rotated-refresh", expiresIn: 3600 });
    }
  });

  it("retains the current refresh token when the provider does not rotate it", async () => {
    const fetchMock = mockRefresh({ refreshToken: undefined });
    const { refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js");

    const result = await refreshTokenByProvider("clinepass", connection());

    expectRefreshContract(fetchMock);
    expect(result.refreshToken).toBe("old-refresh");
  });

  it("does not persist or report refreshed credentials when the refresh response lacks an access token", async () => {
    const fetchMock = mockRefresh({ accessToken: undefined });
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    const original = connection();

    const result = await checkAndRefreshToken("clinepass", original);

    expectRefreshContract(fetchMock);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(result.accessToken).toBe(original.accessToken);
    expect(result.refreshToken).toBe(original.refreshToken);
    expect(result.expiresAt).toBe(original.expiresAt);
  });
});
