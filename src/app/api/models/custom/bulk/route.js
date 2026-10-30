import { NextResponse } from "next/server";
import { addCustomModelsBulk } from "@/lib/db/index.js";
import { normalizeGeminiModelId } from "open-sse/utils/geminiModels.js";

export const dynamic = "force-dynamic";

const MAX_IDS = 500;

// POST /api/models/custom/bulk - add many custom models in one transaction
// Body: { providerAlias, type?, ids: string[], names?: { [id]: displayName } }
// `names` carries the provider's published labels so opaque ids (Qoder's
// `qmodel_38max`) land in the dashboard as "Qwen3.8-Max" instead of the raw key.
export async function POST(request) {
  try {
    const body = await request.json();
    const { providerAlias, type = "llm", ids, names } = body || {};

    if (!providerAlias || !Array.isArray(ids)) {
      return NextResponse.json({ error: "providerAlias and ids[] required" }, { status: 400 });
    }

    const cleanIds = [...new Set(ids
      .filter((id) => typeof id === "string")
      .map((id) => providerAlias === "gemini" ? normalizeGeminiModelId(id) : id.trim())
      .filter(Boolean))];
    if (cleanIds.length === 0) {
      return NextResponse.json({ error: "ids must contain at least one non-empty string" }, { status: 400 });
    }
    if (cleanIds.length > MAX_IDS) {
      return NextResponse.json({ error: `Too many ids (max ${MAX_IDS})` }, { status: 400 });
    }

    // Keep only string labels for ids we are actually inserting.
    const cleanNames = {};
    if (names && typeof names === "object") {
      for (const id of cleanIds) {
        const label = names[id];
        if (typeof label === "string" && label.trim()) cleanNames[id] = label.trim();
      }
    }

    const result = await addCustomModelsBulk({ providerAlias, type, ids: cleanIds, names: cleanNames });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.log("Error bulk-adding custom models:", error);
    return NextResponse.json({ error: "Failed to bulk add custom models" }, { status: 500 });
  }
}
