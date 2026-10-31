// Strict OpenAI-compatible upstreams reject a conversation whose tool calls and
// tool results do not pair up: CodeBuddy answers 11148 "tool calls and tool
// results do not match", DeepSeek "Invalid parameter: 'tool_calls' type error".
// A client that loses a turn inside a tool call (interrupted agent, queued
// message preempting the active turn, compaction cutting a pair) replays that
// history on every retry, so no combo member can ever serve it.
//
// `fixMissingToolResponses` covers none of these cases: it looks only at the
// message directly after the call, so it skips a trailing dangling call, misses
// a partial parallel answer, and on a split pair (`call → user → result`)
// inserts an empty result while the real one stays behind as a duplicate.
import { describe, it, expect } from "vitest";
import { reconcileToolHistory, formatToolRepairs } from "open-sse/translator/concerns/toolCall.js";

const call = (id, name = "Read", args = "{\"file_path\":\"/tmp/x\"}") => ({
  id, type: "function", function: { name, arguments: args },
});
const assistantCall = (...calls) => ({ role: "assistant", content: null, tool_calls: calls });
const result = (id, content = "ok") => ({ role: "tool", tool_call_id: id, content });
const user = (content = "next") => ({ role: "user", content });

function shape(messages) {
  return messages.map((m) => {
    if (m.role === "tool") return `tool:${m.tool_call_id}`;
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      return `assistant:${m.tool_calls.map((c) => c.id).join("+")}`;
    }
    return m.role;
  });
}

describe("reconcileToolHistory", () => {
  it("leaves a valid history untouched and returns the same array", () => {
    const messages = [user(), assistantCall(call("a")), result("a"), user()];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(out).toBe(messages);
    expect(repairs.changed).toBe(false);
    expect(formatToolRepairs(repairs)).toBeNull();
  });

  it("drops a trailing dangling call instead of fabricating its result", () => {
    // The real output arrives with the next request; a placeholder here would
    // shadow it, because the dedup keeps the first result for an id.
    const messages = [user(), assistantCall(call("a"))];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(shape(out)).toEqual(["user"]);
    expect(repairs.droppedCalls).toBe(1);
    expect(repairs.synthesizedResults).toBe(0);
  });

  it("keeps the assistant text when only the trailing call is dropped", () => {
    const messages = [user(), { ...assistantCall(call("a")), content: "checking" }];
    const { messages: out } = reconcileToolHistory(messages);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: "assistant", content: "checking" });
  });

  it("closes a mid-history dangling call with a placeholder result", () => {
    const messages = [user(), assistantCall(call("a")), user("after")];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(shape(out)).toEqual(["user", "assistant:a", "tool:a", "user"]);
    expect(out[2].content).toBe("[No response received]");
    expect(repairs.synthesizedResults).toBe(1);
  });

  it("moves a split result back under its call and drops the duplicate", () => {
    const messages = [user(), assistantCall(call("a")), user("interrupted"), result("a", "real")];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(shape(out)).toEqual(["user", "assistant:a", "tool:a", "user"]);
    expect(out[2].content).toBe("real");
    expect(out.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(repairs.movedResults).toBe(1);
  });

  it("answers the missing half of a parallel call instead of ignoring it", () => {
    // hasToolResults() reported true for [a,b] followed by a's result alone,
    // so b stayed unanswered and the upstream rejected the request.
    const messages = [user(), assistantCall(call("a"), call("b")), result("a"), user()];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(shape(out)).toEqual(["user", "assistant:a+b", "tool:a", "tool:b", "user"]);
    expect(repairs.synthesizedResults).toBe(1);
  });

  it("drops a tool result that has no call", () => {
    const messages = [user(), result("ghost", "stale"), user()];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(shape(out)).toEqual(["user", "user"]);
    expect(repairs.orphanResults).toBe(1);
  });

  it("drops a second call reusing an id already claimed", () => {
    const messages = [
      user(), assistantCall(call("a")), result("a"),
      user(), assistantCall(call("a")), result("a", "again"),
    ];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(shape(out)).toEqual(["user", "assistant:a", "tool:a", "user"]);
    expect(repairs.duplicateIds).toBe(1);
  });

  it("removes an empty tool_calls array but keeps the turn", () => {
    const messages = [user(), { role: "assistant", content: "hello", tool_calls: [] }, user()];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(out[1]).toEqual({ role: "assistant", content: "hello" });
    expect(repairs.changed).toBe(true);
  });

  it("drops an empty turn left without calls", () => {
    const messages = [user(), { role: "assistant", content: null, tool_calls: [null] }, user()];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(shape(out)).toEqual(["user", "user"]);
    expect(repairs.droppedMessages).toBe(1);
    expect(repairs.droppedCalls).toBe(1);
  });

  it("normalizes arguments: object → JSON, double-encoded or freeform → {}", () => {
    const objectArgs = { role: "assistant", content: null, tool_calls: [{ id: "a", function: { name: "Read", arguments: { file_path: "/x" } } }] };
    const doubleEncoded = { role: "assistant", content: null, tool_calls: [call("b", "Read", "\"{\\\"file_path\\\":\\\"/x\\\"}\"")] };
    const freeform = { role: "assistant", content: null, tool_calls: [call("c", "shell", "ls -la")] };
    const messages = [user(), objectArgs, result("a"), user(), doubleEncoded, result("b"), user(), freeform, result("c"), user()];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    const calls = out.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ file_path: "/x" });
    expect(calls[1].function.arguments).toBe("{}");
    expect(calls[2].function.arguments).toBe("{}");
    expect(repairs.coercedArguments).toBe(3); // object → JSON, double-encoded → {}, freeform → {}
  });

  it("drops a call with no id or no name, since neither can be paired", () => {
    const messages = [user(), { role: "assistant", content: "x", tool_calls: [
      { type: "function", function: { name: "Read", arguments: "{}" } },
      { id: "b", type: "function", function: { arguments: "{}" } },
    ] }, user()];
    const { messages: out, repairs } = reconcileToolHistory(messages);
    expect(shape(out)).toEqual(["user", "assistant", "user"]);
    expect(repairs.droppedCalls).toBe(2);
  });

  it("never mutates the input messages (combo members share the body)", () => {
    const messages = [user(), assistantCall(call("a")), user("x"), result("a", "real")];
    const before = JSON.stringify(messages);
    reconcileToolHistory(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
