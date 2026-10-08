import { metadataStream } from "./responseMetadata.js";
import { RESPONSE_METADATA_HEADERS } from "../config/responseMetadata.js";

/** Fusion costs include every observed panel call and the final judge call. */
export async function withComboCost(response, panel) {
  if (!response.ok || !panel.length) return response;
  const decorate = payload => {
    const envelope = payload?.response || (payload?.type === "message_start" ? payload.message : payload);
    const usage = envelope?.usage || envelope?.usageMetadata;
    if (!usage) return payload;
    const final = { role: "final", provider: envelope.provider || null, model: envelope.model || null,
      cost: usage.cost ?? null, estimated: usage.cost_details?.estimated ?? true };
    const requests = [...panel, final];
    const known = requests.filter(r => Number.isFinite(r.cost) && r.cost >= 0);
    const sum = known.reduce((total, r) => total + r.cost, 0);
    usage.cost = known.length === requests.length ? sum : null;
    usage.cost_details = { currency: "USD", source: "combo", scope: "completed_calls",
      estimated: requests.some(r => r.estimated), known_cost: sum, requests };
    return payload;
  };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const contentType = headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const payload = decorate(await response.json());
    const usage = payload?.usage || payload?.response?.usage || payload?.usageMetadata;
    if (typeof usage?.cost === "number") headers.set(RESPONSE_METADATA_HEADERS.cost, String(usage.cost));
    else headers.delete(RESPONSE_METADATA_HEADERS.cost);
    return new Response(JSON.stringify(payload), { status: response.status, headers });
  }
  if (contentType.includes("text/event-stream")) {
    headers.delete(RESPONSE_METADATA_HEADERS.cost);
    return new Response(response.body.pipeThrough(metadataStream({ observe() {}, applyJson: decorate })), { status: response.status, headers });
  }
  return response;
}
