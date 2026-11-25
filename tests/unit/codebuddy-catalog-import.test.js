// Импорт моделей CodeBuddy: у шлюза нет эндпоинта каталога, список берётся из
// product.json npm-пакета CLI (публичный файл, ключ не нужен).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCodeBuddyModel } from "../../open-sse/services/codebuddyModels.js";
import { CODEBUDDY_PRODUCT_URL, resolveCodeBuddyModels } from "../../open-sse/services/codebuddyModels.js";
import { catalogMetadata } from "../../src/lib/providerCatalog/metadata.js";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });

const row = (overrides = {}) => ({
  id: "hy4-preview", name: "Hy4 preview", maxInputTokens: 1000000, maxOutputTokens: 64000,
  supportsToolCall: true, supportsImages: true, supportsReasoning: true, onlyReasoning: true,
  reasoning: { canDisableThinking: false, defaultEffort: "high", supportedEfforts: ["high"], summary: "auto" },
  ...overrides,
});

describe("CodeBuddy product.json catalog", () => {
  it("maps a row into the generic catalog entry with limits, flags and efforts", () => {
    const entry = normalizeCodeBuddyModel(row());
    expect(entry).toMatchObject({
      id: "hy4-preview", name: "Hy4 preview", type: "text",
      context_length: 1000000, max_output_tokens: 64000,
      isVL: true, isReasoning: true,
      capabilities: { vision: true, tools: true, reasoning: true },
      reasoning: { mandatory: true },
      reasoning_levels: ["high"],
    });
    expect(catalogMetadata(entry).caps).toMatchObject({
      contextWindow: 1000000, maxOutput: 64000, vision: true, tools: true,
      reasoning: true, thinkingCanDisable: false, reasoningLevels: ["high"], thinkingFormat: "openai",
    });
  });

  it("offers «none» when thinking can be switched off", () => {
    const entry = normalizeCodeBuddyModel(row({
      id: "gpt-5.6-sol", onlyReasoning: false,
      reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high", "max"], canDisableThinking: true },
    }));
    expect(entry.reasoning_levels).toEqual(["none", "low", "high", "max"]);
    expect(catalogMetadata(entry).caps.thinkingCanDisable).toBe(true);
  });

  it("drops the CLI routing aliases and rows without an id", () => {
    for (const id of ["default-model", "fast-model", "primary-model", "deep-model"]) {
      expect(normalizeCodeBuddyModel(row({ id }))).toBeNull();
    }
    expect(normalizeCodeBuddyModel(row({ id: "  " }))).toBeNull();
  });

  it("fetches the public file without the connection key", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [row(), row({ id: "deep-model" })] }) });

    const { models } = await resolveCodeBuddyModels();

    expect(models.map((m) => m.id)).toEqual(["hy4-preview"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CODEBUDDY_PRODUCT_URL);
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|bearer|key/i);
  });

  it("throws on a non-200 answer so the caller falls back to the static list", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(resolveCodeBuddyModels()).rejects.toThrow("responded 503");
  });
});
