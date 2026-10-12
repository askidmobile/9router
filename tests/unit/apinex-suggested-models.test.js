import { describe, it, expect } from "vitest";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

describe("Apinex suggested models", () => {
  it("keeps paid and free published IDs and parses catalog context units", () => {
    expect(FILTERS.apinex([
      { id: "free/hy4", contextWindow: "1M" },
      { id: "grok-4.7", name: "Grok", contextWindow: "500K" },
      null, { id: "" },
    ])).toEqual([
      { id: "free/hy4", name: "free/hy4", contextLength: 1000000 },
      { id: "grok-4.7", name: "Grok", contextLength: 500000 },
    ]);
  });
});
