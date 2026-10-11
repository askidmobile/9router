#!/usr/bin/env node
// Refresh only models already configured on the DSH 9router connection.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const OBSERVED = new Set(["provider", "models.dev", "manual", "legacy"]);
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const scalar = value => {
  const s = value.trim();
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith("!") || s.includes("\n")) throw new Error("Dynamic YAML values need an explicit static connection");
  return s;
};
const indent = line => line.length - line.trimStart().length;
function section(lines, name) {
  const start = lines.findIndex(line => line.trim() === name + ":");
  if (start < 0) throw new Error("DSH provider section not found: " + name);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].trimStart().startsWith("#") || indent(lines[end]) > indent(lines[start]))) end++;
  return { start, end, indent: indent(lines[start]) };
}
function readField(lines, name, depth) {
  const start = lines.findIndex(line => indent(line) === depth && line.trimStart().startsWith(name + ":"));
  if (start < 0) return undefined;
  const value = lines[start].trim().slice(name.length + 1).trim();
  if (["contextWindow", "maxTokens"].includes(name)) return Number(value);
  if (value === "false") return false;
  const result = {};
  for (let i = start + 1; i < lines.length && indent(lines[i]) > depth; i++) {
    const match = lines[i].trim().match(/^([a-z]+):\s*(.*)$/);
    if (match) result[match[1]] = match[2] ? scalar(match[2]) : null;
  }
  return result;
}
function writeField(lines, name, value, depth) {
  const start = lines.findIndex(line => indent(line) === depth && line.trimStart().startsWith(name + ":"));
  let end = start < 0 ? lines.length : start + 1;
  if (start >= 0) while (end < lines.length && (!lines[end].trim() || indent(lines[end]) > depth)) end++;
  const pad = " ".repeat(depth);
  const inserted = value && typeof value === "object"
    ? [pad + name + ":", ...Object.entries(value).map(([key, wire]) => pad + "  " + key + ": " + (wire === null ? "null" : JSON.stringify(wire)))]
    : [pad + name + ": " + String(value)];
  return [...lines.slice(0, start < 0 ? lines.length : start), ...inserted, ...lines.slice(end)];
}
export function connectionFromProfile(text, provider = "nine-router") {
  const lines = text.split("\n"), s = section(lines, provider);
  const read = key => {
    const line = lines.slice(s.start + 1, s.end).find(l => indent(l) === s.indent + 2 && l.trimStart().startsWith(key + ":"));
    return line ? scalar(line.trim().slice(key.length + 1)) : null;
  };
  const url = read("baseURL") || read("baseUrl");
  const key = read("apiKey") || (read("apiKeyEnv") ? process.env[read("apiKeyEnv")] : null);
  if (!url || !key) throw new Error("DSH 9router base URL/API key is not statically configured");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new Error("Use HTTPS for the DSH catalog connection");
  if (parsed.username || parsed.password) throw new Error("Credentials in the catalog URL are unsupported");
  return { url: url.replace(/\/$/, "") + "/models", key };
}
export function syncDshProfile(text, models, previous = {}, provider = "nine-router") {
  const lines = text.split("\n"), s = section(lines, provider);
  const byId = new Map(models.map(m => [m.id, m]));
  const body = lines.slice(s.start + 1, s.end);
  const starts = body.flatMap((line, i) => /^\s*- id: /.test(line) ? [i] : []);
  const state = { ...previous }, changes = [], missing = [], unsupported = [];
  for (let n = starts.length - 1; n >= 0; n--) {
    const start = starts[n];
    let end = starts[n + 1] ?? body.length;
    for (let i = start + 1; i < end; i++) {
      if (body[i].trim() && !body[i].trimStart().startsWith("#") && indent(body[i]) < indent(body[start])) { end = i; break; }
    }
    let block = body.slice(start, end);
    const id = scalar(block[0].trim().slice(6)), model = byId.get(id);
    if (!model) { missing.push(id); continue; }
    const depth = indent(block[0]) + 2, caps = model.capabilities || {};
    const sources = model.capability_sources || {}, offered = {};
    for (const [wire, field] of [["contextWindow", "contextWindow"], ["maxTokens", "maxOutput"]]) {
      const value = field === "contextWindow" ? model.context_length ?? caps[field] : model.max_output_tokens ?? caps[field];
      if (Number.isSafeInteger(value) && value > 0 && OBSERVED.has(sources[field]?.source)) offered[wire] = value;
    }
    const raw = model.reasoning_levels ?? caps.reasoningLevels;
    if (caps.reasoning === false && OBSERVED.has(sources.reasoning?.source)) {
      offered.reasoningEfforts = false;
    } else if (Array.isArray(raw) && OBSERVED.has(sources.reasoningLevels?.source)) {
      const mapped = Object.fromEntries(raw.filter(l => l === "none" || LEVELS.includes(l)).map(l => [l === "none" ? "off" : l, l]));
      const unavailable = raw.filter(l => l !== "none" && !LEVELS.includes(l));
      if (unavailable.length) unsupported.push({ id, levels: unavailable });
      offered.reasoningEfforts = Object.keys(mapped).some(l => l !== "off") ? mapped : false;
    }
    const remembered = { ...previous[id] };
    for (const [field, value] of Object.entries(offered)) {
      const current = readField(block, field, depth), last = previous[id]?.[field];
      // Local edits made after a sync are pins; they are never overwritten.
      if (last !== undefined && JSON.stringify(current) !== JSON.stringify(last)) continue;
      if (JSON.stringify(current) !== JSON.stringify(value)) {
        block = writeField(block, field, value, depth);
        changes.push({ id, field, value });
      }
      remembered[field] = value;
    }
    state[id] = remembered;
    body.splice(start, end - start, ...block);
  }
  return { text: [...lines.slice(0, s.start + 1), ...body, ...lines.slice(s.end)].join("\n"), state, changes, missing, unsupported };
}
export async function syncDsh({ home = path.join(os.homedir(), "Library/Application Support/dsh-desktop/harness"), provider = "nine-router" } = {}) {
  const dir = path.join(home, "profiles/web"), statePath = path.join(home, "9router-catalog-sync.json");
  const profilePath = path.join(dir, "cordis.patch.yml");
  const original = await fs.readFile(profilePath, "utf8");
  const connection = connectionFromProfile(original, provider);
  const response = await fetch(connection.url, { headers: { authorization: "Bearer " + connection.key, "x-9r-internal-models-fetch": "1" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error("9router model catalog responded " + response.status);
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new Error("Invalid 9router model catalog");
  let old = {};
  try { old = JSON.parse(await fs.readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const results = {};
  for (const file of ["cordis.patch.yml", "cordis.yml"]) {
    const target = path.join(dir, file);
    let source;
    try { source = await fs.readFile(target, "utf8"); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const result = syncDshProfile(source, data.data, old.files?.[file], provider);
    if (result.text !== source) {
      const backup = path.join(home, "9router-catalog-backups", new Date().toISOString().replace(/[:.]/g, "-"));
      await fs.mkdir(backup, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(backup, file), source, { mode: 0o600 });
      if (await fs.readFile(target, "utf8") !== source) throw new Error("DSH configuration changed during catalog sync");
      const temp = target + ".9router-sync.tmp";
      await fs.writeFile(temp, result.text, { mode: 0o600 });
      await fs.rename(temp, target);
    }
    results[file] = result;
  }
  const configured = new Set(Object.values(results).flatMap(result => Object.keys(result.state)));
  const saved = { updatedAt: new Date().toISOString(), files: Object.fromEntries(Object.entries(results).map(([file, r]) => [file, r.state])),
    models: data.data.filter(m => configured.has(m.id)).map(m => ({ id: m.id, sources: m.capability_sources || {} })) };
  await fs.writeFile(statePath, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return Object.fromEntries(Object.entries(results).map(([file, r]) => [file, { changes: r.changes, missing: r.missing, unsupported: r.unsupported }]));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const homeIndex = process.argv.indexOf("--home");
  syncDsh(homeIndex < 0 ? {} : { home: process.argv[homeIndex + 1] }).then(r => console.log(JSON.stringify(r))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
