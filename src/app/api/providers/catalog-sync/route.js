import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { getProviderAlias } from "@/shared/constants/providers";
import { getRegistryEntry } from "@/lib/providerModels/deriveModelsEndpoint.js";
import { syncProviderCatalogs, getCatalogSyncState, SYNC_INTERVAL_MS } from "@/lib/providerCatalog/sync.js";

export const dynamic = "force-dynamic";

// Which providers can be scheduled: those whose catalog this router can fetch
// (a connection is checked at run time, not here).
function normalizeProviders(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const alias = getProviderAlias(raw) || raw;
    if (!out.includes(alias)) out.push(alias);
  }
  return out;
}

// GET /api/providers/catalog-sync — schedule state + last run per provider
export async function GET() {
  const settings = await getSettings().catch(() => null);
  return NextResponse.json({
    providers: settings?.catalogSyncProviders || [],
    state: getCatalogSyncState(),
    intervalMs: SYNC_INTERVAL_MS,
  });
}

// PUT /api/providers/catalog-sync — replace the scheduled set
// Body: { providers: string[] }
export async function PUT(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const providers = normalizeProviders(body?.providers);
    if (providers === null) {
      return NextResponse.json({ error: "providers[] required" }, { status: 400 });
    }
    const unknown = providers.filter((p) => !getRegistryEntry(p));
    if (unknown.length) {
      return NextResponse.json({ error: `Unknown provider(s): ${unknown.join(", ")}` }, { status: 400 });
    }
    await updateSettings({ catalogSyncProviders: providers });
    return NextResponse.json({ success: true, providers });
  } catch (error) {
    console.log("Error updating catalog sync providers:", error);
    return NextResponse.json({ error: "Failed to update catalog sync" }, { status: 500 });
  }
}

// POST /api/providers/catalog-sync — run the scheduled sync now
export async function POST() {
  const result = await syncProviderCatalogs();
  if (!result) return NextResponse.json({ error: "sync in progress" }, { status: 503 });
  return NextResponse.json({ success: true, ...result, state: getCatalogSyncState() });
}
