// One-shot migration: the user-defined `req` and `apinex` openai-compatible
// nodes become native providers (registry entries `requesty` / `apinex` with
// their own catalog source and transports).
//
// Same contract as migrate-cheaper-to-native.mjs: re-point each connection at
// the native provider id, move every per-provider KV row to that id, then drop
// the node so its prefix cannot shadow the built-in provider. Idempotent.
//
//   docker exec -i 9router node --input-type=module - < scripts/migrate-requesty-apinex-to-native.mjs
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "/app/data/db/data.sqlite";
const BACKUP_DIR = process.env.BACKUP_DIR || "/app/data/db/backups";
const NODE_DATA_KEYS = ["prefix", "apiType", "baseUrl", "nodeName"];
const KEY_SCOPES = ["customModels", "modelCaps", "modelNames"];
// prefix → native provider id + the alias every per-provider row is keyed by.
// The router stores caps/pricing/custom models under the ALIAS (see
// getProviderAlias() consumers: models page, combo caps, modelReasoning), so
// rows written under the registry id are invisible at runtime. Combos keep
// routing by the prefix, which is the alias, so no combo edit is needed.
const TARGETS = [
  { prefix: "req", nativeId: "requesty", storageAlias: "req" },
  { prefix: "apinex", nativeId: "apinex", storageAlias: "apinex" },
];

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 10000");
const now = new Date().toISOString();
const summary = { backup: null, moved: [] };

const nodes = db.prepare("SELECT * FROM providerNodes").all();
const byPrefix = new Map();
for (const row of nodes) {
  try {
    const prefix = JSON.parse(row.data || "{}").prefix;
    if (prefix) byPrefix.set(prefix, row);
  } catch { /* unparsable node data is left alone */ }
}

const todo = TARGETS.filter((t) => byPrefix.has(t.prefix));
// Also repair rows a previous run of this script wrote under the registry id
// instead of the alias. Rewriting them is safe: the alias key is what the
// runtime reads, and the id key is never consulted for a built-in provider.
const repairs = TARGETS.filter((t) => t.nativeId !== t.storageAlias);

if (todo.length === 0 && repairs.length === 0) {
  console.log(JSON.stringify({ ...summary, status: "nothing to do: no matching nodes" }, null, 1));
  process.exit(0);
}

// Consistent copy first: VACUUM INTO folds the live WAL into a single file.
const backupFile = `${BACKUP_DIR}/pre-requesty-apinex-native-${now.replace(/[:.]/g, "-")}.sqlite`;
db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
summary.backup = backupFile;

const placeholders = [...KEY_SCOPES, "pricing", "disabledModels"].map(() => "?").join(",");
const rename = db.prepare("UPDATE OR REPLACE kv SET key = ? WHERE rowid = ?");
const setValue = db.prepare("UPDATE kv SET value = ? WHERE rowid = ?");

db.exec("BEGIN IMMEDIATE");
try {
  for (const { prefix, nativeId, storageAlias } of todo) {
    const node = byPrefix.get(prefix);
    const entry = { prefix, nativeId, storageAlias, nodeId: node.id, connection: null, kv: {}, removed: {} };

    const existing = db.prepare("SELECT id, name FROM providerConnections WHERE provider = ?").all(nativeId);
    const source = db.prepare("SELECT * FROM providerConnections WHERE provider = ?").all(node.id)[0] || null;
    if (!existing.length) {
      if (!source) throw new Error(`no connection found for node ${node.id}`);
      const data = JSON.parse(source.data || "{}");
      for (const key of NODE_DATA_KEYS) delete data[key];
      if (data.providerSpecificData && typeof data.providerSpecificData === "object") {
        for (const key of NODE_DATA_KEYS) delete data.providerSpecificData[key];
      }
      db.prepare("UPDATE providerConnections SET provider = ?, data = ?, updatedAt = ? WHERE id = ?")
        .run(nativeId, JSON.stringify(data), now, source.id);
      entry.connection = { id: source.id, name: source.name, movedFrom: node.id };
    } else {
      entry.connection = { id: existing[0].id, name: existing[0].name, reused: true };
    }

    entry.removed.connections = db.prepare("DELETE FROM providerConnections WHERE provider = ?").run(node.id).changes;
    entry.removed.node = db.prepare("DELETE FROM providerNodes WHERE id = ?").run(node.id).changes;

    const rows = db.prepare(`SELECT rowid, scope, key, value FROM kv WHERE scope IN (${placeholders})`)
      .all(...KEY_SCOPES, "pricing", "disabledModels");
    for (const row of rows) {
      let nextKey = null;
      if (KEY_SCOPES.includes(row.scope) && row.key.startsWith(`${node.id}|`)) {
        nextKey = `${storageAlias}|${row.key.slice(node.id.length + 1)}`;
        if (row.scope === "customModels") {
          try {
            const parsed = JSON.parse(row.value);
            if (parsed?.providerAlias === node.id) setValue.run(JSON.stringify({ ...parsed, providerAlias: storageAlias }), row.rowid);
          } catch { /* leave unparsable values untouched */ }
        }
      } else if (row.key === node.id) {
        nextKey = storageAlias;
      }
      if (!nextKey) continue;
      rename.run(nextKey, row.rowid);
      entry.kv[row.scope] = (entry.kv[row.scope] || 0) + 1;
    }
    summary.moved.push(entry);
  }

  for (const { nativeId, storageAlias } of repairs) {
    const repaired = { alias: storageAlias, moved: 0, merged: 0 };
    for (const scope of [...KEY_SCOPES, "pricing", "disabledModels"]) {
      const idRows = db.prepare("SELECT rowid, key, value FROM kv WHERE scope = ? AND (key = ? OR key LIKE ?)")
        .all(scope, nativeId, `${nativeId}|%`);
      for (const row of idRows) {
        const suffix = row.key === nativeId ? "" : row.key.slice(nativeId.length);
        const aliasKey = `${storageAlias}${suffix}`;
        const existing = db.prepare("SELECT rowid, value FROM kv WHERE scope = ? AND key = ?").get(scope, aliasKey);
        if (!existing) {
          rename.run(aliasKey, row.rowid);
          repaired.moved++;
          continue;
        }
        // Both spellings carry data: merge the id row over the alias row so the
        // older, user-edited values survive, then delete the id row.
        try {
          const merged = { ...JSON.parse(existing.value), ...JSON.parse(row.value) };
          setValue.run(JSON.stringify(merged), existing.rowid);
        } catch { /* non-object values: the alias row wins */ }
        db.prepare("DELETE FROM kv WHERE rowid = ?").run(row.rowid);
        repaired.merged++;
      }
    }
    if (repaired.moved || repaired.merged) summary.repaired = [...(summary.repaired || []), repaired];
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(JSON.stringify({ ...summary, status: "migrated" }, null, 1));
