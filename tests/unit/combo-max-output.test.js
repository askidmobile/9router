import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clampComboMaxOutput } from "../../open-sse/services/combo.js";
import { applyComboCapOverrides } from "../../src/shared/utils/comboHealth.js";

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

  it("is wired into the dashboard Combo editor as a collapsible section", async () => {
    const [source, chatSource, modelsSource] = await Promise.all([
      readFile(fileURLToPath(new URL("../../src/app/(dashboard)/dashboard/combos/page.js", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../../src/sse/handlers/chat.js", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../../src/app/api/v1/models/route.js", import.meta.url)), "utf8"),
    ]);
    expect(source).toContain("Advanced settings");
    expect(source).toContain("Context window — CTX (tokens)");
    expect(source).toContain("Max output (tokens)");
    expect(source).toContain('"not configured"');
    expect(source).toContain("Limit across members");
    expect(source).toContain("persistComboExtras");
    expect(chatSource).toContain("comboMaxOutput: comboStrategies[modelStr]?.maxOutput");
    expect(chatSource).toContain("clampComboMaxOutput(body, execution.comboMaxOutput)");
    expect(modelsSource).toContain("applyComboCapOverrides");
  });
});

describe("Combo CTX / OUT capability overrides", () => {
  const caps = { contextWindow: 1_000_000, maxOutput: 131_072, vision: true };

  it("never exceeds the members' conservative caps and keeps other capabilities", () => {
    expect(applyComboCapOverrides(caps, { contextWindow: 512_000, maxOutput: 64_000 }))
      .toEqual({ contextWindow: 512_000, maxOutput: 64_000, vision: true });
    expect(applyComboCapOverrides(caps, { contextWindow: 2_000_000, maxOutput: 200_000 }))
      .toEqual({ contextWindow: 1_000_000, maxOutput: 131_072, vision: true });
  });

  it("fills a cap the static members did not declare", () => {
    expect(applyComboCapOverrides({ vision: true }, { contextWindow: 200_000, maxOutput: 32_000 }))
      .toEqual({ vision: true, contextWindow: 200_000, maxOutput: 32_000 });
  });

  it.each([null, undefined, {}, { contextWindow: 0, maxOutput: -1 }, { contextWindow: "x" }])(
    "ignores an empty or invalid override %j", (override) => {
      expect(applyComboCapOverrides(caps, override)).toEqual(override && typeof override === "object" ? caps : caps);
    },
  );
});
