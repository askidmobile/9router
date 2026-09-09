import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { resolveClineModels, resolveClinepassModels } from "../../open-sse/services/clinepassModels.js";

const authCases = [
  ["API key", { apiKey: "  account-key  " }, "Bearer account-key"],
  ["API key taking precedence over stale OAuth", { apiKey: "  account-key  ", accessToken: "stale-oauth" }, "Bearer account-key"],
  ["OAuth without prefix", { accessToken: "  oauth-access  " }, "Bearer workos:oauth-access"],
  ["OAuth with prefix", { accessToken: "  workos:oauth-access  " }, "Bearer workos:oauth-access"],
];

describe.each(["cline", "clinepass"])("%s executor credential headers", (provider) => {
  it.each(authCases)("uses the correct Authorization for %s", (_name, credentials, expected) => {
    const headers = new DefaultExecutor(provider).buildHeaders(credentials, false);

    expect(headers.Authorization).toBe(expected);
    expect(headers["X-Title"]).toBe("Cline");
    expect(headers["X-CLIENT-TYPE"]).toBe("9router");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe.each([
  ["ClinePass subscription catalog", resolveClinepassModels, { clinePass: [{ id: "cline-pass/model", name: "Pass Model" }] }],
  ["Cline full catalog", resolveClineModels, { data: [{ id: "vendor/model", name: "Model", architecture: { modality: "text->text" } }] }],
])("%s credential headers", (_name, resolveModels, body) => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(authCases)("uses the correct Authorization for %s", async (_label, credentials, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveModels(credentials);

    expect(result?.models).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(expected);
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe("application/json");
  });

  it("keeps the public catalog accessible without credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await resolveModels())?.models).toHaveLength(1);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });
});
