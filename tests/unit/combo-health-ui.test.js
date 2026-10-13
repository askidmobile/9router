import { describe, expect, it } from "vitest";
import {
  buildComboProviderMap,
  getComboMemberCircuit,
  toPublicComboCircuit,
} from "../../src/shared/utils/comboHealth.js";

const NOW = 1_800_000_000_000;
const CUSTOM_ID = "openai-compatible-chat-health-test";
const providers = buildComboProviderMap([
  { provider: CUSTOM_ID, providerSpecificData: { prefix: "cheaper-test" } },
  { provider: CUSTOM_ID, providerSpecificData: { prefix: "cheaper-test" } },
  { provider: "anthropic-compatible-test", providerSpecificData: { prefix: "cmc" } },
]);
const open = (provider, model = "z-ai/glm-5.3-flash", extra = {}) => ({
  provider, model, state: "open", failureCount: 3, nextProbeAt: NOW + 60_000,
  lastStatus: 502, lastReason: "Upstream HTTP 502", ...extra,
});

describe("combo frozen-state display", () => {
  it("matches built-in aliases and IDs, preserving model slashes and provider boundaries", () => {
    const circuits = [open("commandcode")];
    const byAlias = getComboMemberCircuit("cmc/z-ai/glm-5.3-flash", circuits, providers, NOW);
    const byId = getComboMemberCircuit("commandcode/z-ai/glm-5.3-flash", circuits, providers, NOW);
    expect(byAlias).toEqual(byId);
    expect(byAlias).toMatchObject({ provider: "commandcode", remainingMs: 60_000, phase: "waiting" });
    expect(getComboMemberCircuit("clinepass/z-ai/glm-5.3-flash", circuits, providers, NOW)).toBeNull();
    expect(getComboMemberCircuit("cmc/z-ai/glm-5.3", circuits, providers, NOW)).toBeNull();
  });

  it("resolves a custom prefix to its UUID and shares state across combo member spellings", () => {
    const circuits = [open(CUSTOM_ID, "glm-5.3-flash")];
    const prefixed = getComboMemberCircuit("cheaper-test/glm-5.3-flash", circuits, providers, NOW);
    expect(prefixed).toEqual(getComboMemberCircuit(`${CUSTOM_ID}/glm-5.3-flash`, circuits, providers, NOW));
    expect(prefixed).toMatchObject({ provider: CUSTOM_ID, failureCount: 3 });
    expect(providers.get("cmc")).toBe("commandcode");
  });

  it.each([NOW - 60_000, NOW, null])("hides an expired or missing next-attempt time %s", (nextProbeAt) => {
    const status = getComboMemberCircuit("cmc/z-ai/glm-5.3-flash", [open("commandcode", undefined, { nextProbeAt })], providers, NOW);
    expect(status).toBeNull();
  });

  it("hides the pair when its cooldown expires without mutating server metadata", () => {
    const circuit = open("commandcode");
    expect(getComboMemberCircuit("cmc/z-ai/glm-5.3-flash", [circuit], providers, NOW + 59_999)).not.toBeNull();
    expect(getComboMemberCircuit("cmc/z-ai/glm-5.3-flash", [circuit], providers, NOW + 60_000)).toBeNull();
    expect(circuit).toEqual(open("commandcode"));
    expect(getComboMemberCircuit("cmc/z-ai/glm-5.3-flash", [], providers, NOW)).toBeNull();
  });

  it.each([null, "nested-combo", "/model", "provider/"])("does not guess the provider for %s", (member) => {
    expect(getComboMemberCircuit(member, [open("commandcode")], providers, NOW)).toBeNull();
  });

  it("only exposes whitelisted circuit metadata", () => {
    const publicRecord = toPublicComboCircuit(open("commandcode", undefined, {
      probeToken: "private-lease-token", leaseUntil: NOW + 10_000,
      credentials: { apiKey: "secret" }, headers: { Authorization: "Bearer private" },
      openedAt: NOW - 20_000, lastFailureAt: NOW - 10_000, lastProbeAt: NOW - 5000,
    }));
    expect(publicRecord).toEqual({
      provider: "commandcode", model: "z-ai/glm-5.3-flash", state: "open", failureCount: 3,
      nextProbeAt: NOW + 60_000, lastStatus: 502, lastReason: "Upstream HTTP 502",
      openedAt: NOW - 20_000, lastFailureAt: NOW - 10_000, lastProbeAt: NOW - 5000,
    });
    expect(JSON.stringify(publicRecord)).not.toMatch(/private|secret|credentials|Authorization|leaseUntil|probeToken/);
  });

  it("drops invalid circuit records", () => {
    expect(toPublicComboCircuit(null)).toBeNull();
    expect(toPublicComboCircuit(open("commandcode", undefined, { state: "closed" }))).toBeNull();
    expect(toPublicComboCircuit(open(null))).toBeNull();
  });
});
