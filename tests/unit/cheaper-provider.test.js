// Cheaper Inference is a native provider (was a user-defined openai-compatible
// node). Locks the registry contract and the declarative 4.5 MB request-body cap.
import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { deriveModelsEndpoint } from "@/lib/providerModels/deriveModelsEndpoint.js";
import { isComboHealthFailure } from "../../open-sse/services/comboExecution.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
const { BaseExecutor } = await import("../../open-sse/executors/base.js");

const MAX_BODY = 4_500_000;
const entry = REGISTRY.find((e) => e.id === "cheaper");

beforeEach(() => fetchMock.mockReset());

describe("Cheaper Inference provider", () => {
  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("cheaper");
    expect(entry.aliases).toContain("ci");
  });

  it("points at the verified OpenAI-compatible endpoints", () => {
    expect(PROVIDERS.cheaper.baseUrl).toBe("https://api.cheaperinference.com/v1/chat/completions");
    expect(PROVIDERS.cheaper.validateUrl).toBe("https://api.cheaperinference.com/v1/models");
    // transport.format defaults to "openai" via the shared provider default
    expect(PROVIDERS.cheaper.format).toBe("openai");
  });

  it("keeps the Responses wire format for Responses clients", () => {
    // Codex sends `input`/`store`; the stateless compatibility layer takes that
    // body as-is, so a sourceFormat-matched transport must exist for it.
    expect(resolveTransport("cheaper", "openai-responses")?.baseUrl)
      .toBe("https://api.cheaperinference.com/v1/responses");
    expect(resolveTransport("cheaper", "openai")?.baseUrl)
      .toBe("https://api.cheaperinference.com/v1/chat/completions");
    // The Anthropic Messages surface is deliberately not declared.
    expect(resolveTransport("cheaper", "claude")).toBeNull();
  });

  it("declares the 4.5 MB request-body cap as a transport quirk", () => {
    expect(PROVIDERS.cheaper.quirks.maxRequestBodyBytes).toBe(MAX_BODY);
  });

  it("fetches the live catalogue from GET /v1/models with the connection key", () => {
    expect(deriveModelsEndpoint(entry)).toEqual({
      url: "https://api.cheaperinference.com/v1/models",
      style: "openai",
    });
    expect(entry.passthroughModels).toBe(true);
  });

  it("exposes bare (unprefixed) model ids, including the ones used in combos", () => {
    const ids = (PROVIDER_MODELS.cheaper || []).map((m) => m.id);
    expect(ids).toContain("deepseek-v4.1-flash");
    expect(ids).toContain("claude-opus-5.5");
    expect(ids.every((id) => !id.includes("/"))).toBe(true);
  });

  it("resolves the vendor aliases and routes through the shared executor", () => {
    expect(resolveProviderAlias("ci")).toBe("cheaper");
    expect(resolveProviderAlias("cheaper")).toBe("cheaper");
    expect(parseModel("cheaper/deepseek-v4.1-flash"))
      .toMatchObject({ provider: "cheaper", model: "deepseek-v4.1-flash" });
    expect(getExecutor("cheaper")).toBeInstanceOf(DefaultExecutor);
  });

  it("keeps every registry id unique after adding cheaper", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("declarative request-body limit", () => {
  const creds = { apiKey: "k" };
  const ok = { status: 200, headers: { get: () => "" } };

  it("sends a body under the limit untouched", async () => {
    fetchMock.mockResolvedValue(ok);
    const ex = new BaseExecutor("cheaper", PROVIDERS.cheaper);
    const out = await ex.execute({
      model: "glm-5.3",
      body: { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: creds,
    });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized body locally without calling the provider", async () => {
    const ex = new BaseExecutor("cheaper", PROVIDERS.cheaper);
    const out = await ex.execute({
      model: "glm-5.3",
      body: { model: "glm-5.3", messages: [{ role: "user", content: "x".repeat(MAX_BODY + 100_000) }] },
      stream: false,
      credentials: creds,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.response.status).toBe(413);
    // A bare status is useless in logs: the message must name the limit and the size.
    const parsed = await parseUpstreamError(out.response, ex);
    expect(parsed.statusCode).toBe(413);
    expect(parsed.message).toContain("4.5 MB");
    expect(parsed.message).toContain("4.6 MB");
  });

  it("treats 413 as request-scoped: Combo skips the member, the account stays usable", () => {
    expect(isComboHealthFailure(413)).toBe(false);
    expect(checkFallbackError(413, "too large", 0, { modelFallback: true }).shouldFallback).toBe(true);
    expect(checkFallbackError(413, "too large", 0).cooldownMs).toBe(0);
  });

  it("leaves providers without the quirk on the normal fetch path", async () => {
    fetchMock.mockResolvedValue(ok);
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    const out = await ex.execute({
      model: "m",
      body: { messages: [{ role: "user", content: "x".repeat(MAX_BODY + 100_000) }] },
      stream: false,
      credentials: creds,
    });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
