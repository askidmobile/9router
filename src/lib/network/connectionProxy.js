import { getProxyPoolById } from "@/models";
import { getSettings } from "../db/repos/settingsRepo.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

function isUsablePool(pool) {
  if (!pool?.isActive || !pool.proxyUrl) return false;
  return pool.managedBy !== "free-proxy-sync" || (pool.testStatus === "active"
    && Date.now() - Date.parse(pool.lastTestedAt) < 60 * 60 * 1000);
}

/** Provider policy never enrolls new pool entries or falls back to a connection/environment proxy. */
export async function resolveProviderProxyConfig(providerId, connectionData = {}, settings) {
  const override = ((settings || await getSettings()).providerStrategies || {})[providerId] || {};
  const direct = { connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "", vercelRelayUrl: "", useEnvProxy: false };
  if (override.proxyEnabled === false) return direct;
  if (override.proxyEnabled !== true) {
    // Preserve existing, explicitly assigned connection proxies on upgrade.
    const resolved = await resolveConnectionProxyConfig(connectionData);
    const intended = (!!connectionData.proxyPoolId && connectionData.proxyPoolId !== "__none__") || connectionData.connectionProxyEnabled === true || !!resolved.vercelRelayUrl;
    return { ...resolved, useEnvProxy: false, strictProxy: intended, proxyRequired: intended };
  }
  const ids = Array.isArray(override.proxyPoolIds) ? override.proxyPoolIds : [];
  const strategy = override.rotateStrategy || "none";
  let id = ids[0] || null;
  if (strategy === "round-robin" || strategy === "random") {
    const pools = await Promise.all(ids.map(getProxyPoolById));
    id = pickProxyPoolId(pools.filter(isUsablePool).map(pool => pool.id), strategy, providerId);
  }
  const pool = id ? await getProxyPoolById(id) : null;
  const resolved = isUsablePool(pool) ? await resolveConnectionProxyConfig({ proxyPoolId: id }) : direct;
  return { ...resolved, proxyPoolId: id, connectionNoProxy: "", useEnvProxy: false, strictProxy: true, proxyRequired: true };
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}, providerId = null, settings = undefined
) {
  if (providerId) return resolveProviderProxyConfig(providerId, providerSpecificData, settings);
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // A strict pool must keep its guarantee even when the pool itself is not
    // usable (inactive, or saved without a url). Otherwise the unusable-pool
    // path below reports strictProxy:false and the request silently leaves
    // over the direct IP — the leak strict mode exists to prevent (#4333).
    let poolStrictProxy = false;

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      poolStrictProxy = proxyPool?.strictProxy === true;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}
