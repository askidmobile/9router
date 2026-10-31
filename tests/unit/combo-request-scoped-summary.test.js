// A combo advances past a request-scoped 4xx on purpose (another member on a
// different provider may accept the body), but the first member's response is
// what the client gets back, so the reasons collected after it used to vanish
// from the server log entirely. During the tool_calls investigation the visible
// log said only "experiential ... 400" while codebuddy had just answered 11148
// about the same body — the two halves of the diagnosis never appeared together.
import { describe, it, expect } from "vitest";
import { formatRequestScopedFailures } from "open-sse/services/combo.js";

describe("formatRequestScopedFailures", () => {
  it("stays silent for a single rejection — the response itself names it", () => {
    expect(formatRequestScopedFailures([{ model: "exp/m", status: 400, error: "bad" }])).toBeNull();
    expect(formatRequestScopedFailures([])).toBeNull();
    expect(formatRequestScopedFailures(null)).toBeNull();
  });

  it("lists every member with its own reason, in attempt order", () => {
    const line = formatRequestScopedFailures([
      { model: "exp/deepseek-v4.1-flash-1017", status: 400, error: "Invalid parameter: 'tool_calls' type error" },
      { model: "cbai/deepseek-v4.1-flash", status: 400, error: "tool calls and tool results do not match" },
    ]);
    expect(line).toBe(
      "exp/deepseek-v4.1-flash-1017 → 400 Invalid parameter: 'tool_calls' type error; "
      + "cbai/deepseek-v4.1-flash → 400 tool calls and tool results do not match",
    );
  });

  it("flattens whitespace, truncates a long reason and caps the member list", () => {
    const failures = Array.from({ length: 8 }, (_, i) => ({
      model: `p${i}/m`, status: 400, error: `line one\nline two ${"x".repeat(200)}`,
    }));
    const line = formatRequestScopedFailures(failures);
    expect(line).not.toContain("\n");
    expect(line).toContain("(+2 more)");
    const first = line.split("; ")[0];
    expect(first.length).toBeLessThan(110);
  });

  it("falls back to the status when the member sent no message", () => {
    expect(formatRequestScopedFailures([
      { model: "a/m", status: 413, error: "" },
      { model: "b/m", status: 422, error: null },
    ])).toBe("a/m → 413; b/m → 422");
  });
});
