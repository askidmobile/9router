import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { COMBO_HEALTH_STORAGE_CONFIG } from "../../../../open-sse/config/comboHealth.js";

const { scope, lockKey } = COMBO_HEALTH_STORAGE_CONFIG;

export function comboHealthKey(provider, model) {
  return JSON.stringify([provider, model]);
}

// The callback must be synchronous: no await/yield between reading a lease and
// writing the claim. The initial no-op UPDATE obtains SQLite's write lock before
// reading, also serializing claims made by different server processes.
export function createComboHealthRepository(resolveAdapter = getAdapter) {
  function access(db) {
    return {
      get(provider, model) {
        const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [scope, comboHealthKey(provider, model)]);
        return row ? readRecord(row.value) : null;
      },
      list() {
        return db.all("SELECT value FROM kv WHERE scope = ? AND key != ?", [scope, lockKey])
          .map((row) => readRecord(row.value));
      },
      set(record) {
        db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [scope, comboHealthKey(record.provider, record.model), stringifyJson(record)]);
      },
      remove(provider, model) {
        db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [scope, comboHealthKey(provider, model)]);
      },
    };
  }

  return {
    async get(provider, model) { return access(await resolveAdapter()).get(provider, model); },
    async list() { return access(await resolveAdapter()).list(); },
    async transaction(callback) {
      const db = await resolveAdapter();
      return db.transaction(() => {
        db.run("UPDATE kv SET value = value WHERE scope = ? AND key = ?", [scope, lockKey]);
        const result = callback(access(db));
        if (result?.then) throw new Error("Combo health transaction callback must be synchronous");
        return result;
      });
    },
  };
}

function readRecord(value) {
  const record = parseJson(value);
  if (!record || typeof record.provider !== "string" || typeof record.model !== "string"
    || !["open", "probing"].includes(record.state)) {
    throw new Error("Invalid persisted Combo health record");
  }
  return record;
}

export const comboHealthRepository = createComboHealthRepository();
