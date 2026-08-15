import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("getThinkingLevels for Kiro", () => {
  it("does not advertise native intensity for pre-4 Claude Kiro models", () => {
    expect(getThinkingLevels("kiro", "claude-sonnet-3.7")).toBeNull();
    expect(getThinkingLevels("kiro", "glm-5")).toBeNull();
  });

  it("advertises native levels for Claude 4+ Kiro models", () => {
    expect(getThinkingLevels("kiro", "claude-sonnet-4.5")).toContain("high");
    expect(getThinkingLevels("kiro", "claude-sonnet-5")).toContain("high");
    expect(getThinkingLevels("kiro", "gpt-5.6-sol")).toContain("xhigh");
  });
});
