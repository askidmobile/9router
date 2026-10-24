// Respan Gateway — OpenAI-compatible router (api.respan.ai). Locks the registry
// contract: endpoint, Bearer auth, validateUrl probe, passthrough + seed models.
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { isValidModel, getDefaultModel } from "../../open-sse/config/providerModels.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";

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
