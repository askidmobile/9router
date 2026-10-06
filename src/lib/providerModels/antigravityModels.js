import antigravity from "open-sse/providers/registry/antigravity.js";
import { fetchAntigravityModelCatalog, parseAntigravityModels } from "open-sse/services/antigravityModels.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshGoogleToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";

export async function resolveAntigravityModels(connection) {
  if (!connection.accessToken) return { error: "No valid Antigravity token found", status: 401 };
  try {
    const proxyOptions = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const providerSpecificData = {
      ...connection.providerSpecificData,
      projectId: connection.projectId || connection.providerSpecificData?.projectId,
    };
    const fetchCatalog = token => fetchAntigravityModelCatalog(token, providerSpecificData, proxyOptions);
    let { response } = await fetchCatalog(connection.accessToken);
    if (response.status === 401 && connection.refreshToken) {
      const refreshed = await refreshGoogleToken(connection.refreshToken, antigravity.transport.clientId, antigravity.transport.clientSecret);
      if (refreshed?.accessToken) {
        // Persist refreshed credentials before retry; catalog failure must not lose them.
        await updateProviderCredentials(connection.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || connection.refreshToken,
          expiresIn: refreshed.expiresIn,
        });
        response = (await fetchCatalog(refreshed.accessToken)).response;
      }
    }
    if (!response.ok) return { error: `Failed to fetch Antigravity models: ${response.status}`, status: response.status };
    const models = parseAntigravityModels(await response.json());
    if (!models) return { error: "Invalid Antigravity models response", status: 502 };
    return { models };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
    return { error: timedOut ? "Antigravity models request timed out" : "Failed to fetch Antigravity models", status: timedOut ? 504 : 502 };
  }
}
