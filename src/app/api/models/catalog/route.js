import { NextResponse } from "next/server";
import { buildModelCatalog } from "@/lib/modelCatalog/compare.js";
import { catalogRevision } from "@/lib/db/helpers/revision.js";

// Rebuilt from SQLite on demand. A 5 s memo absorbs dashboard bursts (and a
// page refresh storm) without ever serving data older than a metadata write:
// the revision changes on every caps/pricing/custom-model write.
const TTL_MS = 5000;
let cache = { revision: 0, expiresAt: 0, value: null };

export const dynamic = "force-dynamic";

export async function GET() {
  const now = Date.now();
  const revision = catalogRevision();
  if (cache.value && cache.revision === revision && cache.expiresAt > now) {
    return NextResponse.json(cache.value);
  }
  try {
    const data = await buildModelCatalog();
    cache = { revision, expiresAt: now + TTL_MS, value: data };
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to build model catalog:", error);
    return NextResponse.json({ error: "Failed to build model catalog" }, { status: 500 });
  }
}