/**
 * Импорт каталога Kiro разрешает profileArn так же, как инференс
 * (translator/request/openai-to-kiro.js): у Builder ID и социального входа
 * собственного профиля нет (ListAvailableProfiles отвечает 403, подключение
 * сохраняется без profileArn), поэтому шлётся общий профиль — иначе
 * ListAvailableModels отклоняет запрос с 400 «Invalid profileArn» и дашборд
 * падает на статический список с моделями, которых у аккаунта нет.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIRO_DEFAULT_PROFILE_ARNS } from "../../open-sse/config/kiroConstants.js";
import { resolveKiroModels, clearKiroModelCache } from "../../open-sse/services/kiroModels.js";

const fetchMock = vi.fn();
const catalog = { models: [{ modelId: "claude-haiku-4.5", modelName: "Claude Haiku 4.5", rateMultiplier: 0.4 }] };
const okCatalog = () => ({ ok: true, status: 200, json: async () => catalog, text: async () => JSON.stringify(catalog) });
const credentials = (providerSpecificData) => ({ accessToken: "test-access-token", refreshToken: "test-refresh-token", providerSpecificData });
const requestedUrl = () => new URL(fetchMock.mock.calls[0][0]);

const OWN_PROFILE = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC";

async function importCatalog(providerSpecificData) {
  fetchMock.mockResolvedValue(okCatalog());
  vi.stubGlobal("fetch", fetchMock);
  const result = await resolveKiroModels(credentials(providerSpecificData));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return { url: requestedUrl(), result };
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  clearKiroModelCache();
});

describe("Kiro catalog: profileArn разрешается как в инференсе", () => {
  it("Builder ID без своего профиля получает общий профиль и живой каталог", async () => {
    const { url, result } = await importCatalog({ authMethod: "builder-id", region: "us-east-1", clientId: "client-1" });
    expect(url.origin).toBe("https://q.us-east-1.amazonaws.com");
    expect(url.searchParams.get("profileArn")).toBe(KIRO_DEFAULT_PROFILE_ARNS["builder-id"]);
    expect(result.models.map((m) => m.id)).toEqual(["claude-haiku-4.5"]);
  });

  it.each(["google", "github"])("социальный вход (%s) без своего профиля получает общий социальный профиль", async (authMethod) => {
    const { url } = await importCatalog({ authMethod, region: "us-east-1", clientId: `client-${authMethod}` });
    expect(url.searchParams.get("profileArn")).toBe(KIRO_DEFAULT_PROFILE_ARNS.social);
  });

  it("собственный профиль подключения имеет приоритет, регион берётся из него", async () => {
    const { url } = await importCatalog({ authMethod: "idc", profileArn: OWN_PROFILE });
    expect(url.origin).toBe("https://q.eu-central-1.amazonaws.com");
    expect(url.searchParams.get("profileArn")).toBe(OWN_PROFILE);
  });

  it.each(["api_key", "idc", "external_idp"])("%s без своего профиля не занимает общий профиль", async (authMethod) => {
    const { url } = await importCatalog({ authMethod, region: "us-east-1", clientId: `client-${authMethod}` });
    expect(url.searchParams.get("profileArn")).toBeNull();
  });
});
