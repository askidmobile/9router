import { describe, expect, it } from "vitest";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

describe("Antigravity Gemini 3.8 model mapping", () => {
  it.each([
    ["high", "gemini-3.8-flash-tiered(high)"],
    ["medium", "gemini-3.8-flash-tiered(medium)"],
    ["low", "gemini-3.8-flash-tiered(low)"],
  ])("maps %s public ID to exact upstream ID", (tier, upstreamModel) => {
    expect(getModelUpstreamId("ag", `gemini-3.8-flash-${tier}`)).toBe(upstreamModel);
  });
});