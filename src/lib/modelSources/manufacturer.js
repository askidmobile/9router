import { makeKv } from "../db/helpers/kvStore.js";
import { parseTokenCount } from "../providerCatalog/metadata.js";

export const OFFICIAL_DOCUMENTS = [
  { url: "https://intl.cloud.tencent.com/zh/document/product/1300/78934", format: "tokenhub" },
  { url: "https://docs.cloudbase.net/en/ai/available-models", format: "cloudbase" },
];
const kv = makeKv("modelSources");
const text = html => html.replace(/<[^>]*>/g, " ").replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&(?:nbsp|#160);/g, " ")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const canonical = id => /^(?:hy\d|hunyuan|hy-)/.test(id) ? `tencent/${id}` : id;

// Read named columns, not fixed cell positions. Unknown/undeclared cells stay absent.
export function parseOfficialDocument(html, format) {
  const models = [];
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => text(cell[1])));
    const headers = rows.shift()?.map(value => value.toLowerCase()) || [];
    const idColumn = format === "tokenhub" ? headers.findIndex(h => h.startsWith("model")) : headers.indexOf("model");
    const contextColumn = headers.findIndex(h => h.includes("上下文") || h === "context" || h.includes("context window"));
    const outputColumn = headers.findIndex(h => h.includes("最大输出") || h.includes("max output"));
    if (idColumn < 0 || contextColumn < 0) continue;
    for (const cells of rows) {
      const id = cells[idColumn];
      if (!id || !/^[a-z0-9][a-z0-9._/:@-]*$/i.test(id)) continue;
      const caps = {};
      const context = parseTokenCount(cells[contextColumn]);
      const output = parseTokenCount(cells[outputColumn]);
      if (context) caps.contextWindow = context;
      if (output) caps.maxOutput = output;
      if (format === "cloudbase") {
        for (const [header, field] of [["image", "vision"], ["video", "videoInput"], ["deep thinking", "reasoning"], ["tool calling", "tools"]]) {
          const value = cells[headers.indexOf(header)];
          if (value === "✅" || value === "❌") caps[field] = value === "✅";
        }
      } else {
        const capabilities = cells[headers.findIndex(h => h.includes("能力") || h.includes("capabilit"))] || "";
        if (/Function Calling/i.test(capabilities)) caps.tools = true;
        if (/深度思考|Deep Reasoning/i.test(capabilities)) caps.reasoning = true;
        if (/图片理解|Image Understanding/i.test(capabilities)) caps.vision = true;
      }
      if (Object.keys(caps).length) models.push({ id: canonical(id), caps });
    }
  }
  if (!models.length) throw new Error(`Official ${format} document has no recognized model table`);
  return models;
}

export async function getManufacturerCatalog({ refresh = false } = {}) {
  const documents = await Promise.all(OFFICIAL_DOCUMENTS.map(async document => {
    const cached = await kv.get(document.url);
    if (!refresh) return cached || { models: [] };
    try {
      const response = await fetch(document.url, { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Official document responded ${response.status}`);
      const models = parseOfficialDocument(await response.text(), document.format);
      const observed = { models, url: document.url, fetchedAt: Date.now() };
      await kv.set(document.url, observed);
      return observed;
    } catch (error) {
      const retained = { ...(cached || { models: [] }), stale: true, warning: `${document.url}: ${error.message}` };
      if (cached) await kv.set(document.url, retained);
      return retained;
    }
  }));
  const models = new Map();
  for (const document of documents) for (const model of document.models) {
    const merged = models.get(model.id) || { id: model.id, caps: {}, sources: {} };
    Object.assign(merged.caps, model.caps);
    for (const field of Object.keys(model.caps)) merged.sources[field] = {
      source: "manufacturer-docs", url: document.url, modelId: model.id,
      updatedAt: new Date(document.fetchedAt).toISOString(), stale: !!document.stale, verified: false,
    };
    models.set(model.id, merged);
  }
  return { models: [...models.values()], warning: documents.map(document => document.warning).filter(Boolean).join("; ") || undefined };
}
