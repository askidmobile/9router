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
// prefix → native provider id. The combo members already route by prefix, and
// the native alias is the same string, so no combo edit is needed.
const TARGETS = [
  { prefix: "req", nativeId: "requesty" },
  { prefix: "apinex", nativeId: "apinex" },
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
if (todo.length === 0) {
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
  for (const { prefix, nativeId } of todo) {
    const node = byPrefix.get(prefix);
    const entry = { prefix, nativeId, nodeId: node.id, connection: null, kv: {}, removed: {} };

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
        nextKey = `${nativeId}|${row.key.slice(node.id.length + 1)}`;
        if (row.scope === "customModels") {
          try {
            const parsed = JSON.parse(row.value);
            if (parsed?.providerAlias === node.id) setValue.run(JSON.stringify({ ...parsed, providerAlias: nativeId }), row.rowid);
          } catch { /* leave unparsable values untouched */ }
        }
      } else if (row.key === node.id) {
        nextKey = nativeId;
      }
      if (!nextKey) continue;
      rename.run(nextKey, row.rowid);
      entry.kv[row.scope] = (entry.kv[row.scope] || 0) + 1;
    }
    summary.moved.push(entry);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(JSON.stringify({ ...summary, status: "migrated" }, null, 1));
