import { makeKv } from "../helpers/kvStore.js";
import { modelNameKey } from "@/shared/utils/modelNames.js";

// Names are presentation metadata; editing one never registers or aliases a model.
const namesKv = makeKv("modelNames");

export async function getModelNameOverrides() {
  return namesKv.getAll();
}

export async function setModelNameOverride(provider, model, name) {
  const key = modelNameKey(provider, model);
  if (name) await namesKv.set(key, name);
  else await namesKv.remove(key);
}
