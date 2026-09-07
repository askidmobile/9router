import gemini from "open-sse/providers/registry/gemini.js";
import { GEMINI_MODELS_MAX_PAGES, GEMINI_MODELS_PAGE_SIZE, GEMINI_MODELS_TIMEOUT_MS } from "open-sse/config/gemini.js";
import { normalizeGeminiModelId, withGeminiFlexModels } from "open-sse/utils/geminiModels.js";

export async function resolveGeminiModels(connection) {
  const token = connection.apiKey || connection.accessToken;
  if (!token) return { error: "No valid AI Studio API key found", status: 401 };

  const models = new Map();
  const seenTokens = new Set();
  const signal = AbortSignal.timeout(GEMINI_MODELS_TIMEOUT_MS);
  let pageToken = "";
  try {
    for (let page = 0; page < GEMINI_MODELS_MAX_PAGES; page++) {
      const url = new URL(gemini.transport.baseUrl);
      url.searchParams.set("pageSize", String(GEMINI_MODELS_PAGE_SIZE));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url.toString(), {
        headers: { "x-goog-api-key": token, Accept: "application/json" },
        cache: "no-store", signal,
      });
      if (!response.ok) return { error: `Failed to fetch AI Studio models: ${response.status}`, status: response.status };
      const data = await response.json();
      if (!Array.isArray(data.models)) return { error: "Invalid AI Studio models response", status: 502 };
      for (const model of data.models) {
        const id = normalizeGeminiModelId(model?.name || model?.id);
        if (!id || models.has(id)) continue;
        models.set(id, { ...model, id, name: model.displayName || id });
      }
      pageToken = data.nextPageToken;
      if (!pageToken) return { models: withGeminiFlexModels([...models.values()]) };
      if (typeof pageToken !== "string" || seenTokens.has(pageToken)) break;
      seenTokens.add(pageToken);
    }
    return { error: "AI Studio models pagination did not complete; try again", status: 502 };
  } catch (error) {
    return {
      error: signal.aborted ? "AI Studio models request timed out" : "Failed to fetch AI Studio models",
      status: signal.aborted ? 504 : 502,
    };
  }
}
