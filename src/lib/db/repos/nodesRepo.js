import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProviderNodes(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.type) { where.push("type = ?"); params.push(filter.type); }
  const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return db.all(sql, params).map(rowToNode);
}

export async function getProviderNodeById(id) {
  const db = await getAdapter();
  return rowToNode(db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]));
}

export async function createProviderNode(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, node);
  return node;
}

export async function updateProviderNode(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    const previous = rowToNode(row);
    const merged = { ...previous, ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    // Combo members address the node by prefix, so a rename leaves them pointing
    // at a prefix nobody owns — or, worse, at a built-in provider that does.
    // Set after upsert so the field is not persisted into the node row.
    merged.renamedCombos = previous.prefix && merged.prefix && previous.prefix !== merged.prefix
      ? retargetComboMembers(db, previous.prefix, merged.prefix)
      : [];
    result = merged;
  });
  return result;
}

// Repoint `<from>/model` combo members at `<to>/model` after a prefix rename.
function retargetComboMembers(db, from, to) {
  return rewriteComboModels(db, (models) => models.map((m) => (
    typeof m === "string" && m.startsWith(`${from}/`) ? `${to}/${m.slice(from.length + 1)}` : m
  )));
}

// Everything a user-created node owns lives outside the providerNodes row:
// custom models, aliases, disabled list, caps/pricing overrides (all keyed by
// the node id) and combo members (keyed by the display prefix). Dropping only
// the row leaves the provider alive in the Models page, the combos and
// /v1/models — so purge it all here, where every caller passes through.
// Returns the names of combos whose model list changed.
function purgeNodeData(db, nodeId, prefix) {
  const ownsKey = (key) => key === nodeId || key.startsWith(`${nodeId}|`);
  for (const scope of ["customModels", "modelCaps", "disabledModels", "pricing"]) {
    for (const row of db.all(`SELECT key FROM kv WHERE scope = ?`, [scope])) {
      if (ownsKey(row.key)) db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, row.key]);
    }
  }

  // modelAliases key on the alias name — the node id sits in the value.
  for (const row of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) {
    const target = parseJson(row.value, "");
    if (typeof target === "string" && target.startsWith(`${nodeId}/`)) {
      db.run(`DELETE FROM kv WHERE scope = 'modelAliases' AND key = ?`, [row.key]);
    }
  }

  // Combo members address the node by its routing prefix ("oc-zen/glm-4.7"),
  // older ones by the raw id.
  const owners = [nodeId, prefix].filter(Boolean);
  const isMember = (m) => owners.some((o) => m === o || m.startsWith(`${o}/`));
  return rewriteComboModels(db, (models) => models.filter((m) => !(typeof m === "string" && isMember(m))));
}

// Apply `transform` to every combo's model list; rows that come back unchanged
// are left alone. Returns the names of the combos that were rewritten.
function rewriteComboModels(db, transform) {
  const touched = [];
  const now = new Date().toISOString();
  for (const row of db.all(`SELECT id, name, models FROM combos`)) {
    const models = parseJson(row.models, []) || [];
    const next = transform(models);
    if (stringifyJson(next) === stringifyJson(models)) continue;
    db.run(`UPDATE combos SET models = ?, updatedAt = ? WHERE id = ?`, [stringifyJson(next), now, row.id]);
    touched.push(row.name);
  }
  return touched;
}

export async function deleteProviderNode(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToNode(row);
    db.run(`DELETE FROM providerNodes WHERE id = ?`, [id]);
    removed.purgedCombos = purgeNodeData(db, id, removed.prefix);
  });
  return removed;
}
