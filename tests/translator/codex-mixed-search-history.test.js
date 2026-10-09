import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const call = (id, custom = false) => custom
  ? { type: "custom_tool_call", call_id: id, name: "exec", input: "read files" }
  : { type: "function_call", call_id: id, name: "exec_command", arguments: '{"cmd":"pwd"}' };
const output = (id, custom = false) => ({
  type: custom ? "custom_tool_call_output" : "function_call_output", call_id: id, output: `result_${id}`,
});
const search = status => ({
  type: "web_search_call", id: `ws_${status}`, status, action: { type: "search", query: "fixture docs" },
  results: status === "failed" ? [] : [{ title: "SEARCH_MARKER", url: "https://example.com/docs" }],
});

function translate(target, items) {
  const credentials = { projectId: "fixture-project", connectionId: "fixture-connection" };
  const body = { input: [{ role: "user", content: "Inspect the repo and search docs" }, ...items] };
  const snapshot = structuredClone(body);
  const model = "claude-opus-5-5-low";
  const result = translateRequest(FORMATS.OPENAI_RESPONSES, target, model, body, true, credentials,
    target === FORMATS.ANTIGRAVITY ? "antigravity" : target === FORMATS.CLAUDE ? "claude" : "openai");
  expect(body).toEqual(snapshot);
  return target === FORMATS.ANTIGRAVITY
    ? new AntigravityExecutor().transformRequest(model, result, true, credentials) : result;
}

function expectAdjacentResults(target, result, ids) {
  if (target === FORMATS.OPENAI) {
    const at = result.messages.findIndex(m => m.tool_calls?.length);
    expect(result.messages[at].tool_calls.map(c => c.id)).toEqual(ids);
    const results = result.messages.slice(at + 1, at + 1 + ids.length);
    expect(results.every(m => m.role === "tool")).toBe(true);
    expect(results.map(m => m.tool_call_id).sort()).toEqual([...ids].sort());
    expect(results.map(m => m.content).sort()).toEqual(ids.map(id => `result_${id}`).sort());
  } else {
    const gemini = target === FORMATS.ANTIGRAVITY;
    const messages = gemini ? result.request.contents : result.messages;
    const blocks = m => gemini ? m.parts : m.content;
    const isCall = b => gemini ? !!b.functionCall : b.type === "tool_use";
    const isResult = b => gemini ? !!b.functionResponse : b.type === "tool_result";
    const at = messages.findIndex(m => blocks(m)?.some(isCall));
    expect(blocks(messages[at]).filter(isCall).map(b => gemini ? b.functionCall.id : b.id)).toEqual(ids);
    expect(messages[at + 1].role).toBe("user");
    const results = blocks(messages[at + 1]).slice(0, ids.length);
    expect(results.every(isResult)).toBe(true);
    expect(results.map(b => gemini ? b.functionResponse.id : b.tool_use_id).sort()).toEqual([...ids].sort());
    expect(results.map(b => gemini ? b.functionResponse.response.result : b.content).sort())
      .toEqual(ids.map(id => `result_${id}`).sort());
  }
}

describe.each([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.ANTIGRAVITY])("mixed Codex search history → %s", target => {
  it.each(["completed", "failed"])("keeps the real result adjacent when hosted search is %s", status => {
    const result = translate(target, [call("call_exec"), search(status), output("call_exec")]);
    expectAdjacentResults(target, result, ["call_exec"]);
    expect(JSON.stringify(result)).toContain(status === "failed" ? "web_search failed" : "SEARCH_MARKER");
  });

  it("waits for all parallel results, including custom tools and reversed completion order", () => {
    const result = translate(target, [
      call("call_a"), search("completed"), call("call_b", true), search("failed"),
      output("call_b", true), output("call_a"),
    ]);
    expectAdjacentResults(target, result, ["call_a", "call_b"]);
    expect(JSON.stringify(result)).toContain("SEARCH_MARKER");
    expect(JSON.stringify(result)).toContain("web_search failed");
  });

  it("retains standalone searches and searches before a client call", () => {
    const result = translate(target, [search("completed"), call("call_a"), output("call_a")]);
    expectAdjacentResults(target, result, ["call_a"]);
    expect(JSON.stringify(result)).toContain("SEARCH_MARKER");
    expect(JSON.stringify(translate(target, [search("failed")]))).toContain("web_search failed");
  });
});
