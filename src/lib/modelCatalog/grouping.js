// Grouping key for the model comparison view.
//
// The dashboard groups by what the user reads, not by the id the provider
// happens to route: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
// "deepseek-v4.1-flash-1017" and "deepseek-v4.1-flash-1017" are one model with
// one display name ("DeepSeek V4.1 Flash 1017") and belong together.
//
// Grouping by id tail was tried and rejected: it bridges unrelated families
// through a single mislabelled provider (sensenova publishes `deepseek-flash`
// under the name "DeepSeek V4.1 Flash"), which merges a lite model into the
// price comparison of a flagship one. A missed merge is a smaller problem than
// a wrong one.
//
// Only pure distribution markers are stripped from the display name. Anything
// that names a different product — "(Fast)", "(Thinking)", "(VIP)" — is kept,
// because those are separately priced models.

// Suffixes that say how a model is delivered, not which model it is.
const CHANNEL_QUALIFIERS = new Set([
  "free",
  "free tier",
  "via respan",
  "azure via respan",
  "cloud",
  "on demand",
]);

/**
 * Lowercase, drop separators: "DeepSeek-V4.1 Flash" → "deepseekv41flash".
 *
 * A trailing "+" is preserved: "Command R" and "Command R+" are different
 * models, and folding the plus merged them into one price comparison.
 */
export function normalizeDisplayName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, "");
}

function stripChannelQualifiers(value) {
  let text = String(value || "").trim();
  // Repeat: "(Free) (via Respan)" must lose both markers.
  for (let guard = 0; guard < 4; guard += 1) {
    const match = text.match(/\s*\(([^()]*)\)\s*$/);
    if (!match) break;
    if (!CHANNEL_QUALIFIERS.has(match[1].trim().toLowerCase())) break;
    text = text.slice(0, match.index).trim();
  }
  return text;
}

/** Trailing segment of a routed id: "vendor/Model-1" → "Model-1". */
export function idTail(id) {
  const parts = String(id || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(id || "");
}

/**
 * Stable key for one model family.
 *
 * The display name wins; the id tail is only a fallback when a model has no
 * name at all. Both sides go through the same normalization so
 * "DeepSeek-V4.1-Flash" and "DeepSeek V4.1 Flash" land together.
 */
export function modelGroupKey(row) {
  const fromName = normalizeDisplayName(stripChannelQualifiers(row?.name));
  if (fromName.length >= 3) return fromName;
  const fromId = normalizeDisplayName(idTail(row?.id));
  if (fromId.length >= 3) return fromId;
  return normalizeDisplayName(row?.id) || String(row?.key || "");
}

/**
 * Human label for a group: the name most providers agree on, preferring a
 * shorter, unqualified spelling. Falls back to the representative id.
 */
export function groupLabel(rows) {
  const counts = new Map();
  for (const row of rows) {
    const label = stripChannelQualifiers(row.name) || row.name || row.id;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  let best = null;
  for (const [label, count] of counts) {
    if (
      best === null
      || count > best.count
      // Tie: prefer the spelling without channel markers and with spaces.
      || (count === best.count && label.length < best.label.length)
    ) {
      best = { label, count };
    }
  }
  return best?.label || rows[0]?.id || "";
}

export const __test__ = { stripChannelQualifiers };