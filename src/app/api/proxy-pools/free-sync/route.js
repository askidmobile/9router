import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";
import { getFreeProxySyncState, syncFreeProxies } from "@/lib/network/freeProxies.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getSettings();
  const state = getFreeProxySyncState();
  return NextResponse.json({ ...state, result: state.result || settings.freeProxyLastSync || null, enabled: settings.freeProxyAutoSync !== false });
}

export async function PATCH(request) {
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  await updateSettings({ freeProxyAutoSync: body.enabled });
  return NextResponse.json({ enabled: body.enabled });
}

export async function POST() {
  void syncFreeProxies().catch(error => console.warn("[FreeProxySync]", error.message));
  return NextResponse.json(getFreeProxySyncState(), { status: 202 });
}
