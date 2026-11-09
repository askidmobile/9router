// Preview by default. Apply only against a deployment that already includes qubax.
// DB_PATH=/path/to/data.sqlite node scripts/migrate-qubax-to-native.mjs [--apply]
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

if (!process.env.DB_PATH) throw new Error("DB_PATH is required");
const apply = process.argv.includes("--apply");
const db = new DatabaseSync(process.env.DB_PATH, { readOnly: !apply });
db.exec("PRAGMA busy_timeout = 10000");
const nativeId = "qubax";
const scopes = ["customModels", "modelCaps", "modelNames", "pricing", "pricingMeta", "disabledModels", "modelHealth"];
const nodeFields = ["prefix", "apiType", "baseUrl", "nodeName"];
const nodes = db.prepare("SELECT * FROM providerNodes").all().filter(row => {
  if (row.type !== "openai-compatible") return false;
  try {
    const data = JSON.parse(row.data);
    const url = new URL(data.baseUrl);
    return url.origin === "https://api.qubax.ai" && /^\/v1\/?$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
});
if (nodes.length > 1) throw new Error("Multiple Qubax custom nodes found; migrate them individually");
const node = nodes[0];
if (!node) {
  console.log(JSON.stringify({ status: "nothing to migrate" }));
  db.close();
  process.exit(0);
}
const prefix = JSON.parse(node.data).prefix;
const owners = new Set([node.id, prefix].filter(Boolean));
const connections = db.prepare("SELECT * FROM providerConnections WHERE provider = ?").all(node.id);
if (!connections.length) throw new Error("No connections found for the Qubax custom node");
const rows = db.prepare("SELECT * FROM kv").all();
const selected = rows.filter(row => row.scope === "customModels").map(row => JSON.parse(row.value))
  .filter(model => owners.has(model.providerAlias) && model.catalogOnly !== true && (model.type || "llm") === "llm")
  .map(model => model.id);
const retarget = value => {
  if (typeof value !== "string") return value;
  for (const owner of owners) {
    if (value.startsWith(`${owner}/`)) return `${nativeId}/${value.slice(owner.length + 1)}`;
  }
  return value;
};
const summary = { status: apply ? "migrated" : "dry-run", nodeId: node.id, prefix, connections: connections.length, selectedModels: selected.length };
if (!apply) {
  console.log(JSON.stringify(summary));
  db.close();
  process.exit(0);
}

const now = new Date().toISOString();
const backupDir = process.env.BACKUP_DIR || join(dirname(process.env.DB_PATH), "backups");
mkdirSync(backupDir, { recursive: true });
const backup = join(backupDir, `pre-qubax-native-${now.replace(/[:.]/g, "-")}.sqlite`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
db.exec("BEGIN IMMEDIATE");
try {
  for (const connection of connections) {
    const data = JSON.parse(connection.data);
    for (const key of nodeFields) delete data[key];
    data.providerSpecificData = { ...data.providerSpecificData };
    for (const key of nodeFields) delete data.providerSpecificData[key];
    // Native seed models must not silently expand the user's selected model list.
    if (!Array.isArray(data.providerSpecificData.enabledModels)) data.providerSpecificData.enabledModels = [...new Set(selected)];
    db.prepare("UPDATE providerConnections SET provider = ?, data = ?, updatedAt = ? WHERE id = ?")
      .run(nativeId, JSON.stringify(data), now, connection.id);
  }
  for (const row of rows) {
    if (row.scope === "modelAliases") {
      const value = JSON.parse(row.value);
      const next = retarget(value);
      if (next !== value) db.prepare("UPDATE kv SET value = ? WHERE scope = ? AND key = ?").run(JSON.stringify(next), row.scope, row.key);
      continue;
    }
    if (!scopes.includes(row.scope)) continue;
    const owner = [...owners].find(owner => row.key === owner || row.key.startsWith(`${owner}|`));
    if (!owner) continue;
    const key = nativeId + row.key.slice(owner.length);
    // Abort rather than replace a user's existing native overrides.
    if (key !== row.key && db.prepare("SELECT 1 FROM kv WHERE scope = ? AND key = ?").get(row.scope, key)) {
      throw new Error(`Conflicting native data in ${row.scope}: ${key}`);
    }
    let value = row.value;
    if (row.scope === "customModels") value = JSON.stringify({ ...JSON.parse(value), providerAlias: nativeId });
    db.prepare("UPDATE kv SET key = ?, value = ? WHERE scope = ? AND key = ?").run(key, value, row.scope, row.key);
  }
  for (const combo of db.prepare("SELECT id, models FROM combos").all()) {
    const models = JSON.parse(combo.models).map(retarget);
    if (JSON.stringify(models) !== combo.models) db.prepare("UPDATE combos SET models = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(models), now, combo.id);
  }
  for (const key of db.prepare("SELECT id, accessAllow FROM apiKeys WHERE accessAllow IS NOT NULL").all()) {
    const allow = JSON.parse(key.accessAllow).map(retarget);
    if (JSON.stringify(allow) !== key.accessAllow) db.prepare("UPDATE apiKeys SET accessAllow = ? WHERE id = ?").run(JSON.stringify(allow), key.id);
  }
  db.prepare("DELETE FROM providerNodes WHERE id = ?").run(node.id);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}
console.log(JSON.stringify({ ...summary, backup }));
