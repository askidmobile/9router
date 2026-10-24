// Respan Gateway — OpenAI-compatible router (api.respan.ai). Locks the registry
// contract: endpoint, Bearer auth, validateUrl probe, passthrough + seed models,
// and the paginated POST catalog normalizer (caps/pricing shapes).
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { isValidModel, getDefaultModel } from "../../open-sse/config/providerModels.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { normalizeRespanModel } from "../../open-sse/services/respan.js";
import { catalogMetadata } from "@/lib/providerCatalog/metadata.js";

const entry = REGISTRY.find((e) => e.id === "respan");

describe("Respan Gateway provider", () => {
  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.authModes).toEqual(["apikey"]);
    expect(entry.alias).toBe("respan");
    expect(entry.aliases).toContain("rs");
  });

  it("points at the documented gateway endpoints", () => {
    expect(PROVIDERS.respan.baseUrl).toBe("https://api.respan.ai/api/chat/completions");
    expect(PROVIDERS.respan.validateUrl).toBe("https://api.respan.ai/api/models/list/");
    // transport.format defaults to "openai" via the shared provider default
    expect(PROVIDERS.respan.format).toBe("openai");
  });

  it("resolves the rs shortcut and respan/rs model routing", () => {
    expect(resolveProviderAlias("respan")).toBe("respan");
    expect(resolveProviderAlias("rs")).toBe("respan");
    const parsed = parseModel("respan/azure/gpt-6-luna");
    expect(parsed.provider).toBe("respan");
    expect(parsed.model).toBe("azure/gpt-6-luna");
  });

  it("exposes seed models and forwards unknown catalog ids (passthrough)", () => {
    expect(PROVIDER_MODELS.respan.length).toBeGreaterThan(0);
    const ids = PROVIDER_MODELS.respan.map((m) => m.id);
    expect(ids).toContain("azure/gpt-6-luna");
    expect(ids).toContain("anthropic/claude-opus-5-5");
    expect(getDefaultModel("respan")).toBe("azure/gpt-6-luna");
    expect(isValidModel("respan", ids[0])).toBe(true);
    // catalog ids not in the seed list still route (hundreds of upstream models)
    expect(entry.passthroughModels).toBe(true);
    expect(isValidModel("respan", "azure/gpt-6-astra", new Set(["respan"]))).toBe(true);
  });

  it("appears in the apikey provider grid with a Get API Key link", () => {
    const provider = AI_PROVIDERS["respan"];
    expect(provider).toBeDefined();
    expect(provider.authType).toBe("apikey");
    expect(provider.notice?.apiKeyUrl).toBe("https://platform.respan.ai");
    expect(getProvidersByKind("llm").some((p) => p.id === "respan")).toBe(true);
  });
});

describe("Respan catalog normalizer", () => {
  const row = {
    model_name: "anthropic/claude-sonnet-5",
    status: "active",
    model_type: "text",
    max_context_window: 200000,
    input_cost: 2.0, input_price_unit: "token",
    output_cost: 10.0, output_price_unit: "token",
    cache_hit_input_cost: 0.2,
    cache_creation_input_cost: 2.5,
    supported_params: { tools: { name: "tools" }, reasoning_effort: {} },
    capability: { function_call: true, vision: false },
  };

  it("maps a listing row into caps and per-1M pricing", () => {
    const meta = catalogMetadata(normalizeRespanModel(row));
    expect(meta.id).toBe("anthropic/claude-sonnet-5");
    expect(meta.pricing).toEqual({ input: 2, output: 10, cached: 0.2, cache_creation: 2.5 });
    expect(meta.caps).toMatchObject({ contextWindow: 200000, tools: true, reasoning: true });
  });

  it("drops deprecated rows and negative (unsupported) cache costs", () => {
    expect(normalizeRespanModel({ ...row, status: "deprecated" })).toBeNull();
    const noCache = normalizeRespanModel({ ...row, cache_hit_input_cost: -1, cache_creation_input_cost: -1 });
    expect(catalogMetadata(noCache).pricing).toEqual({ input: 2, output: 10 });
  });
});
