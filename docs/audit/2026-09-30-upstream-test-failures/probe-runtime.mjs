// Read-only with respect to the checkout: all writes use a new disposable DATA_DIR.
// Usage: /opt/homebrew/bin/node probe-runtime.mjs /absolute/repository/root /absolute/output.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] || process.cwd());
const output = process.argv[3];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-audit-"));
process.env.DATA_DIR = dataDir;
function sourceUrl(filePath) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return pathToFileURL(filePath).href;
  if (fs.existsSync(filePath + ".js")) return pathToFileURL(filePath + ".js").href;
  if (fs.existsSync(path.join(filePath, "index.js"))) return pathToFileURL(path.join(filePath, "index.js")).href;
  return pathToFileURL(filePath).href;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(sourceUrl(path.join(root, "src", specifier.slice(2))), context);
    }
    if (specifier.startsWith("open-sse/")) {
      return nextResolve(sourceUrl(path.join(root, specifier)), context);
    }
    if (specifier.startsWith(".") && !context.parentURL?.includes("/node_modules/")
      && context.parentURL?.startsWith(pathToFileURL(root + path.sep).href)) {
      return nextResolve(sourceUrl(fileURLToPath(new URL(specifier, context.parentURL))), context);
    }
    return nextResolve(specifier, context);
  },
});

const db = await import(pathToFileURL(path.join(root, "src/lib/db/index.js")).href);
const { getAdapter } = await import(pathToFileURL(path.join(root, "src/lib/db/driver.js")).href);
const { saveUsageStats } = await import(pathToFileURL(path.join(root, "open-sse/handlers/chatCore/requestDetail.js")).href);
await db.initDb();
const adapter = await getAdapter();
const fixedTime = new Date().toISOString();
const base = {
  provider: "openai", connectionId: "audit-account", apiKey: "audit-fake-key",
  tokens: { prompt_tokens: 10, completion_tokens: 5 }, endpoint: "/v1/chat/completions",
  status: "ok", timestamp: fixedTime,
};
const count = model => adapter.get("SELECT COUNT(*) AS n FROM usageHistory WHERE model = ?", [model]).n;
const scenarios = [];

for (const [label, size, make] of [
  ["different_requests_same_millisecond", 2, i => ({ ...base, model: "audit-same-ms", requestId: `request-${i}` })],
  ["100_different_requests_same_millisecond", 100, i => ({ ...base, model: "audit-100-same-ms", requestId: `request-${i}` })],
  ["different_milliseconds_control", 100, i => ({ ...base, model: "audit-different-ms", timestamp: new Date(Date.parse(fixedTime) + i).toISOString() })],
]) {
  const rows = Array.from({ length: size }, (_, i) => make(i));
  await Promise.all(rows.map(entry => db.saveRequestUsage(entry)));
  const stored = count(rows[0].model);
  scenarios.push({ label, submittedIndependentRequests: size, stored, lost: size - stored });
}

// Exercise the actual handler's usage writer, which generates its own timestamp
// and currently accepts no request identity. Freeze Date only inside this child
// process to reproduce simultaneous completion deterministically.
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
  static now() { return RealDate.parse(fixedTime); }
};
try {
  for (let i = 0; i < 2; i++) {
    saveUsageStats({ ...base, model: "audit-handler-same-ms", silent: true });
  }
  await new Promise(resolve => setTimeout(resolve, 250));
} finally {
  globalThis.Date = RealDate;
}
const storedByHandler = count("audit-handler-same-ms");
scenarios.push({
  label: "production_saveUsageStats_same_millisecond",
  submittedIndependentRequests: 2, stored: storedByHandler, lost: 2 - storedByHandler,
});

// Check the current public stats object with a fake key. No real credentials are read.
const privacy = [];
for (const period of ["24h", "today", "7d", "all"]) {
  const stats = await db.getUsageStats(period);
  privacy.push({ period, exposesFakeRawKey: JSON.stringify(stats).includes(base.apiKey) });
}
// Use the actual translation entry point with its self-registering translator.
// This verifies the local request path; it sends no request to any provider.
await import(pathToFileURL(path.join(root, "open-sse/translator/request/openai-to-claude.js")).href);
const { translateRequest } = await import(pathToFileURL(path.join(root, "open-sse/translator/index.js")).href);
const translated = translateRequest("openai", "claude", "m", {
  messages: [
    { role: "user", content: "question" },
    { role: "assistant", content: "answer", reasoning_content: "AUDIT_REASONING" },
    { role: "user", content: "next" },
  ],
}, true, null, "anthropic-compatible-audit");
const { applyThinking } = await import(pathToFileURL(path.join(root, "open-sse/translator/concerns/thinkingUnified.js")).href);
const glmBody = { reasoning_effort: "low" };
applyThinking("openai", "glm-5.2", glmBody, "glm-cn");
const { detectRequiredCapabilities } = await import(pathToFileURL(path.join(root, "open-sse/services/combo.js")).href);
const translation = {
  preservesAssistantReasoning: JSON.stringify(translated).includes("AUDIT_REASONING"),
  glm52RequestedEffort: "low", glm52TransmittedEffort: glmBody.reasoning_effort ?? null,
  comboDetectsWebSearch: detectRequiredCapabilities({
    messages: [{ role: "user", content: "question" }], tools: [{ type: "web_search" }],
  }).has("search"),
};
const result = { root, dataDir, nodeVersion: process.version, sqliteDriver: adapter.driver, scenarios, privacy, translation };
if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
