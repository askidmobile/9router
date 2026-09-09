// Recovery is independent of user requests: only an isolated synthetic inference
// may reopen a frozen provider/model pair. State lives on globalThis because Next
// can load instrumentation and route handlers through different module copies.
import { COMBO_HEALTH_CONFIG, getComboProbeTimeoutMs } from "open-sse/config/comboHealth.js";
import { getCapacityAdapterModels } from "open-sse/services/capacityAdapter.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { splitGeminiModelId } from "open-sse/utils/geminiModels.js";
import { GEMINI_FLEX_SUFFIX } from "open-sse/config/gemini.js";
import * as log from "../utils/logger.js";

const WORKER_KEY = Symbol.for("9router.backgroundComboHealth.v1");
const BUILT_IN_PROVIDERS = new Set(REGISTRY.map((entry) => entry.id));

function freshState() {
  return { started: false, interval: null, tickPromise: null, controller: null, generation: 0 };
}

function runtimeAllowed(env) {
  return typeof window === "undefined"
    && env.NEXT_RUNTIME !== "edge"
    && !["phase-production-build", "phase-export", "phase-static"].includes(env.NEXT_PHASE)
    && !["1", "true", "yes", "on"].includes(String(env.DISABLE_BACKGROUND_COMBO_HEALTH || "").toLowerCase());
}

async function eligibilityDependencies() {
  const [db, models, disabled] = await Promise.all([
    import("@/lib/localDb"),
    import("./model.js"),
    import("@/lib/disabledModelsDb"),
  ]);
  return { ...db, ...models, ...disabled };
}

/** Resolve only enabled leaves of configured chat Combos and adapter pools. */
export async function collectEligibleComboHealthPairs(deps) {
  const source = deps || await eligibilityDependencies();
  const [combos, settings, connections, disabled, nodes] = await Promise.all([
    source.getCombos(), source.getSettings(), source.getProviderConnections(),
    source.getDisabledModels(), source.getProviderNodes(),
  ]);
  const providerByPrefix = new Map((nodes || []).filter((n) => n.prefix).map((n) => [n.prefix, n.id]));
  const canonicalProvider = (id) => {
    const builtIn = resolveProviderAlias(id);
    return BUILT_IN_PROVIDERS.has(builtIn) ? builtIn : (providerByPrefix.get(id) || builtIn);
  };
  const configured = new Set();
  const active = new Set();
  for (const connection of connections || []) {
    const provider = canonicalProvider(connection.provider);
    configured.add(provider);
    if (connection.isActive !== false) active.add(provider);
  }
  const disabledByProvider = new Map();
  for (const [provider, models] of Object.entries(disabled || {})) {
    if (!Array.isArray(models)) continue;
    const id = canonicalProvider(provider);
    if (!disabledByProvider.has(id)) disabledByProvider.set(id, new Set());
    for (const model of models) disabledByProvider.get(id).add(model);
  }

  const byName = new Map((combos || []).map((combo) => [combo.name, combo]));
  const visited = new Set();
  const pairs = new Map();
  const visit = async (member) => {
    if (typeof member !== "string" || !member || visited.has(member)) return;
    visited.add(member);
    const combo = byName.get(member);
    if (combo) {
      if (combo.kind && combo.kind !== "llm") return;
      if (combo.isActive === false || combo.enabled === false) return;
      // Apply the same filtering used by incoming Combo requests, including
      // compatible provider prefixes. The visited set also terminates cycles.
      const children = await source.getComboModels(member);
      for (const child of children || []) await visit(child);
      // Match handleChat/handleSingleModelChat and handleFusionChat: an explicit
      // judge is used only for Fusion with at least two enabled panel members.
      const strategy = settings?.comboStrategies?.[member];
      const effectiveStrategy = strategy?.fallbackStrategy || settings?.comboStrategy || "fallback";
      const judge = typeof strategy?.judgeModel === "string" ? strategy.judgeModel.trim() : "";
      if (effectiveStrategy === "fusion" && (children || []).filter(Boolean).length > 1 && judge) {
        await visit(judge);
      }
      return;
    }
    const info = await source.getModelInfo(member);
    if (!info?.provider || !info?.model) return;
    const provider = canonicalProvider(info.provider);
    if (configured.has(provider) && !active.has(provider)) return;
    // Model aliases do not contain '/', so getComboModels alone cannot filter
    // their disabled target. Check again after resolving the canonical pair.
    if (disabledByProvider.get(provider)?.has(info.model)) return;
    const pair = { provider, model: info.model };
    pairs.set(JSON.stringify([pair.provider, pair.model]), pair);
    // A client can select Flex in the request body while the saved Combo uses
    // the ordinary model ID. Its circuit is tier-specific and still needs recovery.
    if (provider === "gemini") {
      const variant = splitGeminiModelId(info.model);
      if (!variant.serviceTier) {
        const flexModel = variant.baseModelId + GEMINI_FLEX_SUFFIX + variant.modelId.slice(variant.baseModelId.length);
        if (!disabledByProvider.get(provider)?.has(flexModel)) {
          pairs.set(JSON.stringify([provider, flexModel]), { provider, model: flexModel });
        }
      }
    }
  };
  for (const combo of combos || []) await visit(combo.name);
  for (const member of getCapacityAdapterModels(settings)) await visit(member);
  return [...pairs.values()];
}

