import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";

let dir, db, dbPath;
const nodeId = "openai-compatible-chat-qubax-test";
const key = (scope, key) => JSON.parse(db.prepare("SELECT value FROM kv WHERE scope=? AND key=?").get(scope, key)?.value || "null");
const put = (scope, key, value) => db.prepare("INSERT INTO kv VALUES(?,?,?)").run(scope, key, JSON.stringify(value));
const run = (apply = false) => JSON.parse(execFileSync(process.execPath, [resolve("scripts/migrate-qubax-to-native.mjs"), ...(apply ? ["--apply"] : [])], {
  env: { ...process.env, DB_PATH: dbPath }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "9router-qubax-migration-"));
  dbPath = join(dir, "data.sqlite");
  db = new DatabaseSync(dbPath);
  for (const [name, def] of Object.entries(TABLES)) db.exec(buildCreateTableSql(name, def));
  db.prepare("INSERT INTO providerNodes(id,type,name,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)")
    .run(nodeId, "openai-compatible", "Qubax AI", JSON.stringify({ prefix: "old-qubax", baseUrl: "https://api.qubax.ai/v1", apiType: "chat" }), "before", "before");
  for (const [id, enabledModels] of [["c1", undefined], ["c2", []]]) {
    db.prepare("INSERT INTO providerConnections(id,provider,authType,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)")
      .run(id, nodeId, "apikey", JSON.stringify({ apiKey: `secret-${id}`, providerSpecificData: { baseUrl: "https://api.qubax.ai/v1", apiType: "chat", prefix: "old-qubax", connectionProxyUrl: "http://proxy.test", ...(enabledModels ? { enabledModels } : {}) } }), "before", "before");
  }
  put("customModels", `${nodeId}|m1|llm`, { providerAlias: nodeId, id: "m1", type: "llm", name: "My model" });
  put("customModels", `${nodeId}|catalog-only|llm`, { providerAlias: nodeId, id: "catalog-only", type: "llm", catalogOnly: true });
  put("modelCaps", `${nodeId}|m1`, { manual: { contextWindow: 1000 } });
  put("modelNames", "old-qubax|m1", "My name");
  put("pricing", nodeId, { m1: { input: 1 } });
  put("pricingMeta", nodeId, { m1: { source: "manual" } });
  put("disabledModels", nodeId, ["m2"]);
  put("modelAliases", "my-model", `${nodeId}/m1`);
  put("customModels", "keeper|m|llm", { providerAlias: "keeper", id: "m", type: "llm" });
  db.prepare("INSERT INTO combos(id,name,models,createdAt,updatedAt) VALUES(?,?,?,?,?)").run("combo", "combo", JSON.stringify(["old-qubax/m1", `${nodeId}/m1`, "oai/gpt-4o"]), "before", "before");
  db.prepare("INSERT INTO apiKeys(id,key,createdAt,accessRestricted,accessAllow) VALUES(?,?,?,?,?)").run("key", "router-key", "before", 1, JSON.stringify(["old-qubax/m1", `${nodeId}/m1`, "oai/gpt-4o"]));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("Qubax custom-to-native migration", () => {
  it("previews without modifying data or creating a backup", () => {
    expect(run()).toMatchObject({ status: "dry-run", connections: 2, selectedModels: 1 });
    expect(db.prepare("SELECT provider FROM providerConnections WHERE id='c1'").get().provider).toBe(nodeId);
    expect(readdirSync(dir)).toEqual(["data.sqlite"]);
  });

  it("backs up and preserves every connection, selections, overrides and routing reference", () => {
    const result = run(true);
    expect(result.status).toBe("migrated");
    const backup = new DatabaseSync(result.backup, { readOnly: true });
    expect(backup.prepare("SELECT provider FROM providerConnections WHERE id='c1'").get().provider).toBe(nodeId);
    backup.close();
    const connections = db.prepare("SELECT * FROM providerConnections ORDER BY id").all();
    expect(connections.map(row => row.provider)).toEqual(["qubax", "qubax"]);
    expect(JSON.parse(connections[0].data)).toEqual({ apiKey: "secret-c1", providerSpecificData: { connectionProxyUrl: "http://proxy.test", enabledModels: ["m1"] } });
    expect(JSON.parse(connections[1].data).providerSpecificData.enabledModels).toEqual([]);
    expect(db.prepare("SELECT * FROM providerNodes").all()).toEqual([]);
    expect(key("customModels", "qubax|m1|llm")).toMatchObject({ providerAlias: "qubax", name: "My model" });
    expect(key("customModels", "keeper|m|llm").providerAlias).toBe("keeper");
    expect(key("modelCaps", "qubax|m1")).toEqual({ manual: { contextWindow: 1000 } });
    expect(key("modelNames", "qubax|m1")).toBe("My name");
    expect(key("pricing", "qubax")).toEqual({ m1: { input: 1 } });
    expect(key("pricingMeta", "qubax")).toEqual({ m1: { source: "manual" } });
    expect(key("disabledModels", "qubax")).toEqual(["m2"]);
    expect(key("modelAliases", "my-model")).toBe("qubax/m1");
    expect(JSON.parse(db.prepare("SELECT models FROM combos").get().models)).toEqual(["qubax/m1", "qubax/m1", "oai/gpt-4o"]);
    const access = db.prepare("SELECT accessRestricted,accessAllow FROM apiKeys").get();
    expect(access.accessRestricted).toBe(1);
    expect(JSON.parse(access.accessAllow)).toEqual(["qubax/m1", "qubax/m1", "oai/gpt-4o"]);
    expect(run(true)).toEqual({ status: "nothing to migrate" });
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
  });

  it("rolls back completely on a native override collision", () => {
    put("pricing", "qubax", { m1: { input: 99 } });
    expect(() => run(true)).toThrow();
    expect(db.prepare("SELECT provider FROM providerConnections WHERE id='c1'").get().provider).toBe(nodeId);
    expect(db.prepare("SELECT id FROM providerNodes").get().id).toBe(nodeId);
    expect(key("pricing", "qubax")).toEqual({ m1: { input: 99 } });
    expect(key("customModels", `${nodeId}|m1|llm`).providerAlias).toBe(nodeId);
  });

  it("does not identify a provider by name or a lookalike host", () => {
    db.prepare("UPDATE providerNodes SET data=?").run(JSON.stringify({ prefix: "qubax", baseUrl: "https://api.qubax.ai.example/v1" }));
    expect(run(true)).toEqual({ status: "nothing to migrate" });
    expect(db.prepare("SELECT count(*) AS n FROM providerConnections WHERE provider=?").get(nodeId).n).toBe(2);
  });
});
