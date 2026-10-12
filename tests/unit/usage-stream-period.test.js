import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUsageStats: vi.fn(), getActiveRequests: vi.fn() }));
const statsEmitter = new EventEmitter();
vi.mock("@/lib/usageDb", () => ({ ...mocks, statsEmitter }));
const { GET } = await import("../../src/app/api/usage/stream/route.js");

afterEach(() => {
  vi.clearAllMocks();
  statsEmitter.removeAllListeners();
});

describe("live usage period", () => {
  it("refreshes model and key totals within the selected period", async () => {
    mocks.getUsageStats
      .mockResolvedValueOnce({ totalRequests: 2, byApiKey: { key: { cost: 0.02 } } })
      .mockResolvedValueOnce({ totalRequests: 3, byApiKey: { key: { cost: 0.04 } } });
    mocks.getActiveRequests.mockResolvedValue({ activeRequests: [], recentRequests: [] });
    const response = await GET(new Request("http://localhost/api/usage/stream?period=today"));
    const reader = response.body.getReader();
    const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6));
    try {
      expect(await read()).toMatchObject({ totalRequests: 2 });
      statsEmitter.emit("update");
      await read(); // Immediate lightweight update precedes the recalculated totals.
      expect(await read()).toMatchObject({ totalRequests: 3, byApiKey: { key: { cost: 0.04 } } });
      expect(mocks.getUsageStats.mock.calls).toEqual([["today"], ["today"]]);
    } finally {
      await reader.cancel();
    }
    expect(statsEmitter.listenerCount("update")).toBe(0);
  });

  it("rejects an invalid period before subscribing", async () => {
    const response = await GET(new Request("http://localhost/api/usage/stream?period=invalid"));
    expect(response.status).toBe(400);
    expect(mocks.getUsageStats).not.toHaveBeenCalled();
  });
});
