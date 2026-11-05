// UnoRouter — OpenAI-compatible router (api.unorouter.com). Locks the registry
// contract and the two-source catalog merge: prices come from the public
// /api/pricing/catalog in USD per 1M, limits/capabilities from tags and
// /v1/models. The metadata bridge must keep the per-1M rates as per-1M (the
// generic parser treats a bare `input_price` as per-token).
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getDefaultModel, isValidModel } from "../../open-sse/config/providerModels.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { normalizeUnorouterModel } from "../../open-sse/services/unorouter.js";
import { catalogMetadata } from "@/lib/providerCatalog/metadata.js";
import { getPricingForModel, isFreeModel } from "../../open-sse/providers/pricing.js";

const entry = REGISTRY.find((e) => e.id === "unorouter");

describe("UnoRouter provider", () => {
  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("unorouter");
    expect(entry.aliases).toContain("uno");
    expect(entry.passthroughModels).toBe(true);
  });

  it("points at the documented endpoints", () => {
    expect(PROVIDERS.unorouter.baseUrl).toBe("https://api.unorouter.com/v1/chat/completions");
    expect(PROVIDERS.unorouter.format).toBe("openai");
    expect(PROVIDERS.unorouter.thinkingFormat).toBe("openai");
    // /v1/models is public, so validation must use the key-scoped usage endpoint.
    expect(PROVIDERS.unorouter.validateUrl).toBe("https://api.unorouter.com/api/usage/token/");
  });

  it("resolves the uno shortcut and unorouter/uno model routing", () => {
    expect(resolveProviderAlias("unorouter")).toBe("unorouter");
    expect(resolveProviderAlias("uno")).toBe("unorouter");
    const parsed = parseModel("uno/glm-5.3");
    expect(parsed.provider).toBe("unorouter");
    expect(parsed.model).toBe("glm-5.3");
  });

  it("exposes seed models and forwards catalog ids (passthrough)", () => {
    expect(PROVIDER_MODELS.unorouter.length).toBeGreaterThan(0);
    expect(getDefaultModel("unorouter")).toBe("deepseek-v4.1-flash-1017");
    expect(isValidModel("unorouter", "some-new-catalog-model", new Set(["unorouter"]))).toBe(true);
  });

  it("appears in the apikey provider grid with a token link", () => {
    const provider = AI_PROVIDERS["unorouter"];
    expect(provider).toBeDefined();
    expect(provider.notice?.apiKeyUrl).toBe("https://unorouter.com/en/token");
    expect(getProvidersByKind("llm").some((p) => p.id === "unorouter")).toBe(true);
  });
});

describe("normalizeUnorouterModel", () => {
  const row = {
    model_name: "glm-5.3",
    vendor: "Zhipu",
    type: "text",
    tags: ["Text", "Reasoning", "Tools", "Vision", "1M", "Cache"],
    is_free: false,
    online: true,
    input_price: 0.12474,
    output_price: 0.4,
    is_fixed_price: false,
    chat: true,
    supported_endpoint_types: ["openai"],
  };

  it("keeps catalog rates per 1M and maps capability tags", () => {
    const model = normalizeUnorouterModel(row, { context_length: 1000000, max_output_tokens: 943718 });
    expect(model.id).toBe("glm-5.3");
    expect(model.pricing).toEqual({ input_per_million: 0.12474, output_per_million: 0.4 });
    expect(model.context_length).toBe(1000000);
    expect(model.max_output_tokens).toBe(943718);
    expect(model.capabilities).toMatchObject({ reasoning: true, tools: true, vision: true });
  });

  it("falls back to the context tag when /v1/models has no entry", () => {
    expect(normalizeUnorouterModel({ ...row, tags: ["Text", "262.1K"] }).context_length).toBe(262100);
    expect(normalizeUnorouterModel({ ...row, tags: ["Text", "1.0M"] }).context_length).toBe(1000000);
  });

  it("drops non-chat, per-call and anthropic-only rows", () => {
    expect(normalizeUnorouterModel({ ...row, type: "image" })).toBeNull();
    expect(normalizeUnorouterModel({ ...row, is_fixed_price: true })).toBeNull();
    expect(normalizeUnorouterModel({ ...row, chat: false })).toBeNull();
    expect(normalizeUnorouterModel({ ...row, supported_endpoint_types: ["anthropic"] })).toBeNull();
    // No endpoint list means "not declared" — keep the model.
    expect(normalizeUnorouterModel({ ...row, supported_endpoint_types: undefined })).not.toBeNull();
  });

  it("bridges into catalogMetadata without rescaling the price", () => {
    const meta = catalogMetadata(normalizeUnorouterModel(row, { context_length: 1000000, max_output_tokens: 943718 }));
    expect(meta.pricing).toEqual({ input: 0.12474, output: 0.4 });
    expect(meta.caps).toMatchObject({ contextWindow: 1000000, maxOutput: 943718, reasoning: true, tools: true, vision: true });
  });
});

describe("UnoRouter free lane", () => {
  it("treats :free ids as zero-cost and paid ids as not free", () => {
    expect(isFreeModel("glm-5.3-flash:free")).toBe(true);
    expect(isFreeModel("glm-5.3-flash")).toBe(false);
    expect(getPricingForModel("unorouter", "anything:free").input).toBe(0);
  });
});
