// Requesty and APInex Bond as native providers (both replaced user-defined
// openai-compatible nodes). Locks the registry contract and the catalog shapes.
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { deriveModelsEndpoint } from "../../src/lib/providerModels/deriveModelsEndpoint.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

describe("Requesty provider", () => {
  const entry = REGISTRY.find((e) => e.id === "requesty");

  it("keeps the `req` prefix that existing combos route by", () => {
    expect(entry.alias).toBe("req");
    expect(resolveProviderAlias("req")).toBe("requesty");
    expect(parseModel("req/vertex/gemini-3.8-flash"))
      .toMatchObject({ provider: "requesty", model: "vertex/gemini-3.8-flash" });
  });

  it("points at the verified endpoints", () => {
    expect(PROVIDERS.requesty.baseUrl).toBe("https://router.requesty.ai/v1/chat/completions");
    expect(PROVIDERS.requesty.validateUrl).toBe("https://router.requesty.ai/v1/models");
  });

  it("declares the three wire formats it really serves", () => {
    expect(resolveTransport("requesty", "openai")?.baseUrl).toBe("https://router.requesty.ai/v1/chat/completions");
    expect(resolveTransport("requesty", "openai-responses")?.baseUrl).toBe("https://router.requesty.ai/v1/responses");
    // The docs' bare /anthropic/v1/messages 404s; Messages lives on the /v1 base.
    expect(resolveTransport("requesty", "claude")?.baseUrl).toBe("https://router.requesty.ai/v1/messages");
  });

  it("reads its catalog from the authenticated /v1/models", () => {
    expect(deriveModelsEndpoint(entry)).toEqual({ url: "https://router.requesty.ai/v1/models", style: "openai" });
    expect(entry.passthroughModels).toBe(true);
  });

  it("routes through the shared executor and passes unknown ids through", () => {
    expect(getExecutor("requesty")).toBeInstanceOf(DefaultExecutor);
    // Model lists are keyed by alias (`req`), which is also what routing uses.
    const ids = (PROVIDER_MODELS.req || []).map((m) => m.id);
    expect(ids).toContain("anthropic/claude-opus-5-5");
    // Requesty ids are vendor-qualified. Version punctuation is mixed upstream
    // (claude-opus-5-5 but gpt-6.1-sol), so ids are kept verbatim.
    expect(ids.every((id) => id.includes("/"))).toBe(true);
  });
});

describe("APInex Bond provider", () => {
  const entry = REGISTRY.find((e) => e.id === "apinex");

  it("keeps the `apinex` prefix and exposes the `apx` alias", () => {
    expect(entry.alias).toBe("apinex");
    expect(entry.aliases).toContain("apx");
    expect(resolveProviderAlias("apx")).toBe("apinex");
    expect(parseModel("apinex/free/kimi-k3")).toMatchObject({ provider: "apinex", model: "free/kimi-k3" });
  });

  it("declares chat, responses and Anthropic Messages", () => {
    expect(resolveTransport("apinex", "openai")?.baseUrl).toBe("https://api.apinex.bond/v1/chat/completions");
    expect(resolveTransport("apinex", "openai-responses")?.baseUrl).toBe("https://api.apinex.bond/v1/responses");
    expect(resolveTransport("apinex", "claude")?.baseUrl).toBe("https://api.apinex.bond/v1/messages");
  });

  it("points the catalog at the public feed, which is the one with metadata", () => {
    // The authenticated /v1/models returns bare ids only.
    expect(deriveModelsEndpoint(entry)).toEqual({ url: "https://apinex.bond/api/public/models", style: "openai" });
    expect(entry.passthroughModels).toBe(true);
  });

  it("seeds both paid and free ids", () => {
    const ids = (PROVIDER_MODELS.apinex || []).map((m) => m.id);
    expect(ids).toContain("claude-opus-5.5");
    expect(ids.some((id) => id.startsWith("free/"))).toBe(true);
  });
});

describe("registry additions", () => {
  it("keeps every id unique", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
