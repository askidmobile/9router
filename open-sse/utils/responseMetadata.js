import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { MODEL_FALLBACK, RESPONSES_ITEM } from "../translator/schema/index.js";
import { RESPONSE_METADATA_HEADERS } from "../config/responseMetadata.js";

const modelId = (value) => typeof value === "string" && value.trim() && value !== MODEL_FALLBACK ? value : null;

function responseEnvelope(payload) {
  // Translators may wrap SSE events as { event, data }. Only visit protocol
  // envelopes, never message content, tool arguments, or arbitrary metadata.
  const data = payload?.event && payload.data ? payload.data : payload;
  return data?.response || (data?.type === "message_start" ? data.message : data);
}

/** Per-attempt identity: observe raw upstream data before lossy translation. */
export function createResponseMetadata({ provider, model, translatedBody, finalBody } = {}) {
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  let actualModel = modelId(finalBody?.model) || modelId(translatedBody?.model)
    || (model ? stripThinkingSuffix(getModelUpstreamId(alias, model)) : null);

  const assignIdentity = (envelope) => {
    envelope.provider = provider;
    envelope.model = actualModel || null;
    return envelope;
  };

  return {
    observe(payload) {
      const envelope = responseEnvelope(payload);
      actualModel = modelId(envelope?.modelVersion) || modelId(envelope?.model) || actualModel;
    },
    apply(payload) {
      if (!provider) return payload;
      const envelope = responseEnvelope(payload);
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.error) return payload;
      const isCompletion = Array.isArray(envelope.choices) || Array.isArray(envelope.candidates)
        || envelope.object === "response" || envelope.object === "response.compaction" || envelope.type === RESPONSES_ITEM.MESSAGE
        || envelope !== payload && (envelope.id || envelope.status);
      if (isCompletion) {
        // This identifies the route selected by 9router, including a custom
        // provider node. An upstream aggregator's private routing is unknown.
        assignIdentity(envelope);
        if (actualModel) {
          envelope.model = actualModel;
          if (Array.isArray(envelope.candidates)) envelope.modelVersion = actualModel;
        }
      }
      return payload;
    },
    applyJson(payload) {
      if (!provider || !payload || typeof payload !== "object" || Array.isArray(payload) || payload.error) return payload;
      return assignIdentity(payload);
    },
    headers(existing) {
      const headers = new Headers(existing);
      const exposed = new Set((headers.get("Access-Control-Expose-Headers") || "").split(",").map(value => value.trim()).filter(Boolean));
      for (const [key, value] of Object.entries({ provider, model: actualModel })) {
        if (!value) continue;
        // Model IDs are normally ASCII. Encode unusual IDs instead of letting
        // non-ByteString characters or control bytes break an otherwise valid response.
        headers.set(RESPONSE_METADATA_HEADERS[key], /^[\x20-\x7e]+$/.test(value) ? value : encodeURIComponent(value));
        exposed.add(RESPONSE_METADATA_HEADERS[key]);
      }
      if (exposed.size) headers.set("Access-Control-Expose-Headers", [...exposed].join(", "));
      return headers;
    },
  };
}

// Native media streams do not pass through the chat translators. Preserve SSE
// event names/comments and only decorate complete JSON data records.
function metadataStream(metadata) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const decorate = (record) => {
    const lines = record.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:"));
    if (!data.length) return record;
    try {
      const payload = JSON.parse(data.map(line => line.slice(5).replace(/^ /, "")).join("\n"));
      metadata.observe(payload);
      let inserted = false;
      return lines.flatMap(line => {
        if (!line.startsWith("data:")) return [line];
        if (inserted) return [];
        inserted = true;
        return [`data: ${JSON.stringify(metadata.applyJson(payload))}`];
      }).join("\n");
    } catch { return record; } // Includes [DONE] and non-JSON provider events.
  };
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        controller.enqueue(encoder.encode(`${decorate(buffer.slice(0, match.index))}\n\n`));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(`${decorate(buffer)}\n\n`));
    },
  });
}

/** Decorate a successful result without decoding binary/plain-text output. */
export async function withResponseMetadata(result, options) {
  if (!result?.success || !result.response?.ok) return result;
  const metadata = options?.applyJson ? options : createResponseMetadata(options);
  const response = result.response;
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  let body = response.body;
  let rewritten = false;
  if (contentType.includes("application/json")) {
    body = await response.text();
    try {
      const payload = JSON.parse(body);
      metadata.observe(payload);
      body = JSON.stringify(metadata.applyJson(payload));
      rewritten = true;
    } catch { /* Preserve unexpected payloads rather than corrupting their format. */ }
  } else if (contentType.includes("text/event-stream") && body) {
    body = body.pipeThrough(metadataStream(metadata));
    rewritten = true;
  }
  const headers = metadata.headers(response.headers);
  if (rewritten) {
    headers.delete("Content-Length");
    headers.delete("Content-Encoding");
    headers.delete("ETag");
  }
  return { ...result, response: new Response(body, { status: response.status, statusText: response.statusText, headers }) };
}
