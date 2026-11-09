import { QUBAX_MODELS_URL, QUBAX_BALANCE_URL } from "../config/qubax.js";

export function normalizeQubaxModels(payload) {
  const models = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(models)) return [];
  return models.filter(model => {
    if (typeof model?.id !== "string" || !model.id.trim()) return false;
    const input = model.input_modalities ?? model.architecture?.input_modalities;
    const output = model.output_modalities ?? model.architecture?.output_modalities;
    return (!Array.isArray(input) || input.includes("text"))
      && (!Array.isArray(output) || output.includes("text"));
  }).map(model => {
    const summary = model.pricing_summary;
    // The public summary includes current offers; pricing[] can carry a different base rate.
    const pricing = summary ? {
      input_per_million: summary.prompt_per_1m,
      output_per_million: summary.completion_per_1m,
      cache_read_input_per_million: summary.cache_read_per_1m,
      cache_write_input_per_million: summary.cache_write_per_1m,
    } : undefined;
    return {
      ...model,
      id: model.id.trim(),
      type: "text",
      name: model.name || model.id,
      contextLength: model.context_length,
      max_output_tokens: model.max_output_length,
      maxOutputTokens: model.max_output_length,
      reasoning_levels: model.capabilities?.reasoningEffortLevels,
      capabilities: { ...model.capabilities, search: model.capabilities?.webSearch },
      ...(pricing ? { pricing } : {}),
      available: model.is_ready !== false,
    };
  });
}

export async function resolveQubaxModels(connection = {}) {
  const response = await fetch(QUBAX_MODELS_URL, {
    headers: { Accept: "application/json", ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Qubax AI catalog responded ${response.status}`);
  return { models: normalizeQubaxModels(await response.json()) };
}

// /models is public; the authenticated balance endpoint verifies keys without inference.
export async function probeQubaxApiKey(apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(QUBAX_BALANCE_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  return {
    valid: response.ok,
    error: response.ok ? null : response.status === 401 || response.status === 403
      ? "Invalid or inactive API key"
      : `Unable to verify API key (Qubax AI returned ${response.status})`,
  };
}
