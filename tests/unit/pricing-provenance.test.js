import { describe, expect, it } from "vitest";
import {
  compareRateSources,
  normalizeRates,
  priceWarnings,
  resolveRateSet,
} from "@/lib/modelCatalog/pricingProvenance.js";

describe("resolveRateSet", () => {
  it("uses imported rates together with their recorded provenance", () => {
    const out = resolveRateSet({
      provider: "somegateway",
      model: "some-model",
      stored: { input: 1.5, output: 6 },
      meta: { source: "provider", updatedAt: "2026-11-01T10:00:00.000Z", verified: true },
    });

    expect(out.pricing).toEqual({ input: 1.5, output: 6 });
    expect(out.source).toBe("provider");
    expect(out.updatedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(out.verified).toBe(true);
  });

  it("falls back to the static table and names the rung that answered", () => {
    const out = resolveRateSet({ provider: "anthropic", model: "claude-opus-4-6" });

    expect(out.source).toBe("model-table");
    expect(out.pricing.input).toBe(5);
    expect(out.pricing.output).toBe(25);
  });

  it("marks the free lane instead of inheriting a paid rate", () => {
    const out = resolveRateSet({ provider: "anything", model: "deepseek-v4.1-flash:free" });

    expect(out.source).toBe("free");
    expect(out.pricing).toEqual({ input: 0, output: 0, cached: 0, cache_creation: 0 });
  });

  it("returns an empty rate set when nothing is known", () => {
    const out = resolveRateSet({ provider: "unknown-gateway", model: "totally-unknown-model-x1" });

    expect(out.pricing).toEqual({});
    expect(out.source).toBeNull();
    expect(out.missing).toEqual(["input", "output", "cached", "cache_creation"]);
  });

  it("never invents a cache rate and says which fallback billing uses", () => {
    const out = resolveRateSet({
      provider: "gateway",
      model: "m",
      stored: { input: 3, output: 15 },
      meta: { source: "provider" },
    });

    expect(out.pricing.cached).toBeUndefined();
    expect(out.fallbacks).toEqual({ cached: "input", cache_creation: "input" });
    expect(out.warnings.map((warning) => warning.code)).toContain("cache-not-published");
    expect(out.warnings.map((warning) => warning.code)).toContain("cache-write-not-published");
  });

  it("ignores unusable values instead of publishing them", () => {
    const out = resolveRateSet({
      provider: "gateway",
      model: "m",
      stored: { input: "3", output: -1, cached: null, cache_creation: 0.1 },
      meta: { source: "provider" },
    });

    expect(out.pricing).toEqual({ cache_creation: 0.1 });
    expect(out.missing).toContain("input");
  });
});

describe("priceWarnings", () => {
  it("flags an output rate cheaper than input", () => {
    const codes = priceWarnings({ input: 10, output: 1, cached: 1, cache_creation: 12 }).map((w) => w.code);
    expect(codes).toContain("output-below-input");
  });

  it("flags a cache read rate above the input rate", () => {
    const codes = priceWarnings({ input: 1, output: 2, cached: 3, cache_creation: 1.2 }).map((w) => w.code);
    expect(codes).toContain("cache-above-input");
  });

  it("flags a zero price for a paid model but not for the free lane", () => {
    expect(priceWarnings({ input: 0, output: 0 }, { model: "paid-model" }).map((w) => w.code))
      .toContain("zero-price");
    expect(priceWarnings({ input: 0, output: 0 }, { model: "x:free", source: "free" }).map((w) => w.code))
      .not.toContain("zero-price");
  });

  it("says nothing when the rates look sane", () => {
    expect(priceWarnings({ input: 3, output: 15, cached: 0.3, cache_creation: 3.75 })).toEqual([]);
  });
});

describe("compareRateSources", () => {
  it("reports only differences above the tolerance", () => {
    const mismatches = compareRateSources(
      { input: 1, output: 10, cached: 0.1 },
      { input: 1.05, output: 4, cached: 0.1 },
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].field).toBe("output");
    expect(mismatches[0].deltaPct).toBe(60);
  });

  it("skips fields one side does not publish", () => {
    expect(compareRateSources({ input: 1, output: 2 }, { input: 1 })).toEqual([]);
  });
});

describe("normalizeRates", () => {
  it("keeps the four billable fields only", () => {
    expect(normalizeRates({ input: 1, output: 2, cached: 0.1, cache_creation: 1.25, reasoning: 4 }))
      .toEqual({ input: 1, output: 2, cached: 0.1, cache_creation: 1.25 });
  });
});