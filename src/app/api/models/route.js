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

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        // User overrides (models.dev import / manual edits) win over static caps
        const override = capsOverrides[`${providerAlias}|${m.model}`] || capsOverrides[`${m.provider}|${m.model}`];
        const c = { ...getCapabilitiesForModel(m.provider, m.model), ...(override || {}) };
        return {
          ...m,
          name: resolveModelName(modelNames, m.provider, m.model, m.name),
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
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
    const seenFull = new Set(models.map((m) => m.fullModel));
    const customModels = (await getCustomModels()).filter((m) => {
      if (!m?.id || (m.kind || m.type || "llm") !== "llm") return false;
      return !seenFull.has(`${m.providerAlias}/${m.id}`);
    });
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
