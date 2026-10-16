import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const completion = (message, finish_reason = "stop") => ({ choices: [{ message, finish_reason }] });

describe("Combo JSON zero-content fallback", () => {
  it.each([
    completion({ content: "" }, null),
    { content: [], stop_reason: "in_progress" },
  ])("tries the next model after an unfinished empty response", async (empty) => {
    const good = completion({ content: "recovered" });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(Response.json(empty))
      .mockResolvedValueOnce(Response.json(good));
    const result = await handleComboChat({
      body: {}, models: ["first/model", "second/model"], handleSingleModel, log,
    });
    expect(handleSingleModel.mock.calls.map((call) => call[1])).toEqual(["first/model", "second/model"]);
    expect(await result.json()).toEqual(good);
  });

  it("returns a tool-only response without calling another model", async () => {
    const tool = completion({ content: null, tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }] }, "tool_calls");
    const handleSingleModel = vi.fn(async () => Response.json(tool));
    const result = await handleComboChat({
      body: {}, models: ["first/model", "second/model"], handleSingleModel, log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(await result.json()).toEqual(tool);
  });

  it("preserves the final model response when no fallback remains", async () => {
    const empty = completion({ content: "" }, null);
    const handleSingleModel = vi.fn(async () => Response.json(empty));
    const result = await handleComboChat({ body: {}, models: ["only/model"], handleSingleModel, log });
    expect(await result.json()).toEqual(empty);
  });
});
