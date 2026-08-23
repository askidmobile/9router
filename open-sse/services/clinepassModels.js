import { buildClineHeaders } from "../shared/clineAuth.js";

// Cline moved catalog discovery to the public recommended-models endpoint —
// the legacy /api/v1/models answers 404. The payload carries three buckets:
// `clinePass` (subscription), `recommended`, and `free`. The endpoint is
// public, so discovery does not require credentials.
const CLINE_RECOMMENDED_MODELS_ENDPOINT = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const CLINE_PASS_ID_PREFIX = "cline-pass/";
const FETCH_TIMEOUT_MS = 5000;

/**
 * Build request headers for Cline API endpoints.
 * - API keys are sent as plain Bearer tokens.
 * - OAuth access tokens must carry the WorkOS `workos:` prefix (handled by buildClineHeaders).
 */
function buildModelListHeaders(token, isApiKey) {
  if (!token) return { Accept: "application/json" };
  if (isApiKey) {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
  }
  return buildClineHeaders(token, { Accept: "application/json" });
}

function normalizeBucket(value) {
  if (!Array.isArray(value)) return [];
  const models = [];
  for (const m of value) {
    if (typeof m?.id !== "string" || !m.id.trim()) continue;
    models.push({ id: m.id.trim(), name: m.name || m.id });
  }
  return models;
}

/**
 * Fetch the public recommended-models endpoint and pick a bucket.
 * @param {(buckets: { clinePass: unknown[], recommended: unknown[], free: unknown[] }) => { id: string, name: string }[]} pick
 * @param {object} [credentials] - optional; auth headers are attached when present
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
async function fetchClineCatalog(pick, credentials = null) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(CLINE_RECOMMENDED_MODELS_ENDPOINT, {
      method: "GET",
      headers: buildModelListHeaders(token, isApiKey),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = await response.json();
    const buckets = {
      clinePass: normalizeBucket(json?.clinePass),
      recommended: normalizeBucket(json?.recommended),
      free: normalizeBucket(json?.free),
    };

    const models = pick(buckets);
    return models.length ? { models } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ClinePass live catalog — the subscription bucket (`cline-pass/*` ids).
 *
 * @param {object} [credentials] - optional; attached when present
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClinepassModels(credentials) {
  return fetchClineCatalog((b) => b.clinePass.filter((m) => m.id.startsWith(CLINE_PASS_ID_PREFIX)), credentials);
}

/**
 * Cline (regular OAuth/API-key) live catalog — recommended + free buckets,
 * excluding `cline-pass/*` ids which are billable only for ClinePass.
 *
 * @param {object} [credentials] - optional; attached when present
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClineModels(credentials) {
  return fetchClineCatalog((b) => {
    const seen = new Set();
    const models = [];
    for (const m of [...b.recommended, ...b.free]) {
      if (seen.has(m.id) || m.id.startsWith(CLINE_PASS_ID_PREFIX)) continue;
      seen.add(m.id);
      models.push(m);
    }
    return models;
  }, credentials);
}
