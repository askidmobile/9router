import { beforeEach, describe, expect, it, vi } from "vitest";

const kv = vi.hoisted(() => ({ getAll: vi.fn(), setMany: vi.fn() }));
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => kv }));
const { setCapsOverridesBulk } = await import("../../src/lib/db/repos/capsRepo.js");

beforeEach(() => { vi.clearAllMocks(); kv.getAll.mockResolvedValue({}); });

describe("models.dev capability import preserves effort settings", () => {
  it.each([["xhigh", "max"], [], null].map(reasoningLevels => ({ reasoningLevels })))("preserves %j while refreshing other capabilities", async ({ reasoningLevels }) => {
    kv.getAll.mockResolvedValue({
      "ocg|space-bunny": { reasoning: true, reasoningLevels, contextWindow: 999 },
      "openai|space-bunny": { reasoningLevels: ["low"] },
    });
    await setCapsOverridesBulk("ocg", { "space-bunny": { reasoning: false, contextWindow: 1000000, tools: true } });
    expect(kv.setMany).toHaveBeenCalledWith({ "ocg|space-bunny": {
      reasoning: true, reasoningLevels, contextWindow: 1000000, tools: true,
    } });
  });

  it("keeps ordinary catalog imports unchanged when no custom effort list exists", async () => {
    const caps = { reasoning: true, contextWindow: 1000000 };
    await setCapsOverridesBulk("ocg", { "space-bunny": caps });
    expect(kv.setMany).toHaveBeenCalledWith({ "ocg|space-bunny": caps });
  });
});
