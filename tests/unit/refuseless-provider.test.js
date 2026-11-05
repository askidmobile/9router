// Refuseless — abliterated OpenAI-compatible lineup (api.refuseless.com).
// The API publishes context windows and reasoning levels but no prices, so the
// normalizer renames "off" to 9router's "none" and attaches the static
// PROVIDER_PRICING.refuseless table; runtime caps come from
// PROVIDER_CAPABILITIES.refuseless.
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getDefaultModel, isValidModel } from "../../open-sse/config/providerModels.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { normalizeRefuselessModel } from "../../open-sse/services/refuseless.js";
import { catalogMetadata } from "@/lib/providerCatalog/metadata.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel, PROVIDER_PRICING } from "../../open-sse/providers/pricing.js";

const entry = REGISTRY.find((e) => e.id === "refuseless");

describe("Refuseless provider", () => {
  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("refuseless");
    expect(entry.aliases).toContain("rfl");
    expect(entry.passthroughModels).toBe(true);
  });

  it("points at the documented endpoints and validates with /v1/credits", () => {
    expect(PROVIDERS.refuseless.baseUrl).toBe("https://api.refuseless.com/v1/chat/completions");
    expect(PROVIDERS.refuseless.format).toBe("openai");
    expect(PROVIDERS.refuseless.thinkingFormat).toBe("openai");
    // /v1/models is public and accepts any key; only the credits route proves one.
    expect(PROVIDERS.refuseless.validateUrl).toBe("https://api.refuseless.com/v1/credits");
  });

  it("resolves rfl and routes the lineup", () => {
    expect(resolveProviderAlias("refuseless")).toBe("refuseless");
    expect(resolveProviderAlias("rfl")).toBe("refuseless");
    expect(getDefaultModel("refuseless")).toBe("glm-5.3-abliterated");
    expect(isValidModel("refuseless", "privately-granted-model", new Set(["refuseless"]))).toBe(true);
  });

  it("seeds the six live catalog models with context windows", () => {
    expect(PROVIDER_MODELS.refuseless.map((m) => m.id)).toEqual([
      "glm-5.3-abliterated",
      "glm-5.3-flash-abliterated",
      "deepseek-v4.1-flash-abliterated",
      "deepseek-v4.1-flash-fast",
      "minimax-m3.1-flash",
      "deepseek-v4.1-flash-abliterated-free",
    ]);
    const provider = AI_PROVIDERS["refuseless"];
    expect(provider.notice?.apiKeyUrl).toBe("https://refuseless.com/console/models");
    expect(getProvidersByKind("llm").some((p) => p.id === "refuseless")).toBe(true);
  });
});

describe("normalizeRefuselessModel", () => {
  const row = {
    id: "glm-5.3-abliterated",
    object: "model",
    owned_by: "refuseless",
    abliterated: true,
    context_length: 1048576,
    reasoning_efforts: ["low", "high", "max"],
    reasoning_default: "low",
  };

  it("keeps context and renames off → none for the level enum", () => {
    const model = normalizeRefuselessModel({ ...row, reasoning_efforts: ["off", "low", "high", "max"] });
    expect(model.reasoning_efforts).toEqual(["none", "low", "high", "max"]);
    expect(model.context_length).toBe(1048576);
    const meta = catalogMetadata(model);
    expect(meta.caps.reasoningLevels).toEqual(["none", "low", "high", "max"]);
    expect(meta.caps.reasoning).toBe(true);
    expect(meta.caps.contextWindow).toBe(1048576);
  });

  it("attaches the static per-1M prices for known ids", () => {
    const meta = catalogMetadata(normalizeRefuselessModel(row));
    expect(meta.pricing).toEqual({ input: 2, output: 3, cached: 0.35 });
  });

  it("carries vision and leaves the free variant at zero", () => {
    const flash = normalizeRefuselessModel({ ...row, id: "glm-5.3-flash-abliterated", vision: true });
    expect(flash.capabilities).toEqual({ vision: true });
    const free = normalizeRefuselessModel({ ...row, id: "deepseek-v4.1-flash-abliterated-free", context_length: 524288 });
    expect(catalogMetadata(free).pricing).toEqual({ input: 0, output: 0, cached: 0 });
  });

  it("omits reasoning levels the API did not declare", () => {
    const model = normalizeRefuselessModel({ ...row, reasoning_efforts: undefined });
    expect(model.reasoning_efforts).toBeUndefined();
    expect(catalogMetadata(model).caps.reasoningLevels).toBeUndefined();
  });
});

describe("Refuseless pricing and caps", () => {
  it("resolves the static table and unknown ids stay unpriced", () => {
    expect(getPricingForModel("refuseless", "glm-5.3-abliterated")).toMatchObject({ input: 2, output: 3, cached: 0.35 });
    expect(getPricingForModel("refuseless", "deepseek-v4.1-flash-fast")).toMatchObject({ input: 0.05, output: 0.15 });
    // minimax-m3.1-flash joined after the published price snapshot: no
    // Refuseless-specific rate, so it falls through to the canonical MiniMax
    // pattern rather than showing $0.
    expect(PROVIDER_PRICING.refuseless["minimax-m3.1-flash"]).toBeUndefined();
    expect(getPricingForModel("refuseless", "minimax-m3.1-flash")?.input).toBe(0.5);
  });

  it("marks GLM/MiniMax as thinking-always-on and DeepSeek as switchable", () => {
    const glm = getCapabilitiesForModel("refuseless", "glm-5.3-abliterated");
    expect(glm).toMatchObject({ reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false });
    expect(glm.reasoningLevels).toEqual(["low", "high", "max"]);

    const deepseek = getCapabilitiesForModel("refuseless", "deepseek-v4.1-flash-abliterated");
    expect(deepseek.reasoningLevels).toEqual(["none", "low", "high", "max"]);
    expect(deepseek.contextWindow).toBe(1048576);
  });
});
