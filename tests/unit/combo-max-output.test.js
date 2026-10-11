import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clampComboMaxOutput } from "../../open-sse/services/combo.js";

describe("Combo CTX OUT cap", () => {
  it("lowers the caller's limits and never raises them", () => {
    const body = { max_tokens: 4096, max_output_tokens: 8192 };
    clampComboMaxOutput(body, 1024);
    expect(body).toEqual({ max_tokens: 1024, max_output_tokens: 1024 });
    const small = { max_tokens: 100 };
    clampComboMaxOutput(small, 5000);
    expect(small.max_tokens).toBe(100);
  });

  it("never invents a limit the client did not send", () => {
    const body = { messages: [] };
    clampComboMaxOutput(body, 1024);
    expect(body).toEqual({ messages: [] });
  });

  it.each([null, undefined, 0, -1, "1024", 1.5, NaN])("ignores an unusable cap %s", (cap) => {
    const body = { max_tokens: 4096 };
    clampComboMaxOutput(body, cap);
    expect(body.max_tokens).toBe(4096);
  });

  it("is wired into the dashboard Combo editor with member limits and persistence", async () => {
    const [source, chatSource] = await Promise.all([
      readFile(fileURLToPath(new URL("../../src/app/(dashboard)/dashboard/combos/page.js", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../../src/sse/handlers/chat.js", import.meta.url)), "utf8"),
    ]);
    expect(source).toContain("Max output — CTX OUT (tokens)");
    expect(source).toContain("Limit across members");
    expect(source).toContain("persistComboExtras");
    expect(chatSource).toContain("comboMaxOutput: comboStrategies[modelStr]?.maxOutput");
    expect(chatSource).toContain("clampComboMaxOutput(body, execution.comboMaxOutput)");
  });
});
