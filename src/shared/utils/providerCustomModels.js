import { getProviderAlias } from "@/shared/constants/providers";
import { findModelName } from "open-sse/config/providerModels.js";

function modelType(model) {
  return model?.kind || model?.type || "llm";
}

export function getProviderCustomModelRows({
  customModels = [],
  modelAliases = {},
  providerAlias,
  builtInModels = [],
  type = "llm",
  includeLegacyAliases = true,
}) {
  const builtInIds = new Set(builtInModels.map((model) => model.id));
  const seenFullModels = new Set();
  const rows = [];
  const catalogIds = new Set(customModels.filter(model => model.catalogOnly === true && getProviderAlias(model.providerAlias) === getProviderAlias(providerAlias)).map(model => model.id));

  // A registered custom model can also carry an alias. The legacy-alias pass
  // below skips it as already seen, so look the alias up here or the provider
  // pages would show (and edit) the model as if it had none.
  const aliasByFullModel = {};
  for (const [aliasName, target] of Object.entries(modelAliases || {})) {
    if (typeof target === "string") aliasByFullModel[target] = aliasName;
  }

  for (const model of customModels) {
    if (!model?.id || model.catalogOnly === true || getProviderAlias(model.providerAlias) !== getProviderAlias(providerAlias)) continue;
    const rowType = modelType(model);
    if (type && rowType !== type) continue;
    if (builtInIds.has(model.id)) continue;

    const fullModel = `${providerAlias}/${model.id}`;
    if (seenFullModels.has(fullModel)) continue;
    seenFullModels.add(fullModel);
    // A name equal to the id carries no information (bulk imports used to store
    // it that way), so prefer the registry label when one exists — otherwise an
    // opaque upstream key like Qoder's `qmodel_38max` is all the card ever shows.
    const savedName = model.name && model.name !== model.id ? model.name : null;
    rows.push({
      id: model.id,
      name: savedName || findModelName(providerAlias, model.id) || model.id,
      alias: aliasByFullModel[fullModel],
      fullModel,
      source: "custom",
      type: rowType,
    });
  }

  if (!includeLegacyAliases) return rows;

  const prefix = `${providerAlias}/`;
  for (const [alias, fullModel] of Object.entries(modelAliases || {})) {
    if (typeof fullModel !== "string" || !fullModel.startsWith(prefix)) continue;
    const id = fullModel.slice(prefix.length);
    if (!id || catalogIds.has(id) || builtInIds.has(id) || seenFullModels.has(fullModel)) continue;

    seenFullModels.add(fullModel);
    rows.push({
      id,
      alias,
      fullModel,
      source: "legacyAlias",
      type: type || "llm",
    });
  }

  return rows;
}
