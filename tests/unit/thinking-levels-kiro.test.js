import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("getThinkingLevels for Kiro", () => {
  it("does not advertise native intensity for unsupported Kiro models", () => {
    expect(getThinkingLevels("kiro", "claude-sonnet-3.7")).toBeNull();
    expect(getThinkingLevels("kiro", "claude-sonnet-4.5")).toBeNull();
    expect(getThinkingLevels("kiro", "glm-5")).toBeNull();
  });

  it("advertises native levels for Claude 4.6+ / 5 Kiro models", () => {
    expect(getThinkingLevels("kiro", "claude-sonnet-4.6")).toContain("high");
    expect(getThinkingLevels("kiro", "claude-sonnet-5")).toContain("high");
    expect(getThinkingLevels("kiro", "gpt-5.6-sol")).toContain("xhigh");
  });
});
