import antigravity from "../providers/registry/antigravity.js";
import { ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_VERSION } from "../providers/shared.js";
import { ANTIGRAVITY_CATALOG_TIMEOUT_MS, CLIENT_METADATA } from "../config/appConstants.js";
import { normalizeCloudCodeProjectId } from "./usage/shared.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const fetchCatalog = (url, options, proxyOptions) => proxyAwareFetch(url, {
  ...options, cache: "no-store", signal: AbortSignal.timeout(ANTIGRAVITY_CATALOG_TIMEOUT_MS),
}, proxyOptions);

// Import and quota discovery must use the same IDE identity and fixed endpoints.
export async function fetchAntigravityModelCatalog(accessToken, providerSpecificData = {}, proxyOptions = null) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
  };
  let subscriptionInfo = null;
  try {
    const subscription = await fetchCatalog(antigravity.transport.usage.loadProjectApiUrl, {
      method: "POST", headers,
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
    }, proxyOptions);
    if (subscription.ok) subscriptionInfo = await subscription.json();
  } catch {
    // Discovery can still succeed with a stored project or without a project.
  }
  const project = normalizeCloudCodeProjectId(subscriptionInfo?.cloudaicompanionProject)
    || normalizeCloudCodeProjectId(providerSpecificData?.projectId);
  const response = await fetchCatalog(antigravity.transport.usage.quotaApiUrl, {
    method: "POST",
    headers: { ...headers, "X-Client-Name": "antigravity", "X-Client-Version": ANTIGRAVITY_IDE_VERSION },
    body: JSON.stringify(project ? { project } : {}),
  }, proxyOptions);
  return { response, subscriptionInfo, projectId: project };
}

export function parseAntigravityModels(data) {
  const raw = data?.models;
  if (!raw || typeof raw !== "object") return null;
  const entries = Array.isArray(raw)
    ? raw.map(info => [info?.id || info?.model || info?.name, info])
    : Object.entries(raw);
  const models = new Map();
  for (const [id, info] of entries) {
    if (typeof id !== "string" || !id.trim() || !info || typeof info !== "object" || info.isInternal) continue;
    const modelId = id.trim();
    if (models.has(modelId)) continue;
    const curated = antigravity.models.find(model => model.id === modelId);
    const model = {
      id: modelId,
      name: info.displayName || info.name || curated?.name || modelId,
      ...(curated?.upstreamModelId ? { upstreamModelId: curated.upstreamModelId } : {}),
    };
    const contextWindow = info.maxTokens || info.inputTokenLimit || info.contextWindow;
    const maxOutput = info.maxOutputTokens || info.outputTokenLimit || info.maxOutput;
    if (Number.isFinite(contextWindow) && contextWindow > 0) model.contextWindow = contextWindow;
    if (Number.isFinite(maxOutput) && maxOutput > 0) model.maxOutput = maxOutput;
    models.set(modelId, model);
  }
  return [...models.values()];
}
