// Run against a disposable 9router database, never the user's running instance:
// CHATGPT_QA_PASSWORD=... node scripts/test-chatgpt-integration.mjs http://127.0.0.1:20237 --disposable
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBridge } from "../public/9router-codex.mjs";

const base = new URL(process.argv[2]);
if (!process.argv.includes("--disposable") || !["127.0.0.1", "localhost"].includes(base.hostname)) {
  throw new Error("This smoke test creates providers and keys. Pass a loopback URL for a disposable database and --disposable.");
}
const received = [];
const fixture = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ data: [{ id: "qa-model" }] }));
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  received.push({ url: req.url, headers: req.headers, body });
  assert.equal(req.headers.authorization, "Bearer fixture-upstream-key");
  assert.equal(req.headers["chatgpt-account-id"], undefined);
  const toolResult = body.messages?.some(message => message.role === "tool");
  const tool = !toolResult && body.tools?.length > 0;
  const message = tool ? { role: "assistant", content: null, tool_calls: [{ id: "call_qa", type: "function", function: { name: "read_file", arguments: '{"path":"hello.txt"}' } }] }
    : { role: "assistant", content: body.stream === false ? "QA_SUMMARY: read hello.txt; continue the task." : "QA_OK" };
  const choice = { index: 0, message, finish_reason: tool ? "tool_calls" : "stop" };
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = { ...message };
    if (delta.tool_calls) delta.tool_calls[0].index = 0;
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", model: "qa-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion", model: "qa-model", choices: [choice], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
let cookie, key, connection, node, bridge;
const prefix = `qa${Date.now()}`;
async function api(route, method = "GET", body) {
  const response = await fetch(new URL(route, base), { method, headers: { cookie: cookie || "", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  assert.ok(response.ok, `${route}: HTTP ${response.status}, ${data.error}`);
  return data;
}
try {
  const login = await fetch(new URL("/api/auth/login", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: process.env.CHATGPT_QA_PASSWORD }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  await api("/api/settings", "PATCH", { rtkEnabled: false, headroomEnabled: false, enableObservability: false });
  key = await api("/api/keys", "POST", { name: prefix });
  ({ node } = await api("/api/provider-nodes", "POST", { name: "ChatGPT QA fixture", prefix, apiType: "chat", baseUrl: `http://127.0.0.1:${fixture.address().port}/v1` }));
  const added = await api("/api/providers", "POST", { provider: node.id, apiKey: "fixture-upstream-key", name: prefix });
  connection = added.connection || added;
  await api("/api/chatgpt", "PUT", { models: [`${prefix}/qa-model`] });
  assert.equal((await api("/api/chatgpt")).models[0].id, `${prefix}/qa-model`);
  const manifestResponse = await fetch(new URL("/api/chatgpt/v1/models", base), { headers: { authorization: `Bearer ${key.key}` } });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.models.length, 1);
  assert.equal((await fetch(new URL("/api/chatgpt/v1/models", base))).status, 401);
  bridge = createBridge({ token: "qa-local-token", routerUrl: `${base.origin}/api/chatgpt/v1`, apiKey: key.key }, { getManifest: async () => manifest });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  const endpoint = `http://127.0.0.1:${bridge.address().port}/qa-local-token/v1`;
  async function completion(suffix, body) {
    const result = await fetch(`${endpoint}${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-native-secret", "chatgpt-account-id": "fake-native-account" },
      body: JSON.stringify({ model: manifest.models[0].slug, ...body }),
    });
    const text = await result.text();
    assert.equal(result.status, 200, text.slice(0, 1500));
    return text;
  }
  const first = await completion("/responses", {
    input: [{ role: "user", content: "Read hello.txt" }], stream: true,
    tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  });
  assert.match(first, /response\.completed/);
  assert.match(first, /function_call/);
  assert.match(first, /call_qa/);
  const history = [{ role: "user", content: "Read hello.txt" },
    { type: "function_call", call_id: "call_qa", name: "read_file", arguments: '{"path":"hello.txt"}' },
    { type: "function_call_output", call_id: "call_qa", output: "hello world" }];
  assert.match(await completion("/responses", { input: history, stream: true }), /QA_OK/);
  const compact = JSON.parse(await completion("/responses/compact", { input: history }));
  assert.equal(compact.object, "response.compaction");
  assert.match(compact.output[0].content[0].text, /QA_SUMMARY/);
  assert.match(await completion("/responses", { input: [...compact.output, { role: "user", content: "Continue" }], stream: true }), /QA_OK/);
  const script = await fetch(new URL("/9router-codex.mjs", base));
  assert.equal(script.status, 200);
  const scriptText = await script.text();
  assert.match(scriptText, /export async function main/);
  assert.equal(received.length, 4);
  console.log("PASS: persisted selection → local bridge → built server → real translator → fixture provider; streaming tool call, tool result continuation, compaction and post-compaction continuation; separate auth; downloadable installer.");
  if (process.argv.includes("--check-installer")) {
    const exec = promisify(execFile);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "9router-installer-smoke-"));
    const codexHome = path.join(temporary, "codex home");
    const installer = path.join(temporary, "installer.mjs");
    await fs.mkdir(codexHome);
    await fs.writeFile(installer, scriptText);
    const configPath = path.join(codexHome, "config.toml");
    const original = 'model = "native-qa"\n[features]\nqa_preserve = true\n';
    await fs.writeFile(configPath, original);
    await fs.writeFile(path.join(codexHome, "auth.json"), "untouched-auth-sentinel");
    await fs.writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "native-qa", visibility: "list", priority: 0 }] }));
    const allocator = http.createServer();
    allocator.listen(0, "127.0.0.1"); await once(allocator, "listening");
    const port = allocator.address().port;
    await new Promise(resolve => allocator.close(resolve));
    const run = command => exec(process.execPath, [installer, command, "--codex-home", codexHome, "--url", `${base.origin}/api/chatgpt/v1`, "--port", String(port)], { env: { ...process.env, ROUTER9_API_KEY: key.key }, timeout: 30000 });
    try {
      await run("enable");
      assert.match((await run("status")).stdout, /Running:/);
      const state = JSON.parse(await fs.readFile(path.join(codexHome, "9router-chatgpt/state.json"), "utf8"));
      assert.equal((await fs.stat(path.join(codexHome, "9router-chatgpt/state.json"))).mode & 0o777, 0o600);
      await fs.writeFile(configPath, (await fs.readFile(configPath, "utf8")).replace("qa_preserve = true", "qa_preserve = false"));
      await run("enable");
      await run("sync");
      await run("disable");
      assert.equal(await fs.readFile(configPath, "utf8"), original.replace("qa_preserve = true", "qa_preserve = false"));
      assert.equal(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"), "untouched-auth-sentinel");
      await assert.rejects(fs.stat(state.plist), { code: "ENOENT" });
      assert.match((await run("status")).stdout, /Disabled/);
      console.log("PASS: downloaded installer, real temporary launchd agent, repeated enable, sync, disable, unrelated config edits retained, auth file unchanged, launch agent removed.");
    } finally {
      await run("disable").catch(() => {});
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
} finally {
  if (cookie) {
    await api("/api/chatgpt", "PUT", { models: [] }).catch(() => {});
    if (connection?.id) await api(`/api/providers/${connection.id}`, "DELETE").catch(() => {});
    if (node?.id) await api(`/api/provider-nodes/${node.id}`, "DELETE").catch(() => {});
    if (key?.id) await api(`/api/keys/${key.id}`, "DELETE").catch(() => {});
  }
  if (bridge) { bridge.closeAllConnections(); bridge.close(); }
  fixture.closeAllConnections(); fixture.close();
}
