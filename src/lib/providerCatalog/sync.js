// Scheduled refresh of prices/limits from each provider's own catalog.
//
// The dashboard import button covers a one-off refresh; this keeps the numbers
// current without a human. Only providers the user opted into are synced: a
// public feed like OpenRouter lists 400+ ids, so refreshing everything by
// default would write rows nobody asked for. Opt-in is stored in
// settings.catalogSyncProviders.
//
// Failures are swallowed per provider — one unreachable vendor must not stop the
// others, and the stored overrides simply stay as they were.

import { getSettings } from "../db/repos/settingsRepo.js";
import { getProviderConnections } from "../db/repos/connectionsRepo.js";
import { importProviderCatalog, findImportConnection } from "./import.js";

export const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 3 * 60 * 1000;   // let the server serve its first requests
const RETRY_DELAY_MS = 60 * 60 * 1000;

let state = { running: false, lastSync: null, lastError: null, providers: {} };
let timer = null;

export function getCatalogSyncState() {
  return { ...state, intervalMs: SYNC_INTERVAL_MS };
}

/** Providers opted into the scheduled refresh (settings.catalogSyncProviders). */
export async function getSyncProviders() {
  const settings = await getSettings().catch(() => null);
  const list = settings?.catalogSyncProviders;
  return Array.isArray(list) ? list.filter((p) => typeof p === "string" && p.trim()) : [];
}

/**
 * Refresh every opted-in provider once.
 * @returns {Promise<{synced: number, failed: number, providers: object}>}
 */
export async function syncProviderCatalogs({ refreshOfficialSources = false } = {}) {
  if (state.running) return null;
  state.running = true;
  const refreshCapabilities = refreshOfficialSources;
  const result = { synced: 0, failed: 0, providers: {} };
  try {
    const aliases = await getSyncProviders();
    if (aliases.length === 0) return result;
    const connections = await getProviderConnections();
    for (const alias of aliases) {
      try {
        const connection = await findImportConnection({ provider: alias });
        if (!connection) {
          result.providers[alias] = { status: "skipped", reason: "no active connection" };
          continue;
        }
        // Background jobs refresh prices/discovery only. Capability refresh requires a user action.
        const imported = await importProviderCatalog({ connection, registerModels: true, catalogOnly: true, refreshOfficialSources, targets: refreshCapabilities ? ["pricing", "caps"] : ["pricing"] });
        refreshOfficialSources = false;
        result.providers[alias] = {
          status: "ok",
          source: imported.source,
          pricing: imported.pricing?.imported ?? 0,
          caps: imported.caps?.imported ?? 0,
          models: imported.registered?.added ?? 0,
        };
        result.synced += 1;
      } catch (error) {
        result.providers[alias] = { status: "error", error: error?.message || String(error) };
        result.failed += 1;
      }
    }
    state.lastSync = Date.now();
    state.lastError = null;
    state.providers = result.providers;
    console.log(`[providerCatalog] synced ${result.synced}/${aliases.length} providers`);
    return result;
  } catch (error) {
    state.lastError = error?.message || String(error);
    console.log(`[providerCatalog] sync failed: ${state.lastError}`);
    return null;
  } finally {
    state.running = false;
  }
}

// Schedule the recurring sync. Disable entirely with PROVIDER_CATALOG_SYNC=off.
export function startProviderCatalogSync() {
  if (timer) return;
  if (String(process.env.PROVIDER_CATALOG_SYNC || "").toLowerCase() === "off") return;
  const schedule = (delay) => {
    timer = setTimeout(async () => {
      const result = await syncProviderCatalogs();
      // An empty schedule is the normal state before the user opts in, so it
      // must not look like a failure and shorten the next delay.
      schedule(result === null ? RETRY_DELAY_MS : SYNC_INTERVAL_MS);
    }, delay);
    timer.unref?.();
  };
  schedule(STARTUP_DELAY_MS);
}
