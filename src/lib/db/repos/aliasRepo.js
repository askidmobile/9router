import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getProviderAlias, resolveProviderId } from "@/shared/constants/providers";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Explicit additions must also leave a previously cleared/limited provider list.
function selectAddedModel(db, providerAlias, id) {
  const alias = getProviderAlias(resolveProviderId(providerAlias));
  for (const row of db.all('SELECT id,provider,data FROM providerConnections')) {
    if (getProviderAlias(row.provider) !== alias && row.provider !== providerAlias) continue;
    const data = parseJson(row.data) || {};
    const selected = data.providerSpecificData?.enabledModels;
    if (!Array.isArray(selected) || selected.includes(id)) continue;
    const providerSpecificData = { ...data.providerSpecificData, enabledModels: [...selected, id] };
    db.run('UPDATE providerConnections SET data=?,updatedAt=? WHERE id=?', [stringifyJson({ ...data, providerSpecificData }), new Date().toISOString(), row.id]);
  }
  for (const key of new Set([alias, providerAlias])) {
    const row = db.get("SELECT value FROM kv WHERE scope='disabledModels' AND key=?", [key]);
    if (row) db.run("UPDATE kv SET value=? WHERE scope='disabledModels' AND key=?", [stringifyJson((parseJson(row.value) || []).filter(disabled => disabled !== id)), key]);
  }
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name/transport without resetting omitted fields.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps, transport }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    selectAddedModel(db, providerAlias, id);
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(prev.catalogOnly ? { catalogOnly: false } : {}), ...(name ? { name } : {}), ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}), ...(transport ? { transport } : {}) });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// Bulk insert in one transaction; existing keys are skipped (same rule as addCustomModel)
export async function addCustomModelsBulk({ providerAlias, type = "llm", ids = [], catalogOnly = false }) {
  const db = await getAdapter();
  let added = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const id of ids) {
      if (!catalogOnly) selectAddedModel(db, providerAlias, id);
      const k = customKey(providerAlias, id, type);
      const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
      if (row) {
        const previous = parseJson(row.value);
        if (previous?.catalogOnly && !catalogOnly) db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson({ ...previous, catalogOnly: false }), k]);
        skipped += 1;
        continue;
      }
      const value = stringifyJson({ providerAlias, id, type, name: id, ...(catalogOnly ? { catalogOnly: true } : {}) });
      db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
      added += 1;
    }
  });
  return { added, skipped };
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
