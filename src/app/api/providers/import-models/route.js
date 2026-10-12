import { NextResponse } from "next/server";
import { findImportConnection, importProviderCatalog } from "@/lib/providerCatalog/import.js";

export const dynamic = "force-dynamic";

// POST /api/providers/import-models
// Body: { connectionId | provider, targets?: ["pricing","caps"], registerModels?: boolean }
// Reads the provider's own catalog first (models.dev as fallback) and writes it
// as user overrides. registerModels also adds every imported id to the model
// list so it becomes selectable.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const connection = await findImportConnection({ connectionId: body?.connectionId, provider: body?.provider });
    if (!connection) {
      return NextResponse.json({ error: "Connection or provider required" }, { status: 400 });
    }
    const result = await importProviderCatalog({
      connection,
      targets: Array.isArray(body?.targets) && body.targets.length ? body.targets : undefined,
      registerModels: body?.registerModels === true,
      refreshOfficialSources: true,
      catalogOnly: true,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error?.notFound) return NextResponse.json({ error: error.message }, { status: 404 });
    if (/No valid targets/.test(error?.message || "")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error importing provider catalog:", error);
    return NextResponse.json({ error: "Failed to import provider catalog" }, { status: 500 });
  }
}
