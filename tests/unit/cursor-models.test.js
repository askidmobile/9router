import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetchCursorCatalog talks raw HTTP/2 (agent.api5.cursor.sh is h2-only), so the
// network seam is the http2 module, not global.fetch. Emulate a unary
// Connect call: connect() → request() → response/data/end events.
let h2Response;

vi.mock("http2", () => ({
  default: {
    connect: vi.fn(() => {
      const reqListeners = {};
      const req = {
        on: (ev, fn) => { reqListeners[ev] = fn; },
        end: () => {
          queueMicrotask(() => {
            reqListeners.response?.({ ":status": h2Response.status });
            for (const chunk of h2Response.chunks) reqListeners.data?.(chunk);
            reqListeners.end?.();
          });
        },
      };
      return {
        on: () => {},
        close: () => {},
        request: vi.fn(() => req),
      };
    }),
  },
}));

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2Response = { status: 200, chunks: [] };
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    h2Response = {
      status: 200,
      chunks: [Buffer.from(concat(model("claude-4.6-opus", "Claude 4.6 Opus")))],
    };
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2Response = { status: 403, chunks: [Buffer.from("no")] };

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
