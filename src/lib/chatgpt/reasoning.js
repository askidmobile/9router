import { getThinkingLevels, REASONING_EFFORT_LEVELS } from "open-sse/providers/thinkingLevels.js";
import { getProviderAlias } from "@/shared/constants/providers";
import { getModelInfoCore } from "open-sse/services/model.js";
import { parseSuffix } from "open-sse/translator/concerns/thinkingUnified.js";

const CODEX_LEVELS = REASONING_EFFORT_LEVELS;
const memberId = member => typeof member === "string" ? member : member?.id || member?.model;

// A Combo can fall back to any member. Expose only levels that every member
// accepts, including nested Combos; a fixed suffix cannot be overridden by Codex.
export async function withChatGPTReasoning(models, combos = [], aliases = {}, available = []) {
  const byName = new Map(combos.map(combo => [combo.name, combo]));
  const byModel = new Map(available.map(model => [model.id, model.capabilities]));
  async function resolve(id, seen = new Set()) {
    if (typeof id !== "string" || !id || seen.has(id)) return [];
    const { cleanModel, override } = parseSuffix(id);
    if (override) return [];
    const combo = !cleanModel.includes("/") && byName.get(cleanModel);
    if (combo) {
      if (!Array.isArray(combo.models) || !combo.models.length) return [];
      const next = new Set([...seen, id]);
      const members = await Promise.all(combo.models.map(member => resolve(memberId(member), next)));
      return CODEX_LEVELS.filter(level => members.every(levels => levels.includes(level)));
    }
    const target = await getModelInfoCore(cleanModel, aliases);
    if (!target?.provider || !target.model || parseSuffix(target.model).override) return [];
    const providerAlias = getProviderAlias(target.provider) || target.provider;
    const caps = byModel.get(`${providerAlias}/${target.model}`)
      || byModel.get(`${target.provider}/${target.model}`) || byModel.get(cleanModel);
    const levels = getThinkingLevels(target.provider, target.model, caps) || [];
    // Codex has no "thinking" enum: high denotes enabled for on/off providers.
    return CODEX_LEVELS.filter(level => levels.includes(level) || (level === "high" && levels.includes("thinking")));
  }
  return Promise.all(models.map(async model => {
    const reasoningLevels = await resolve(model.id);
    const defaultReasoningLevel = ["medium", "high", "low"].find(level => reasoningLevels.includes(level)) || reasoningLevels[0] || null;
    return { ...model, reasoningLevels, defaultReasoningLevel };
  }));
}
