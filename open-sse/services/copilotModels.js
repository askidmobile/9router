/** Shared, account-specific GitHub Copilot catalog for discovery and import. */
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { GITHUB_COPILOT } from "../config/appConstants.js";
import { refreshCopilotToken } from "./tokenRefresh.js";

const catalogCache = new Map();
const cacheKey = credentials => credentials?.providerSpecificData?.copilotToken || credentials?.accessToken;

async function fetchCatalogRaw(token, options) {
  const timeout = AbortSignal.timeout(GITHUB_COPILOT.MODELS_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const response = await proxyAwareFetch(GITHUB_COPILOT.MODELS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "editor-version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
      "editor-plugin-version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
      "user-agent": GITHUB_COPILOT.USER_AGENT,
      "x-github-api-version": GITHUB_COPILOT.API_VERSION,
    },
    cache: "no-store", signal,
  }, options.proxyOptions);
  if (!response.ok) {
    const error = new Error(`Failed to fetch Copilot models: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  // The timeout also covers stalled bodies after HTTP headers have arrived.
  const data = await response.json();
  const models = parseCopilotModels(data);
  if (!models) throw Object.assign(new Error("Invalid Copilot models response"), { status: 502 });
  return models;
}

export function parseCopilotModels(data) {
  if (!Array.isArray(data?.data)) return null;
  const models = new Map();
  for (const model of data.data) {
    if (!model || model.capabilities?.type !== "chat" || model.model_picker_enabled === false || model.isInternal) continue;
    if (typeof model.id !== "string" || !model.id.trim()) continue;
    const id = model.id.trim();
    if (models.has(id)) continue;
    const policyState = model.policy?.state;
    models.set(id, {
      id, name: typeof model.name === "string" && model.name.trim() ? model.name : id,
      available: model.policy == null || policyState === "enabled",
      ...(typeof policyState === "string" ? { policyState } : {}),
    });
  }
  return [...models.values()];
}

const selectModels = (models, includeUnavailable) => ({ models: includeUnavailable
  ? models
  : models.filter(model => model.available).map(({ id, name }) => ({ id, name })) });

/**
 * Default discovery exposes only available chat models. Import passes
 * includeUnavailable to show policy restrictions without changing them.
 * forceRefresh bypasses the per-credential cache when opening the import dialog.
 * onCredentialsRefreshed persists {copilotToken, copilotTokenExpiresAt} before retry.
 */
export async function resolveCopilotModels(credentials, options = {}) {
  const token = cacheKey(credentials);
  if (!token) return { error: "No valid Copilot token found", status: 401 };
  const cached = catalogCache.get(token);
  if (!options.forceRefresh && cached?.expiresAt > Date.now()) {
    return selectModels(cached.models, options.includeUnavailable);
  }
  try {
    let models;
    try {
      models = await fetchCatalogRaw(token, options);
    } catch (error) {
      // Permission denials are not expired credentials; do not refresh a 403.
      if (error.status !== 401 || !credentials.accessToken) throw error;
      const refreshed = await refreshCopilotToken(credentials.accessToken);
      if (!refreshed?.token) throw error;
      if (options.onCredentialsRefreshed) await options.onCredentialsRefreshed({
        copilotToken: refreshed.token, copilotTokenExpiresAt: refreshed.expiresAt,
      });
      models = await fetchCatalogRaw(refreshed.token, options);
    }
    catalogCache.set(token, { expiresAt: Date.now() + GITHUB_COPILOT.MODELS_CACHE_TTL_MS, models });
    return selectModels(models, options.includeUnavailable);
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
    const status = error.status || (timedOut ? 504 : 502);
    const message = timedOut ? "Copilot models request timed out"
      : status === 502 ? "Failed to fetch Copilot models" : `Failed to fetch Copilot models: ${status}`;
    options.log?.warn?.("COPILOT_MODELS", message);
    return { error: message, status };
  }
}

export function clearCopilotModelCache() { catalogCache.clear(); }
