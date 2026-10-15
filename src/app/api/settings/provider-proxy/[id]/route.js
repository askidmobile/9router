import { NextResponse } from "next/server";
import { getSettings, updateProviderProxyPolicy } from "@/lib/db/repos/settingsRepo.js";
import { getProxyPools } from "@/lib/db/repos/proxyPoolsRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { id } = await params;
  const settings = await getSettings();
  const policy = (settings.providerStrategies || {})[id] || {};
  return NextResponse.json({
    proxyEnabled: policy.proxyEnabled === true,
    proxyPoolIds: Array.isArray(policy.proxyPoolIds) ? policy.proxyPoolIds : [],
    rotateStrategy: policy.rotateStrategy || "none",
    inherited: !Object.hasOwn(policy, "proxyEnabled"),
  });
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || ["constructor", "prototype"].includes(id)
    || typeof body?.proxyEnabled !== "boolean" || !Array.isArray(body.proxyPoolIds)
    || body.proxyPoolIds.length > 100 || body.proxyPoolIds.some(value => typeof value !== "string" || !value || value.length > 128)
    || !["none", "round-robin", "random"].includes(body.rotateStrategy)) {
    return NextResponse.json({ error: "Invalid provider proxy policy" }, { status: 400 });
  }
  const proxyPoolIds = [...new Set(body.proxyPoolIds)];
  if (body.proxyEnabled) {
    if ((body.rotateStrategy === "none" && proxyPoolIds.length !== 1)
      || (body.rotateStrategy !== "none" && proxyPoolIds.length < 2)) {
      return NextResponse.json({ error: "Select one proxy, or at least two for explicit rotation" }, { status: 400 });
    }
    const pools = await getProxyPools();
    if (proxyPoolIds.some(poolId => !pools.some(pool => pool.id === poolId))) {
      return NextResponse.json({ error: "Selected proxy pool not found" }, { status: 400 });
    }
  }
  const policy = { proxyEnabled: body.proxyEnabled, proxyPoolIds, rotateStrategy: body.rotateStrategy };
  await updateProviderProxyPolicy(id, policy);
  return NextResponse.json(policy);
}
