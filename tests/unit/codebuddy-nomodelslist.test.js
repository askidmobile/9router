// CodeBuddy's gateway answers chat and billing but publishes no model catalog:
// /v2/models is 404 on www.codebuddy.ai and www.workbuddy.ai alike (verified
// live). Without an opt-out the models route derives `<baseUrl>/models` from
// transport.baseUrl, so the dashboard rendered an "Import Models" button that
// could only ever fail with "Failed to fetch live models".
import { describe, it, expect } from "vitest";
import { deriveModelsEndpoint, getRegistryEntry } from "@/lib/providerModels/deriveModelsEndpoint.js";
import REGISTRY from "open-sse/providers/registry/index.js";

describe("noModelsList opt-out", () => {
  it("suppresses the derived catalog for both CodeBuddy sites", () => {
    for (const id of ["codebuddy-intl", "codebuddy-cn"]) {
      const derived = deriveModelsEndpoint(getRegistryEntry(id));
      expect(derived).toBeNull();
    }
  });

  it("still derives for providers that do publish a catalog", () => {
    // Sanity check that the opt-out is targeted, not a blanket disable. A
    // provider with a plain OpenAI-style gateway still gets its endpoint.
    const entry = { id: "x", transport: { baseUrl: "https://api.example.com/v1/chat/completions" } };
    expect(deriveModelsEndpoint(entry)).toEqual({
      url: "https://api.example.com/v1/models",
      style: "openai",
    });
  });

  it("flags both codebuddy entries in the registry", () => {
    const ids = REGISTRY.filter((r) => r.noModelsList === true).map((r) => r.id).sort();
    expect(ids).toEqual(["codebuddy-cn", "codebuddy-intl"]);
  });
});
