import crypto from "crypto";

// Conversation-prefix affinity: route all turns of one conversation to the
// same account so the upstream prompt cache (OpenAI / Anthropic / Ollama /
// Google) stays warm across turns. Pinning is only effective while the
// pinned account still holds a free concurrent-request slot; a saturated
// pinned account spills to the next candidate instead of queueing on the
// provider's side (cache-killer and slow).
// In-memory, TTL-based, single-node.

const TTL_MS = Number(process.env.SESSION_AFFINITY_TTL_MS) || 30 * 60 * 1000; // 30 min
const MAX_ENTRIES = 5000;

const store = new Map(); // key -> { connectionId, lastUsedAt }

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(v => (typeof v === "string" ? v : v?.text ?? ""))
      .join("\n");
  }
  return "";
}

function firstUserText(body) {
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (m?.role === "user") {
        const t = textOf(m.content);
        if (t) return t;
      }
    }
  } else if (Array.isArray(body?.input)) {
    for (const it of body.input) {
      if ((it?.role ?? it?.type) === "user" || it?.type === "message") {
        const t = textOf(it.content);
        if (t) return t;
      }
    }
  } else if (Array.isArray(body?.contents)) {
    for (const c of body.contents) {
      if (c?.role === "user") {
        const t = textOf(c.parts);
        if (t) return t;
      }
    }
  }
  return "";
}

function systemText(body) {
  if (typeof body?.system === "string") return body.system;
  if (Array.isArray(body?.system)) {
    return textOf(body.system);
  }
  if (Array.isArray(body?.messages)) {
    const m = body.messages.find(m => m?.role === "system");
    if (m) return textOf(m.content);
  }
  return typeof body?.instructions === "string" ? body.instructions : "";
}

/**
 * Derive a stable conversation-affinity key from the provider-independent
 * prefix of the request (system prompt + first user turn + model). The key
 * is constant across all turns of one conversation and different for a new
 * conversation.
 * @param {object} body - Parsed request body (OpenAI/Claude/Gemini/responses)
 * @param {string} model - Requested model
 * @returns {string|null} 16-hex affinity key, or null when there's nothing to hash
 */
export function deriveSessionAffinityKey(body, model) {
  if (!body || typeof body !== "object") return null;
  const sys = systemText(body).slice(0, 4000);
  const usr = firstUserText(body).slice(0, 4000);
  if (!sys && !usr) return null;
  return crypto
    .createHash("sha256")
    .update(`${model || ""}\x00${sys}\x00${usr}`)
    .digest("hex")
    .slice(0, 16);
}

export function getSessionAffinity(key) {
  if (!key) return null;
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.lastUsedAt > TTL_MS) {
    store.delete(key);
    return null;
  }
  entry.lastUsedAt = Date.now();
  return entry.connectionId;
}

export function setSessionAffinity(key, connectionId) {
  if (!key || !connectionId) return;
  if (!store.has(key) && store.size >= MAX_ENTRIES) {
    let oldestKey;
    let oldestTime = Infinity;
    for (const [entryKey, entry] of store) {
      if (entry.lastUsedAt < oldestTime) {
        oldestKey = entryKey;
        oldestTime = entry.lastUsedAt;
      }
    }
    store.delete(oldestKey);
  }
  store.set(key, { connectionId, lastUsedAt: Date.now() });
}

export function clearSessionAffinity(key) {
  if (key) store.delete(key);
  else store.clear();
}

export function getSessionAffinitySize() {
  return store.size;
}

// Test hooks.
export function _sessionAffinityStore() {
  return store;
}
