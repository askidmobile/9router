import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  collectEligibleComboHealthPairs,
  createBackgroundComboHealthWorker,
} from "@/sse/services/backgroundComboHealth.js";
import { createComboHealthService } from "open-sse/services/comboHealth.js";

const pair = { provider: "clinepass", model: "cline-pass/glm-5.3-flash" };
const config = {
  probeTimeoutMs: 100,
  probeIntervalMs: 20,
  probeLeaseGraceMs: 10,
  baseCooldownMs: 100,
  maxCooldownMs: 1_000,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(overrides = {}, sharedState) {
  const deps = {
    config,
    environment: () => ({ NEXT_RUNTIME: "nodejs" }),
    collectEligiblePairs: vi.fn(async () => [pair]),
    claimProbe: vi.fn(async () => ({ ...pair, probeToken: "lease-1" })),
    finishProbe: vi.fn(async () => true),
    probe: vi.fn(async () => ({ ok: true, status: 200 })),
    warn: vi.fn(),
    ...overrides,
  };
  return { deps, worker: createBackgroundComboHealthWorker(deps, sharedState) };
}

function memoryService() {
  const records = new Map();
  const key = (provider, model) => JSON.stringify([provider, model]);
  const tx = {
    get: (provider, model) => structuredClone(records.get(key(provider, model)) || null),
    list: () => [...records.values()].map((record) => structuredClone(record)),
    set: (record) => records.set(key(record.provider, record.model), structuredClone(record)),
    remove: (provider, model) => records.delete(key(provider, model)),
  };
  const repository = { ...tx, transaction: async (fn) => fn(tx) };
  return createComboHealthService({ repository, config, now: Date.now });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T10:00:00Z"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Combo recovery worker", () => {
  it("claims only eligible pairs and requires an actual successful probe result", async () => {
    const { worker, deps } = harness();
    expect(await worker.tick()).toMatchObject({ success: true, applied: true });
    expect(deps.claimProbe).toHaveBeenCalledWith({ eligiblePairs: [pair] });
    expect(deps.probe).toHaveBeenCalledWith({ ...pair, signal: expect.any(AbortSignal) });
    expect(deps.finishProbe).toHaveBeenCalledWith(expect.objectContaining({
      ...pair, probeToken: "lease-1", success: true, status: 200, cancelled: false,
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: 200 },
    { ok: "true", status: 200 },
    { ok: false, status: 200, reason: "Empty generated answer" },
    { ok: true, status: 502 },
  ])("never treats HTTP status or a truthy value alone as recovery: %j", async (result) => {
    const { worker, deps } = harness({ probe: vi.fn(async () => result) });
    await worker.tick();
    expect(deps.finishProbe).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it("keeps a failed pair frozen, respects Retry-After, then reopens after a later successful probe", async () => {
    const service = memoryService();
    await service.freezeComboModel({ ...pair, status: 502, reason: "Provider refused" });
    const retryDeadline = Date.now() + 500;
    const { worker, deps } = harness({
      claimProbe: service.claimDueComboProbe,
      finishProbe: service.finishComboProbe,
      probe: vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 429, reason: "Rate limited", retryAfterMs: retryDeadline })
        .mockResolvedValueOnce({ ok: true, status: 200 }),
    });
    expect(await worker.tick()).toBeNull();
    expect(deps.probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await worker.tick();
    expect(await service.getComboHealth(pair.provider, pair.model)).toMatchObject({
      state: "open", failureCount: 2, nextProbeAt: retryDeadline, lastStatus: 429,
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(await worker.tick()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await worker.tick();
    expect(await service.getComboHealth(pair.provider, pair.model)).toBeNull();
  });

  it("ignores a stale successful probe after a newer foreground failure", async () => {
    const service = memoryService();
    await service.freezeComboModel({ ...pair, status: 502, reason: "Initial failure" });
    await vi.advanceTimersByTimeAsync(100);
    const pending = deferred();
    const { worker, deps } = harness({
      claimProbe: service.claimDueComboProbe,
      finishProbe: service.finishComboProbe,
      probe: vi.fn(() => pending.promise),
    });
    const result = worker.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.probe).toHaveBeenCalledTimes(1);
    await service.freezeComboModel({ ...pair, status: 503, reason: "Newer foreground failure" });
    pending.resolve({ ok: true, status: 200 });
    expect(await result).toMatchObject({ applied: false });
    expect(await service.getComboHealth(pair.provider, pair.model)).toMatchObject({
      state: "open", lastReason: "Newer foreground failure", lastStatus: 503,
    });
  });

  it("shares single-flight and timer ownership between module instances", async () => {
    const shared = { started: false, interval: null, tickPromise: null, controller: null, generation: 0 };
    const pending = deferred();
    const first = harness({ probe: vi.fn(() => pending.promise) }, shared);
    const second = harness({}, shared);
    expect(first.worker.start()).toBe(true);
    expect(second.worker.start()).toBe(false);
    const a = first.worker.tick();
    const b = second.worker.tick();
    expect(a).toBe(b);
    await vi.advanceTimersByTimeAsync(60);
    expect(first.deps.probe).toHaveBeenCalledTimes(1);
    expect(second.deps.probe).not.toHaveBeenCalled();
    pending.resolve({ ok: true, status: 200 });
    await a;
    await second.worker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled probe at its deadline, releases the lease once, and ignores a late success", async () => {
    const pending = deferred();
    const { worker, deps } = harness({ probe: vi.fn(() => pending.promise) });
    const result = worker.tick();
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ success: false, status: 504, cancelled: false });
    expect(deps.probe.mock.calls[0][0].signal.aborted).toBe(true);
    expect(deps.finishProbe).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.finishProbe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the bounded 15-minute Gemini Flex queue budget", async () => {
    const pending = deferred();
    const flexPair = { provider: "gemini", model: "gemini-3.8-flash:flex" };
    const { worker, deps } = harness({
      claimProbe: vi.fn(async () => ({ ...flexPair, probeToken: "flex-lease" })),
      probe: vi.fn(() => pending.promise),
    });
    const result = worker.tick();
    await vi.advanceTimersByTimeAsync(899_999);
    expect(deps.probe.mock.calls[0][0].signal.aborted).toBe(false);
    expect(deps.finishProbe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ success: false, status: 504 });
    expect(deps.probe.mock.calls[0][0].signal.aborted).toBe(true);
    pending.resolve({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.finishProbe).toHaveBeenCalledTimes(1);
  });

  it("keeps the singleton across fresh Next module copies", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("DISABLE_BACKGROUND_COMBO_HEALTH", "");
    const first = await import("@/sse/services/backgroundComboHealth.js");
    expect(first.startBackgroundComboHealth()).toBe(true);
    vi.resetModules();
    const second = await import("@/sse/services/backgroundComboHealth.js");
    expect(second.startBackgroundComboHealth()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await second.stopBackgroundComboHealth();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stopping aborts an in-flight probe without recording another failure", async () => {
    const service = memoryService();
    await service.freezeComboModel({ ...pair, status: 429, reason: "Initial quota refusal" });
    await vi.advanceTimersByTimeAsync(100);
    const pending = deferred();
    const { worker, deps } = harness({
      claimProbe: service.claimDueComboProbe,
      finishProbe: service.finishComboProbe,
      probe: vi.fn(() => pending.promise),
    });
    worker.start();
    const result = worker.tick();
    await vi.advanceTimersByTimeAsync(0);
    await worker.stop();
    expect(await result).toMatchObject({ cancelled: true });
    expect(deps.probe.mock.calls[0][0].signal.aborted).toBe(true);
    expect(await service.getComboHealth(pair.provider, pair.model)).toMatchObject({
      state: "open", failureCount: 1, lastStatus: 429, lastReason: "Initial quota refusal", leaseUntil: null,
    });
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await service.getComboHealth(pair.provider, pair.model)).not.toBeNull();
  });

  it("does not start inference when stop races with the lease claim", async () => {
    const pendingClaim = deferred();
    const { worker, deps } = harness({ claimProbe: vi.fn(() => pendingClaim.promise) });
    const result = worker.tick();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = worker.stop();
    pendingClaim.resolve({ ...pair, probeToken: "late-lease" });
    await stopped;
    await result;
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.finishProbe).toHaveBeenCalledWith(expect.objectContaining({
      probeToken: "late-lease", success: false, cancelled: true,
    }));
  });

  it("shutdown signals abort recovery and remove registered listeners", async () => {
    const shutdownTarget = new EventEmitter();
    const pending = deferred();
    const { worker, deps } = harness({ shutdownTarget, probe: vi.fn(() => pending.promise) });
    worker.start();
    const result = worker.tick();
    await vi.advanceTimersByTimeAsync(0);
    shutdownTarget.emit("SIGTERM");
    expect(await result).toMatchObject({ cancelled: true });
    expect(deps.probe.mock.calls[0][0].signal.aborted).toBe(true);
    expect(shutdownTarget.listenerCount("SIGTERM")).toBe(0);
    expect(shutdownTarget.listenerCount("SIGINT")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve({ ok: true, status: 200 });
  });

  it.each([
    { NEXT_PHASE: "phase-production-build" },
    { NEXT_PHASE: "phase-export" },
    { NEXT_PHASE: "phase-static" },
    { NEXT_RUNTIME: "edge" },
    { DISABLE_BACKGROUND_COMBO_HEALTH: "true" },
  ])("does not schedule or query providers in a forbidden runtime: %j", async (env) => {
    const { worker, deps } = harness({ environment: () => env });
    expect(worker.start()).toBe(false);
    expect(await worker.tick()).toBeNull();
    expect(deps.collectEligiblePairs).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not claim removed or disabled pairs and survives an eligibility read error", async () => {
    const { worker, deps } = harness({
      collectEligiblePairs: vi.fn().mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce([]),
    });
    expect(await worker.tick()).toBeNull();
    expect(deps.warn).toHaveBeenCalledOnce();
    expect(await worker.tick()).toBeNull();
    expect(deps.claimProbe).not.toHaveBeenCalled();
    expect(deps.probe).not.toHaveBeenCalled();
  });
});

describe("configured Combo probe eligibility", () => {
  function eligibilityHarness({ combos, resolved, disabled = {}, connections = [], nodes = [], settings = {} }) {
    return {
      getCombos: async () => combos,
      getSettings: async () => settings,
      getProviderConnections: async () => connections,
      getDisabledModels: async () => disabled,
      getProviderNodes: async () => nodes,
      getComboModels: vi.fn(async (name) => combos.find((combo) => combo.name === name)?.models || null),
      getModelInfo: vi.fn(async (name) => resolved[name] || {}),
    };
  }

  it("claims and recovers a frozen explicit Fusion judge that is absent from every panel", async () => {
    const judge = { provider: "commandcode", model: "z-ai/glm-5.3-flash" };
    const source = eligibilityHarness({
      combos: [{ name: "fusion-main", models: ["panel-one", "panel-two"] }],
      resolved: {
        "panel-one": { provider: "openai", model: "panel-one" },
        "panel-two": { provider: "openai", model: "panel-two" },
        "cmc/z-ai/glm-5.3-flash": judge,
      },
      settings: { comboStrategies: { "fusion-main": { fallbackStrategy: "fusion", judgeModel: " cmc/z-ai/glm-5.3-flash " } } },
    });
    const service = memoryService();
    await service.freezeComboModel({ ...judge, status: 502, reason: "Judge unavailable" });
    await vi.advanceTimersByTimeAsync(100);
    const { worker, deps } = harness({
      collectEligiblePairs: () => collectEligibleComboHealthPairs(source),
      claimProbe: service.claimDueComboProbe,
      finishProbe: service.finishComboProbe,
    });
    expect(await worker.tick()).toMatchObject({ success: true, applied: true });
    expect(deps.probe).toHaveBeenCalledExactlyOnceWith({ ...judge, signal: expect.any(AbortSignal) });
    expect(await service.getComboHealth(judge.provider, judge.model)).toBeNull();
  });

  it("traverses nested judge Combos, aliases, custom prefixes, and implicit Flex using global Fusion defaults", async () => {
    const source = eligibilityHarness({
      combos: [
        { name: "main", models: ["p/one", "p/two"] },
        { name: "judge-combo", models: ["custom/judge", "judge-alias"] },
      ],
      settings: { comboStrategy: "fusion", comboStrategies: {
        main: { judgeModel: "judge-combo" },
        "judge-combo": { judgeModel: "gemini/gemini-3.8-flash(high)" },
      } },
      nodes: [{ id: "node-judge", prefix: "custom" }],
      resolved: {
        "p/one": { provider: "openai", model: "one" },
        "p/two": { provider: "openai", model: "two" },
        "custom/judge": { provider: "custom", model: "judge" },
        "judge-alias": { provider: "node-judge", model: "judge" },
        "gemini/gemini-3.8-flash(high)": { provider: "gemini", model: "gemini-3.8-flash(high)" },
      },
    });
    expect(await collectEligibleComboHealthPairs(source)).toEqual([
      { provider: "openai", model: "one" }, { provider: "openai", model: "two" },
      { provider: "node-judge", model: "judge" },
      { provider: "gemini", model: "gemini-3.8-flash(high)" },
      { provider: "gemini", model: "gemini-3.8-flash:flex(high)" },
    ]);
    expect(source.getComboModels.mock.calls.filter(([name]) => name === "judge-combo")).toHaveLength(1);
  });

  it.each([
    ["fallback override", { comboStrategy: "fusion", comboStrategies: { main: { fallbackStrategy: "fallback", judgeModel: "judge-only" } } }, ["p/one", "p/two"], {}],
    ["unused strategy field", { comboStrategies: { main: { strategy: "fusion", judgeModel: "judge-only" } } }, ["p/one", "p/two"], {}],
    ["single panel member", { comboStrategies: { main: { fallbackStrategy: "fusion", judgeModel: "judge-only" } } }, ["p/one"], {}],
    ["disabled Combo", { comboStrategies: { main: { fallbackStrategy: "fusion", judgeModel: "judge-only" } } }, ["p/one", "p/two"], { enabled: false }],
  ])("does not schedule an unused explicit judge: %s", async (_, settings, models, extra) => {
    const source = eligibilityHarness({
      combos: [{ name: "main", models, ...extra }], settings,
      resolved: {
        "p/one": { provider: "openai", model: "one" },
        "p/two": { provider: "openai", model: "two" },
        "judge-only": pair,
      },
    });
    expect(await collectEligibleComboHealthPairs(source)).not.toContainEqual(pair);
    expect(source.getModelInfo).not.toHaveBeenCalledWith("judge-only");
  });

  it("resolves nested aliases, terminates cycles, excludes media and disabled leaves, and keeps Flex distinct", async () => {
    const deps = eligibilityHarness({
      combos: [
        { name: "main", models: ["nested", "route-alias", "disabled-alias", "off-provider", "g/gemini:flex", "g/gemini"] },
        { name: "nested", models: ["main", "oai/gpt-4o", "empty", "media"] },
        { name: "media", kind: "tts", models: ["tts/speech"] },
        { name: "empty", models: [] },
        { name: "disabled-combo", enabled: false, models: ["disabled-only"] },
      ],
      nodes: [{ id: "node-custom", prefix: "custom" }],
      resolved: {
        "route-alias": { provider: "node-custom", model: "active" },
        "disabled-alias": { provider: "node-custom", model: "disabled" },
        "off-provider": { provider: "clinepass", model: "off" },
        "oai/gpt-4o": { provider: "openai", model: "gpt-4o" },
        "g/gemini:flex": { provider: "gemini", model: "gemini:flex" },
        "g/gemini": { provider: "gemini", model: "gemini" },
      },
      disabled: { custom: ["disabled"], openai: ["gpt-4o"] },
      connections: [
        { provider: "node-custom", isActive: false },
        { provider: "node-custom", isActive: true },
        { provider: "clinepass", isActive: false },
      ],
    });
    expect(await collectEligibleComboHealthPairs(deps)).toEqual([
      { provider: "node-custom", model: "active" },
      { provider: "gemini", model: "gemini:flex" },
      { provider: "gemini", model: "gemini" },
    ]);
    expect(deps.getComboModels).not.toHaveBeenCalledWith("media");
    expect(deps.getModelInfo).not.toHaveBeenCalledWith("tts/speech");
    expect(deps.getModelInfo).not.toHaveBeenCalledWith("disabled-only");
    expect(deps.getComboModels.mock.calls.filter(([name]) => name === "main")).toHaveLength(1);
  });

  it("includes enabled capacity pools with canonical deduplication, but no arbitrary catalog models", async () => {
    const deps = eligibilityHarness({
      combos: [{ name: "main", models: ["alias-one"] }],
      resolved: {
        "alias-one": pair,
        "alias-two": pair,
        "custom/vision": { provider: "node-custom", model: "vision" },
        "disabled/pool": { provider: "node-off", model: "pool" },
      },
      settings: { capacityAdapter: {
        vision: { enabled: true, models: ["alias-two", "custom/vision", "disabled/pool"] },
        pdf: { enabled: false, models: ["never-probe/pdf"] },
      } },
      connections: [{ provider: "node-off", isActive: false }],
    });
    expect(await collectEligibleComboHealthPairs(deps)).toEqual([
      pair, { provider: "node-custom", model: "vision" },
    ]);
    expect(deps.getModelInfo).not.toHaveBeenCalledWith("never-probe/pdf");
  });

  it("does not let a compatible node prefix shadow a built-in provider", async () => {
    const deps = eligibilityHarness({
      combos: [{ name: "main", models: ["openai/model"] }],
      nodes: [{ id: "node-custom", prefix: "openai" }],
      resolved: { "openai/model": { provider: "openai", model: "model" } },
      connections: [{ provider: "node-custom", isActive: false }],
    });
    expect(await collectEligibleComboHealthPairs(deps)).toEqual([{ provider: "openai", model: "model" }]);
  });

  it("recovers body-selected Flex variants of a configured ordinary Gemini model", async () => {
    const deps = eligibilityHarness({
      combos: [{ name: "main", models: ["gemini/model(high)", "gemini/disabled"] }],
      resolved: {
        "gemini/model(high)": { provider: "gemini", model: "model(high)" },
        "gemini/disabled": { provider: "gemini", model: "disabled" },
      },
      disabled: { gemini: ["disabled:flex"] },
    });
    expect(await collectEligibleComboHealthPairs(deps)).toEqual([
      { provider: "gemini", model: "model(high)" },
      { provider: "gemini", model: "model:flex(high)" },
      { provider: "gemini", model: "disabled" },
    ]);
  });
});
