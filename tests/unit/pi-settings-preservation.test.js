import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFile, writeFile } = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("fs/promises", () => ({ default: { access: vi.fn(), mkdir: vi.fn(), readFile, writeFile } }));
vi.mock("../../src/app/api/cli-tools/resolveApiKey.js", () => ({ resolveCliApiKey: vi.fn() }));
import { POST } from "../../src/app/api/cli-tools/pi-settings/route.js";

beforeEach(() => { readFile.mockReset(); writeFile.mockReset(); });

describe("Pi settings preserve user model configuration", () => {
  it("retains hand-set names, limits and custom fields when Apply sends only the id", async () => {
    const model = { id: "combo", name: "My model", contextWindow: 600000, maxTokens: 128000, reasoning: true };
    readFile.mockResolvedValue(JSON.stringify({ providers: { "9router": { apiKey: "fixture", models: [model] }, other: { models: [] } } }));
    const response = await POST({ json: async () => ({ baseUrl: "http://localhost:20128", models: [{ id: "combo", name: "combo" }] }) });
    expect(response.status).toBe(200);
    const saved = JSON.parse(writeFile.mock.calls[0][1]);
    expect(saved.providers["9router"].models).toEqual([model]);
    expect(saved.providers.other).toEqual({ models: [] });
  });
  it("uses explicit valid limits and sanitizes corrupt saved limits", async () => {
    readFile.mockResolvedValue(JSON.stringify({ providers: { "9router": { models: [{ id: "combo", contextWindow: -1, maxTokens: "broken" }] } } }));
    const response = await POST({ json: async () => ({ baseUrl: "http://localhost:20128", apiKey: "fixture", models: [{ id: "combo", contextWindow: 400000 }] }) });
    expect(response.status).toBe(200);
    expect(JSON.parse(writeFile.mock.calls[0][1]).providers["9router"].models[0]).toMatchObject({ contextWindow: 400000, maxTokens: 64000 });
  });
});
