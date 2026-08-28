/**
 * Fake ZCode app-server fixture — a standalone stdio process that speaks the
 * ZCode app-server line-JSON protocol (see open-sse/shared/zcode/protocol.js).
 *
 * Used by unit tests and manual pipeline checks instead of a real ZCode CLI:
 *   node tests/fixtures/fake-zcode-app-server.mjs
 *
 * Behavior: answers every RPC — `session/create` issues a fixed session id
 * (and asks the client for runtime preferences like the real server does),
 * `session/send` accepts the turn, and `session/read` completes it with a
 * canned assistant message. `session/close` acknowledges and exits.
 */

let input = "";
let sessionId = null;
let closeRequested = false;

function respond(id, payload) {
  process.stdout.write(`${JSON.stringify({ id, result: payload })}\n`);
}

function handle(msg) {
  // Messages carrying `result`/`error` are answers to OUR server-requests — ignore.
  // Messages carrying `method` are requests from the client.
  if (msg.method === undefined) return;

  switch (msg.method) {
    case "session/create": {
      sessionId = "fake-zcode-session";
      respond(msg.id, {
        session: { sessionId, status: "idle" },
        projection: { sessionId, status: "idle", mode: "build", contextWindow: 1000000 },
        protocol: { name: "ZCode Protocol", version: 1 },
      });
      // Mirror the real server: it asks for runtime preferences mid-create.
      process.stdout.write(`${JSON.stringify({ id: 9001, method: "session/requestRuntimePreferences", params: { sessionId, scope: "runtime-materialization" } })}\n`);
      break;
    }
    case "session/setModel":
      respond(msg.id, { ok: true });
      break;
    case "session/send":
      respond(msg.id, { accepted: true, sessionId: msg.params?.sessionId });
      break;
    case "session/read":
      respond(msg.id, {
        session: { sessionId, status: "completed" },
        messages: [
          { info: { role: "user", semantics: { kind: "user_prompt" } }, parts: [{ type: "text", text: msg.params?.content || "prompt" }] },
          { info: { role: "assistant", semantics: { kind: "response" } }, parts: [{ type: "text", text: "fake zcode response" }] },
        ],
      });
      break;
    case "session/close":
      respond(msg.id, { ok: true });
      closeRequested = true;
      break;
    default:
      respond(msg.id, { ok: true });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let index;
  while ((index = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: { code: -32700, message: String(error) } })}\n`);
    }
  }
});

process.stdin.on("end", () => process.exit(closeRequested ? 0 : 0));
