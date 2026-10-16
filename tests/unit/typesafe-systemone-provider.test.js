import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";

describe("typesafe System One provider", () => {
  const entry = REGISTRY.find((e) => e.id === "typesafe");

  it("is registered as a System One apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.serviceKinds).toEqual(["systemone"]);
    expect(PROVIDER_MEDIA["typesafe"]?.systemoneConfig?.baseUrl).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("appears in getProvidersByKind('systemone')", () => {
    const list = getProvidersByKind("systemone");
    const found = list.find((p) => p.id === "typesafe");
    expect(found).toBeDefined();
    expect(found.alias).toBe("typesafe");
    expect(found.systemoneConfig?.baseUrl).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("exposes the original Jev models", () => {
    const ids = (entry.models || []).map((m) => m.id);
    expect(ids).toContain("jev-latest");
    expect(ids).toContain("jev-preview");
    expect(ids).toContain("jev-1.13.0");
  });

  it("is an apikey provider with a Get API Key link", () => {
    const provider = AI_PROVIDERS["typesafe"];
    expect(provider).toBeDefined();
    expect(provider.authType).toBe("apikey");
    expect(provider.notice?.apiKeyUrl).toBe("https://console.typesafe.ai");
  });
});
