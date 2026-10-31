// An upstream 4xx that names a `tool_calls` problem ("tool calls and tool results
// do not match", "Invalid parameter: 'tool_calls' type error") says the body was
// malformed but not which message broke it. `findToolHistoryAnomalies` scans the
// body that was actually sent and reports message indexes plus short flags, so
// the next incident is diagnosable from the server log alone — no request bodies
// on disk, no client replay, no tool names or arguments in the log.
import { describe, it, expect } from "vitest";
import { findToolHistoryAnomalies } from "open-sse/translator/concerns/toolCall.js";

const call = (id, name = "Read", args = "{\"file_path\":\"/tmp/x\"}") => ({
  id, type: "function", function: { name, arguments: args },
});
const assistantCall = (...calls) => ({ role: "assistant", content: null, tool_calls: calls });
const result = (id, content = "ok") => ({ role: "tool", tool_call_id: id, content });
const user = (content = "next") => ({ role: "user", content });

describe("findToolHistoryAnomalies", () => {
  it("reports the defects that make a strict upstream reject the body", () => {
    const messages = [
      user(),
      { role: "assistant", content: null, tool_calls: [call("a", "m".repeat(70)), { ...call("a"), id: "a" }] },
      result("ghost"),
      assistantCall({ id: "c", type: "function", function: { name: "Read", arguments: { a: 1 } } }),
      result("c"),
      { role: "assistant", content: null, tool_calls: [call("d")] },
    ];
    const flags = findToolHistoryAnomalies(messages);
    expect(flags).toContain("m1:call:name>64");
    expect(flags).toContain("m1:call:dup-id");
    expect(flags).toContain("m2:result:orphan");
    expect(flags).toContain("m3:call:args:object");
    expect(flags).toContain("m5:call:dangling");
  });

  it("counts a duplicate answer and an empty calls array", () => {
    const flags = findToolHistoryAnomalies([
      user(),
      { role: "assistant", content: "x", tool_calls: [] },
      assistantCall(call("a")), result("a"), result("a"),
    ]);
    expect(flags).toContain("m1:calls:empty");
    expect(flags).toContain("m4:result:dup");
  });

  it("flags malformed arguments and a call without a name", () => {
    const flags = findToolHistoryAnomalies([
      user(),
      assistantCall(call("a", "Read", "\"{\\\"file_path\\\":\\\"/x\\\"}\"")),
      assistantCall({ id: "b", type: "function", function: { name: "", arguments: "{}" } }),
    ]);
    expect(flags).toContain("m1:call:args:not-object");
    expect(flags).toContain("m2:call:no-name");
  });

  it("returns nothing for a clean history", () => {
    expect(findToolHistoryAnomalies([user(), assistantCall(call("a")), result("a"), user()])).toEqual([]);
  });

  it("caps the output so the log line stays bounded", () => {
    const messages = [user()];
    for (let i = 0; i < 20; i++) messages.push({ role: "tool", tool_call_id: `ghost${i}`, content: "x" });
    expect(findToolHistoryAnomalies(messages).length).toBe(8);
  });
});
