import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "../constants/providers.js";
import { CUSTOM_QUOTA_ORIGINS } from "open-sse/config/quotaTracking.js";

export function getQuotaProvider(connection) {
  if (!connection?.provider?.startsWith("openai-compatible-")) return connection?.provider;
  try {
    const url = new URL(connection.providerSpecificData?.baseUrl);
    if (url.username || url.password) return connection.provider;
    return CUSTOM_QUOTA_ORIGINS[url.origin] || connection.provider;
  } catch {
    return connection.provider;
  }
}

export function isUsageEligible(connection) {
  const provider = getQuotaProvider(connection);
  const apiKeyAuth = connection.authType === "apikey" || connection.authType === "api_key";
  const custom = provider !== connection.provider;
  return (custom || USAGE_SUPPORTED_PROVIDERS.includes(provider)) && (
    connection.authType === "oauth" || (apiKeyAuth && (custom || USAGE_APIKEY_PROVIDERS.includes(provider)))
  );
}
