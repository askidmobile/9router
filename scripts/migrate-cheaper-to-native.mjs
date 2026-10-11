// One-shot migration: the user-defined `cheaper` openai-compatible node becomes the
// native `cheaper` provider (registry entry with the 4.5 MB request-body cap).
//
// It re-points the existing connection at the native provider id, moves every
// per-provider KV row (customModels, modelCaps, modelNames, pricing, disabledModels)
// to that id, then removes the node so its prefix cannot shadow the built-in provider.
// Every column of the connection row is preserved — only `provider` (and the
// node-only endpoint fields inside `data`) change. Idempotent: a second run is a no-op.
//
// scripts/ is not part of the runtime image, so pipe it in:
//   docker exec -i 9router node --input-type=module - < scripts/migrate-cheaper-to-native.mjs
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.DB_PATH || "/app/data/db/data.sqlite";
const PREFIX = "cheaper";
const NATIVE_ID = "cheaper";
const BACKUP_DIR = process.env.BACKUP_DIR || "/app/data/db/backups";
// Node-only connection fields: a native provider reads its endpoint from the registry.
const NODE_DATA_KEYS = ["prefix", "apiType", "baseUrl", "nodeName"];
const KEY_SCOPES = ["customModels", "modelCaps", "modelNames"];

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 10000");
const now = new Date().toISOString();
const summary = { backup: null, node: null, connection: null, kv: {}, removed: {} };

const node = db.prepare("SELECT * FROM providerNodes").all()
  .find((row) => { try { return JSON.parse(row.data || "{}").prefix === PREFIX; } catch { return false; } }) || null;

if (!node) {
  console.log(JSON.stringify({ ...summary, status: "nothing to do: no node with that prefix" }, null, 1));
  process.exit(0);
}
summary.node = { id: node.id, type: node.type, name: node.name };

// Consistent copy first: VACUUM INTO folds the live WAL into a single file.
const backupFile = `${BACKUP_DIR}/pre-cheaper-native-${now.replace(/[:.]/g, "-")}.sqlite`;
db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
summary.backup = backupFile;

const existing = db.prepare("SELECT id, name FROM providerConnections WHERE provider = ?").all(NATIVE_ID);
const source = db.prepare("SELECT * FROM providerConnections WHERE provider = ?").all(node.id)[0] || null;

if (!existing.length) {
  if (!source) throw new Error(`no connection found for node ${node.id}`);
  const data = JSON.parse(source.data || "{}");
  for (const key of NODE_DATA_KEYS) delete data[key];
  if (data.providerSpecificData && typeof data.providerSpecificData === "object") {
    for (const key of NODE_DATA_KEYS) delete data.providerSpecificData[key];
  }
  db.prepare("UPDATE providerConnections SET provider = ?, data = ?, updatedAt = ? WHERE id = ?")
    .run(NATIVE_ID, JSON.stringify(data), now, source.id);
  summary.connection = { id: source.id, name: source.name, movedFrom: node.id };
} else {
  summary.connection = { id: existing[0].id, name: existing[0].name, reused: true };
}

// A stale node id must not keep resolving: drop its connections and the node row.
summary.removed.connections = db.prepare("DELETE FROM providerConnections WHERE provider = ?").run(node.id).changes;
summary.removed.node = db.prepare("DELETE FROM providerNodes WHERE id = ?").run(node.id).changes;

const placeholders = [...KEY_SCOPES, "pricing", "disabledModels"].map(() => "?").join(",");
const rows = db.prepare(`SELECT rowid, scope, key, value FROM kv WHERE scope IN (${placeholders})`).all(...KEY_SCOPES, "pricing", "disabledModels");
// OR REPLACE: a partially migrated row must not abort the run on the (scope, key) PK.
const rename = db.prepare("UPDATE OR REPLACE kv SET key = ? WHERE rowid = ?");
const setValue = db.prepare("UPDATE kv SET value = ? WHERE rowid = ?");
for (const row of rows) {
  let nextKey = null;
  if (KEY_SCOPES.includes(row.scope) && row.key.startsWith(`${node.id}|`)) {
    nextKey = `${NATIVE_ID}|${row.key.slice(node.id.length + 1)}`;
    if (row.scope === "customModels") {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed?.providerAlias === node.id) setValue.run(JSON.stringify({ ...parsed, providerAlias: NATIVE_ID }), row.rowid);
      } catch { /* leave unparsable values untouched */ }
    }
  } else if (row.key === node.id) {
    nextKey = NATIVE_ID;
  }
  if (!nextKey) continue;
  rename.run(nextKey, row.rowid);
  summary.kv[row.scope] = (summary.kv[row.scope] || 0) + 1;
}

console.log(JSON.stringify({ ...summary, status: "migrated" }, null, 1));
