// Experiential Labs — OpenAI-compatible gateway (api.experientiallabs.ai).
// Locks the registry contract: documented endpoints, Bearer auth, /v1/models
// key probe, passthrough slugs, the vendor-prefixed id an earlier custom
// provider left behind, catalog prices and the RPM plan presets.
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { isValidModel, getDefaultModel } from "../../open-sse/config/providerModels.js";
import { AI_PROVIDERS, getProvidersByKind, USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

const entry = REGISTRY.find((e) => e.id === "experiential");

describe("Experiential Labs provider", () => {
  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.authModes).toEqual(["apikey"]);
    expect(entry.alias).toBe("experiential");
    expect(entry.aliases).toEqual(expect.arrayContaining(["exp", "xpl", "experientiallabs"]));
  });

  it("points at the documented gateway endpoints", () => {
    expect(PROVIDERS.experiential.baseUrl).toBe("https://api.experientiallabs.ai/v1/chat/completions");
    expect(PROVIDERS.experiential.validateUrl).toBe("https://api.experientiallabs.ai/v1/models");
    // transport.format defaults to "openai" via the shared provider default
    expect(PROVIDERS.experiential.format).toBe("openai");
  });

  it("resolves the shortcuts and keeps vendor-prefixed ids routable", () => {
    expect(resolveProviderAlias("experiential")).toBe("experiential");
    expect(resolveProviderAlias("exp")).toBe("experiential");
    expect(resolveProviderAlias("xpl")).toBe("experiential");
    // A custom provider pointed at /api/v1/models imports vendor-prefixed ids;
    // the prefix resolves here and the bare slug is what the gateway expects.
    expect(resolveProviderAlias("experientiallabs")).toBe("experiential");
    const parsed = parseModel("experientiallabs/deepseek-v4.1-flash-1017");
    expect(parsed.provider).toBe("experiential");
    expect(parsed.model).toBe("deepseek-v4.1-flash-1017");
    expect(parseModel("exp/claude-opus-5.5").provider).toBe("experiential");
  });

  it("exposes seed models with catalog context windows and forwards unknown slugs", () => {
    const models = PROVIDER_MODELS.experiential;
    const ids = models.map((m) => m.id);
    expect(ids).toContain("deepseek-v4.1-flash-1017");
    expect(ids).toContain("deepseek-v4.1-flash-uncensored");
    expect(ids).toContain("gpt-6-luna");
    expect(getDefaultModel("experiential")).toBe("gpt-6-luna");
    expect(models.find((m) => m.id === "deepseek-v4.1-flash-1017")).toMatchObject({
      contextLength: 1048576,
      maxOutputTokens: 393216,
    });
    expect(entry.passthroughModels).toBe(true);
    // The catalog is larger than the seed: unknown slugs still route.
    expect(isValidModel("experiential", "some-new-slug", new Set(["experiential"]))).toBe(true);
  });

  it("prices seeded slugs at the platform-funded catalog rates", () => {
    expect(getPricingForModel("experiential", "gpt-6-luna")).toMatchObject({ input: 0.1, output: 0.5 });
    expect(getPricingForModel("experiential", "deepseek-v4.1-flash-1017")).toMatchObject({ input: 0.3, output: 1.2, cached: 0.006 });
    // Clef bills output at $0 — the override must survive the canonical table.
    expect(getPricingForModel("experiential", "clef")).toMatchObject({ input: 0.24, output: 0 });
  });

  it("appears in the apikey grid and the quota dashboard lists", () => {
    const provider = AI_PROVIDERS.experiential;
    expect(provider).toBeDefined();
    expect(provider.authType).toBe("apikey");
    expect(provider.notice?.apiKeyUrl).toBe("https://platform.experientiallabs.ai/settings/api-keys");
    expect(getProvidersByKind("llm").some((p) => p.id === "experiential")).toBe(true);
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("experiential");
    expect(USAGE_APIKEY_PROVIDERS).toContain("experiential");
  });

  it("ships the published free-core allowance as an RPM preset", () => {
    const presets = AI_PROVIDERS.experiential.rateLimitPresets;
    expect(presets).toBeDefined();
    const free = presets.find((p) => p.id === "free-core");
    expect(free).toMatchObject({ rpm: 10, perModel: true });
    expect(free.note).toMatch(/per model/i);
    // The off preset clears the budget instead of setting an rpm of 0.
    expect(presets.find((p) => p.id === "off").rpm).toBe(0);
  });
});
