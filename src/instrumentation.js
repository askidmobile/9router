export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Bundle the scheduler into the Node startup hook so idle standalone
    // servers refresh credentials even when no dashboard route is loaded.
    const { startBackgroundTokenRefresh } = await import("@/sse/services/backgroundTokenRefresh.js");
    startBackgroundTokenRefresh();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Prices and limits from each provider's own catalog (opt-in per provider).
    const { startProviderCatalogSync } = await import("@/lib/providerCatalog/sync.js");
    startProviderCatalogSync();

    const { startFreeProxySync } = await import("@/lib/network/freeProxies.js");
    startFreeProxySync();
  }
}
