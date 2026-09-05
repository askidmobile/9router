import { NextResponse } from "next/server";
import { getModelNameOverrides, setModelNameOverride } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ overrides: await getModelNameOverrides() });
  } catch {
    return NextResponse.json({ error: "Failed to fetch display names" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const { provider, model, name } = await request.json() || {};
    if (typeof provider !== "string" || !provider.trim() || provider.includes("|")
      || typeof model !== "string" || !model.trim() || typeof name !== "string") {
      return NextResponse.json({ error: "provider, model and name must be strings" }, { status: 400 });
    }
    if (name.trim().length > 256) {
      return NextResponse.json({ error: "Display name must be at most 256 characters" }, { status: 400 });
    }
    await setModelNameOverride(provider.trim(), model.trim(), name.trim());
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to save display name" }, { status: 500 });
  }
}
