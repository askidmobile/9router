import { resolveCopilotModels as resolveCatalog } from "open-sse/services/copilotModels.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";

export async function resolveCopilotModels(connection) {
  const proxyOptions = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  const result = await resolveCatalog(connection, {
    forceRefresh: true, includeUnavailable: true, proxyOptions,
    onCredentialsRefreshed: async refreshed => {
      const saved = await updateProviderCredentials(connection.id, {
        ...refreshed, existingProviderSpecificData: connection.providerSpecificData || {},
      });
      if (saved === false) throw new Error("Failed to persist refreshed Copilot credentials");
    },
  });
  if (result.models?.some(model => !model.available)) result.warning = "GitHub has disabled access to some models for this account. Check your Copilot plan and model policies in GitHub, then reopen this dialog.";
  return result;
}
