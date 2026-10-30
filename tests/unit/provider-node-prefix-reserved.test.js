// A provider node is reachable only through its prefix, while getModelInfo()
// resolves built-in ids/aliases straight from the registry and checks reserved
// prefixes BEFORE looking nodes up. So any registry alias that happens to match
// a node's prefix silently steals every `<prefix>/model` request from that node.
// This locks the rule: no registry entry may claim a prefix a hand-made node for
// the same gateway would naturally carry.
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { isReservedProviderPrefix } from "../../src/sse/services/model.js";

// Prefixes of the nodes a real deployment carries, plus the vendor spellings the
// gateways' own listings hand out. A node named after its vendor is the natural
// setup, so the registry must leave these free.
const NODE_PREFIXES_IN_USE = [
  "experientiallabs",
  "kenari",
  "qubax",
];

describe("registry aliases vs provider-node prefixes", () => {
  it("leaves every prefix a provider node may own unreserved", () => {
    for (const prefix of NODE_PREFIXES_IN_USE) {
      expect(isReservedProviderPrefix(prefix)).toBe(false);
    }
  });

  it("keeps the experiential provider reachable without that prefix", () => {
    const entry = REGISTRY.find((e) => e.id === "experiential");
    const tokens = [entry.id, entry.alias, ...(entry.aliases || [])].filter(Boolean);
    expect(tokens).toContain("experiential");
    expect(tokens).toContain("exp");
    for (const prefix of NODE_PREFIXES_IN_USE) expect(tokens).not.toContain(prefix);
  });
});
