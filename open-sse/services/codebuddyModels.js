// CodeBuddy catalog. The gateway publishes no listing endpoint (/v2/models and
// every plausible variant answer 404 on codebuddy.ai and workbuddy.ai), but the
// CodeBuddy Code CLI ships its whole catalog as product.json on npm — with
// limits, modality flags and the per-model effort sets. The file is public: a
// plain GET needs no key, and none is ever sent to the CDN.

export const CODEBUDDY_PRODUCT_URL = "https://unpkg.com/@tencent-ai/codebuddy-code@latest/product.json";

// «default-model» / «fast-model» / … are the CLI's routing aliases, not upstream
// models: they carry no vendor of their own and the gateway answers 11102 for them.
const ROUTE_ALIAS = /-model$/;

const positiveInt = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * Map one product.json row into the generic catalog entry shape
 * (src/lib/providerCatalog/metadata.js:catalogMetadata reads these fields).
 * Returns null for rows that are not selectable chat models.
 */
export function normalizeCodeBuddyModel(row) {
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  if (!id || ROUTE_ALIAS.test(id)) return null;

  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
  const context = positiveInt(row.maxInputTokens) ?? positiveInt(row.contextWindow);
  const output = positiveInt(row.maxOutputTokens);
  const reasoning = row.supportsReasoning === true || row.onlyReasoning === true
    || (row.reasoning !== null && row.reasoning !== undefined);
  const canDisable = typeof row.canDisableThinking === "boolean" ? row.canDisableThinking
    : typeof row.reasoning?.canDisableThinking === "boolean" ? row.reasoning.canDisableThinking
    : row.onlyReasoning !== true;

  // «none» is 9router's picker spelling for «thinking off»; the CLI omits it
  // from supportedEfforts and toggles thinking separately.
  const efforts = Array.isArray(row.reasoning?.supportedEfforts)
    ? row.reasoning.supportedEfforts.filter((level) => typeof level === "string")
    : null;

  return {
    id,
    name,
    type: "text",
    ...(context ? { context_length: context, contextLength: context } : {}),
    ...(output ? { max_output_tokens: output } : {}),
    isVL: row.supportsImages === true && row.disabledMultimodal !== true,
    isReasoning: reasoning,
    capabilities: {
      vision: row.supportsImages === true && row.disabledMultimodal !== true,
      tools: row.supportsToolCall === true,
      ...(reasoning ? { reasoning: true } : {}),
    },
    ...(reasoning ? { reasoning: { mandatory: !canDisable } } : {}),
    ...(efforts?.length ? { reasoning_levels: [...new Set([...(canDisable ? ["none"] : []), ...efforts])] } : {}),
    thinking_format: "openai",
  };
}

/**
 * Fetch product.json and normalize it. Never throws for a missing catalog: the
 * caller falls back to the static registry list.
 */
export async function resolveCodeBuddyModels() {
  const response = await fetch(CODEBUDDY_PRODUCT_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`CodeBuddy product.json responded ${response.status}`);
  const data = await response.json();
  const models = (Array.isArray(data?.models) ? data.models : [])
    .map(normalizeCodeBuddyModel)
    .filter(Boolean);
  return { models };
}
