import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

describe("CodeBuddyIntlExecutor system prompt & agent sanitization", () => {
  const exec = new CodeBuddyIntlExecutor();

  it("keeps instructions alongside agent identity, including role markup", () => {
    const out = exec.transformRequest("deepseek-v4.1-flash", {
      messages: [
        { role: "system", content: "You are Claude Code, Anthropic's official CLI. Always answer in Russian. Never modify production." },
        { role: "developer", content: "<Role>You are an AI agent.</Role>\n<Behavior_Instructions>Ask before deleting data.</Behavior_Instructions>" },
        { role: "user", content: "Hello" },
      ],
    }, false, {});
    expect(out.messages[0].content).toContain("Always answer in Russian. Never modify production.");
    expect(out.messages[0].content).toContain("Ask before deleting data.");
    expect(out.messages[0].content).not.toMatch(/Claude Code|Anthropic|AI agent|<Role>|<Behavior_Instructions>/i);
  });

  it("forwards user custom system prompt when provided", () => {
    const out = exec.transformRequest(
      "deepseek-v4.1-flash",
      {
        messages: [
          { role: "system", content: "You are a professional translator." },
          { role: "user", content: "Translate this text." },
        ],
      },
      false,
      {}
    );

    expect(out.messages[0]).toEqual({
      role: "system",
      content: "You are a professional translator.",
    });
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Translate this text." }],
    });
  });

  it("falls back to default system prompt when omitted by client", () => {
    const out = exec.transformRequest(
      "deepseek-v4.1-flash",
      {
        messages: [{ role: "user", content: "Hello" }],
      },
      false,
      {}
    );

    expect(out.messages[0]).toEqual({
      role: "system",
      content: "You are CodeBuddy Code.",
    });
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    });
  });

  it("neutralizes sensitive third-party agent identity to prevent WAF rejection", () => {
    const out = exec.transformRequest(
      "deepseek-v4.1-flash",
      {
        messages: [
          {
            role: "system",
            content: "You are Claude Code, Anthropic's official CLI for coding.",
          },
          { role: "user", content: "Fix this bug" },
        ],
      },
      false,
      {}
    );

    expect(out.messages[0]).toEqual({
      role: "system",
      content: "You are CodeBuddy, CodeBuddy's official CLI for coding.",
    });
  });
});
