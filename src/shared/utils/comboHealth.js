import REGISTRY from "open-sse/providers/registry/index.js";

// Use the same built-in aliases as routing. Custom prefixes cannot shadow them.
export function buildComboProviderMap(connections = []) {
  const providers = new Map();
  for (const entry of REGISTRY) {
    for (const key of [entry.id, entry.alias, entry.uiAlias, ...(entry.aliases || [])]) {
      if (key) providers.set(key, entry.id);
    }
  }
  for (const connection of connections) {
    const provider = connection?.provider;
    const prefix = connection?.providerSpecificData?.prefix;
    if (!provider) continue;
    if (!providers.has(provider)) providers.set(provider, provider);
    if (prefix && !providers.has(prefix)) providers.set(prefix, provider);
  }
  return providers;
}

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Explicitly whitelist dashboard metadata. Probe leases/tokens stay server-side.
export function toPublicComboCircuit(record) {
  if (!record || !["open", "probing"].includes(record.state)
    || typeof record.provider !== "string" || typeof record.model !== "string") return null;
  return {
    provider: record.provider,
    model: record.model,
    state: record.state,
    failureCount: Number.isFinite(record.failureCount) ? Math.max(0, Math.floor(record.failureCount)) : 0,
    openedAt: timestamp(record.openedAt),
    lastFailureAt: timestamp(record.lastFailureAt),
    nextProbeAt: timestamp(record.nextProbeAt),
    lastProbeAt: timestamp(record.lastProbeAt),
    lastStatus: Number.isInteger(record.lastStatus) ? record.lastStatus : null,
    lastReason: typeof record.lastReason === "string" ? record.lastReason.slice(0, 240) : null,
  };
}

export function getComboMemberCircuit(member, circuits, providers, now) {
  if (typeof member !== "string") return null;
  const slash = member.indexOf("/");
  if (slash <= 0 || slash === member.length - 1) return null;
  const prefix = member.slice(0, slash);
  const provider = providers.get(prefix) || prefix;
  const model = member.slice(slash + 1);
  const circuit = circuits.find((entry) => entry.provider === provider && entry.model === model
    && ["open", "probing"].includes(entry.state));
  if (!circuit) return null;
  const remainingMs = Math.max(0, (timestamp(circuit.nextProbeAt) || 0) - now);
  return {
    ...circuit,
    remainingMs,
    // A timer expiring only makes a probe due; it never makes a model healthy.
    phase: circuit.state === "probing" ? "probing" : remainingMs > 0 ? "waiting" : "due",
  };
}
