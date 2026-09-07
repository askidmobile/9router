import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, getCustomModels } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getCapsOverrides, getModelNameOverrides } from "@/lib/db/index.js";
import { resolveModelName } from "@/shared/utils/modelNames";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias, getProviderByAlias } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();
    const capsOverrides = await getCapsOverrides();
    const modelNames = await getModelNameOverrides();
    const savedModels = (await getCustomModels()).filter((m) =>
      m?.id && (m.kind || m.type || "llm") === "llm"
    );
    const savedByModel = new Map(savedModels.map((m) => [
      `${getProviderAlias(m.providerAlias) || m.providerAlias}/${m.id}`, m,
    ]));

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerId = getProviderByAlias(m.provider)?.id || m.provider;
        const providerAlias = getProviderAlias(providerId) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        // A catalog update can promote a saved custom model to a built-in.
        // Keep its name/caps, then apply explicit overrides as in the editor.
        const saved = savedByModel.get(routedModel);
        const override = capsOverrides[`${providerAlias}|${m.model}`] || capsOverrides[`${providerId}|${m.model}`];
        const c = { ...getCapabilitiesForModel(providerId, m.model), ...(saved?.caps || {}), ...(override || {}) };
        return {
          ...m,
          name: resolveModelName(modelNames, providerId, m.model, saved?.name || m.name),
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            ...(saved?.caps || {}),
            ...(override || {}),
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            tools: c.tools,
            pdf: c.pdf,
            imageOutput: c.imageOutput,
            audioInput: c.audioInput,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
          ...(override ? { capsOverridden: true } : {}),
        };
      });

    // Custom models use the same precedence as the editor: defaults, stored
    // capabilities, then the user's current overrides.
    const seenFull = new Set(models.map((m) => m.routedModel));
    const customModels = savedModels.filter((m) =>
      !seenFull.has(`${getProviderAlias(m.providerAlias) || m.providerAlias}/${m.id}`)
    );
    for (const m of customModels) {
      const fullModel = `${m.providerAlias}/${m.id}`;
      const providerId = getProviderByAlias(m.providerAlias)?.id || m.providerAlias;
      const override = capsOverrides[`${m.providerAlias}|${m.id}`] || capsOverrides[`${providerId}|${m.id}`];
      const c = {
        ...getCapabilitiesForModel(providerId, m.id),
        ...(m.caps || {}),
        ...(override || {}),
      };
      models.push({
        provider: m.providerAlias,
        model: m.id,
        name: resolveModelName(modelNames, m.providerAlias, m.id, m.name),
        fullModel,
        routedModel: fullModel,
        alias: modelAliases[fullModel] || m.id,
        caps: {
          ...(m.caps || {}),
          ...(override || {}),
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          tools: c.tools,
          pdf: c.pdf,
          imageOutput: c.imageOutput,
          audioInput: c.audioInput,
          contextWindow: c.contextWindow,
          maxOutput: c.maxOutput,
        },
        ...(override ? { capsOverridden: true } : {}),
      });
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
