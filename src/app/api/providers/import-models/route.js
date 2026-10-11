import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections } from "@/lib/localDb";
import { updatePricing, setCapsOverridesBulk } from "@/lib/db/index.js";
import { getProviderModels as getModelsDevProviderModels } from "@/lib/modelsDev/index.js";
import { getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { getRegistryEntry, deriveModelsEndpoint, parseOpenAIStyleModels } from "@/lib/providerModels/deriveModelsEndpoint.js";
import { catalogMetadata } from "@/lib/providerCatalog/metadata.js";

export const dynamic = "force-dynamic";

const VALID_TARGETS = ["pricing", "caps"];

// A provider's own /v1/models is the authority: it carries the price actually
// charged on this key (aggregator discounts included) plus per-model limits,
// while models.dev lags and does not list every aggregator at all. Fetch it
// first, fall back to models.dev, and report which source was used.
async function fetchProviderCatalog(connection) {
  if (isOpenAICompatibleProvider(connection.provider)) {
    const baseUrl = connection.providerSpecificData?.baseUrl;
    if (!baseUrl) return null;
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" } });
    if (!res.ok) throw new Error(`Provider /models responded ${res.status}`);
    return { models: parseOpenAIStyleModels(await res.json()), source: "provider" };
  }

  if (isAnthropicCompatibleProvider(connection.provider)) {
    const baseUrl = (connection.providerSpecificData?.baseUrl || "").replace(/\/$/, "").replace(/\/messages$/, "");
    if (!baseUrl) return null;
    const res = await fetch(`${baseUrl}/models`, {
      headers: { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", Authorization: `Bearer ${connection.apiKey}` },
    });
    if (!res.ok) throw new Error(`Provider /models responded ${res.status}`);
    return { models: parseOpenAIStyleModels(await res.json()), source: "provider" };
  }

  const endpoint = deriveModelsEndpoint(getRegistryEntry(connection.provider));
  if (!endpoint) return null;
  const token = connection.accessToken || connection.apiKey;
  const res = await fetch(endpoint.url, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`Provider /models responded ${res.status}`);
  return { models: parseOpenAIStyleModels(await res.json()), source: "provider" };
}

// POST /api/providers/import-models
// Body: { connectionId | provider, targets?: ["pricing","caps"] }
// Writes the provider's own catalog as user overrides: pricing → kv "pricing",
// caps → kv "modelCaps". Falls back to models.dev when the provider publishes no
// machine-readable catalog.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const targets = Array.isArray(body?.targets) && body.targets.length > 0
      ? body.targets.filter((t) => VALID_TARGETS.includes(t))
      : VALID_TARGETS;
    if (targets.length === 0) {
      return NextResponse.json({ error: "No valid targets; expected pricing and/or caps" }, { status: 400 });
    }

    let connection = body?.connectionId ? await getProviderConnectionById(body.connectionId) : null;
    const requestedProvider = body?.provider;
    if (!connection && requestedProvider) {
      const alias = getProviderAlias(requestedProvider) || requestedProvider;
      const connections = await getProviderConnections();
      connection = connections.find((c) =>
        (c.provider === requestedProvider || c.provider === alias
          || getProviderAlias(c.provider) === alias || c.providerSpecificData?.prefix === requestedProvider)
        && c.isActive !== false
      ) || null;
      // No connection is fine for no-auth providers: the registry still names a catalog.
      if (!connection && getRegistryEntry(alias)) {
        connection = { id: null, provider: alias, apiKey: null, accessToken: null, providerSpecificData: {} };
      }
    }
    if (!connection) {
      return NextResponse.json({ error: "Connection or provider required" }, { status: 400 });
    }

    const alias = getProviderAlias(connection.provider) || connection.provider;
    const response = { success: true, provider: alias };

    let entries = null;
    let source = null;
    let warning = null;
    try {
      const catalog = await fetchProviderCatalog(connection);
      if (catalog?.models?.length) {
        entries = catalog.models;
        source = catalog.source;
      }
    } catch (error) {
      // A provider that refuses its own /models is not a failure of the import:
      // fall through to models.dev and say why.
      warning = error.message;
    }

    if (entries) {
      const pricingModels = {};
      const capsEntries = {};
      for (const entry of entries) {
        const meta = catalogMetadata(entry);
        if (!meta) continue;
        if (meta.pricing) pricingModels[meta.id] = meta.pricing;
        if (meta.caps) capsEntries[meta.id] = meta.caps;
      }
      if (targets.includes("pricing") && Object.keys(pricingModels).length > 0) {
        await updatePricing({ [alias]: pricingModels });
      }
      if (targets.includes("caps") && Object.keys(capsEntries).length > 0) {
        await setCapsOverridesBulk(alias, capsEntries);
      }
      response.source = source;
      response.models = entries.length;
      if (targets.includes("pricing")) response.pricing = { imported: Object.keys(pricingModels).length };
      if (targets.includes("caps")) response.caps = { imported: Object.keys(capsEntries).length };
      if (warning) response.warning = warning;
      return NextResponse.json(response);
    }

    // Fallback: models.dev, which still covers the providers that publish nothing.
    const fallback = await getModelsDevProviderModels([alias, connection.provider]);
    if (!fallback.modelsDevId || !fallback.models) {
      return NextResponse.json(
        { error: `No model catalog available for ${alias}: the provider publishes no /models metadata and it is not on models.dev` },
        { status: 404 }
      );
    }
    if (targets.includes("pricing")) {
      const pricingModels = {};
      for (const [modelId, model] of Object.entries(fallback.models)) {
        if (model.pricing) pricingModels[modelId] = model.pricing;
      }
      if (Object.keys(pricingModels).length > 0) await updatePricing({ [alias]: pricingModels });
      response.pricing = { imported: Object.keys(pricingModels).length };
    }
    if (targets.includes("caps")) {
      const capsEntries = {};
      for (const [modelId, model] of Object.entries(fallback.models)) capsEntries[modelId] = model.caps;
      if (Object.keys(capsEntries).length > 0) await setCapsOverridesBulk(alias, capsEntries);
      response.caps = { imported: Object.keys(capsEntries).length };
    }
    response.source = "models.dev";
    response.modelsDevId = fallback.modelsDevId;
    response.stale = fallback.stale;
    if (warning) response.warning = warning;
    return NextResponse.json(response);
  } catch (error) {
    console.log("Error importing provider catalog:", error);
    return NextResponse.json({ error: "Failed to import provider catalog" }, { status: 500 });
  }
}