async function claimDefault(options) {
  const { claimDueComboProbe } = await import("open-sse/services/comboHealth.js");
  return claimDueComboProbe(options);
}

async function finishDefault(result) {
  const { finishComboProbe } = await import("open-sse/services/comboHealth.js");
  return finishComboProbe(result);
}

async function probeDefault(options) {
  const { runComboModelProbe } = await import("../handlers/chat.js");
  return runComboModelProbe(options);
}

/** Injectable scheduler; sharing state also shares its single-flight lock. */
export function createBackgroundComboHealthWorker(deps = {}, state = freshState()) {
  const timers = deps.timers || globalThis;
  const environment = deps.environment || (() => process.env);
  const config = { ...COMBO_HEALTH_CONFIG, ...deps.config };
  const warn = deps.warn || ((message) => log.warn("COMBO_HEALTH", message));

  const tick = () => {
    if (!runtimeAllowed(environment())) return Promise.resolve(null);
    if (state.tickPromise) return state.tickPromise;
    const generation = state.generation;
    const controller = new AbortController();
    state.controller = controller;
    const operation = (async () => {
      let claim = null;
      let timeout = null;
      let detachAbort = null;
      try {
        const eligiblePairs = await (deps.collectEligiblePairs || collectEligibleComboHealthPairs)();
        if (controller.signal.aborted || generation !== state.generation || !eligiblePairs.length) return null;
        claim = await (deps.claimProbe || claimDefault)({ eligiblePairs });
        if (!claim) return null;
        let outcome;
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          const aborted = new Promise((_, reject) => {
            const onAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", onAbort, { once: true });
            detachAbort = () => controller.signal.removeEventListener("abort", onAbort);
          });
          timeout = timers.setTimeout(() => controller.abort(
            new DOMException("Combo recovery probe timed out", "TimeoutError")
          ), getComboProbeTimeoutMs(claim.provider, claim.model, config));
          timeout?.unref?.();
          const result = await Promise.race([
            Promise.resolve().then(() => (deps.probe || probeDefault)({
              provider: claim.provider, model: claim.model, signal: controller.signal,
            })),
            aborted,
          ]);
          const success = result?.ok === true && result.status >= 200 && result.status < 300;
          outcome = {
            success,
            status: result?.status || (success ? 200 : 502),
            reason: result?.reason || (success ? "" : "Probe did not return a valid generated answer"),
            retryAfterMs: result?.retryAfterMs,
          };
        } catch (error) {
          const timedOut = controller.signal.reason?.name === "TimeoutError";
          outcome = {
            success: false,
            status: timedOut ? 504 : 502,
            reason: timedOut ? "Combo recovery probe timed out" : (error?.message || "Combo recovery probe failed"),
          };
        }
        const cancelled = generation !== state.generation;
        const applied = await (deps.finishProbe || finishDefault)({
          provider: claim.provider, model: claim.model, probeToken: claim.probeToken,
          ...outcome, success: cancelled ? false : outcome.success, cancelled,
        });
        return { ...outcome, cancelled, applied };
      } catch {
        // The persistent lease makes a failed DB finalization recoverable. Do
        // not expose credentials or arbitrary upstream payloads in this log.
        warn("Background recovery tick failed; frozen models remain protected");
        return null;
      } finally {
        if (timeout !== null) timers.clearTimeout(timeout);
        detachAbort?.();
        if (state.controller === controller) state.controller = null;
      }
    })();
    state.tickPromise = operation;
    operation.finally(() => {
      if (state.tickPromise === operation) state.tickPromise = null;
    }).catch(() => {});
    return operation;
  };

  const start = () => {
    if (state.started || !runtimeAllowed(environment())) return false;
    state.started = true;
    state.interval = timers.setInterval(() => { void tick(); }, config.probeIntervalMs);
    state.interval?.unref?.();
    if (deps.shutdownTarget) {
      const onShutdown = () => { void stop(); };
      deps.shutdownTarget.once("SIGINT", onShutdown);
      deps.shutdownTarget.once("SIGTERM", onShutdown);
      state.detachShutdown = () => {
        deps.shutdownTarget.removeListener("SIGINT", onShutdown);
        deps.shutdownTarget.removeListener("SIGTERM", onShutdown);
      };
    }
    return true;
  };

  const stop = () => {
    state.started = false;
    state.generation += 1;
    if (state.interval !== null) timers.clearInterval(state.interval);
    state.interval = null;
    state.detachShutdown?.();
    state.detachShutdown = null;
    state.controller?.abort(new DOMException("Combo recovery worker stopped", "AbortError"));
    return state.tickPromise || Promise.resolve();
  };

  return { start, stop, tick };
}

const sharedState = globalThis[WORKER_KEY] || (globalThis[WORKER_KEY] = freshState());
const singleton = createBackgroundComboHealthWorker({ shutdownTarget: process }, sharedState);

export const startBackgroundComboHealth = singleton.start;
export const stopBackgroundComboHealth = singleton.stop;
export const runBackgroundComboHealthTick = singleton.tick;
