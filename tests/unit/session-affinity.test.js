import { describe, it, expect, beforeEach } from "vitest";

import {
  deriveSessionAffinityKey,
  getSessionAffinity,
  setSessionAffinity,
  clearSessionAffinity,
} from "../../src/sse/services/sessionAffinity.js";
import {
  connectionMaxConcurrent,
  tryAcquireConnectionSlot,
  releaseConnectionSlot,
  getInflightCount,
  _resetConcurrency,
  withSlotRelease,
} from "../../src/sse/services/connectionConcurrency.js";

describe("session affinity derivation", () => {
  beforeEach(() => clearSessionAffinity());

  it("returns the same key for every turn of one conversation", () => {
    const turn1 = { model: "ollama/llama3", messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi, tell me about rust" },
    ] };
    const turn2 = { model: "ollama/llama3", messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi, tell me about rust" },
      { role: "assistant", content: "Rust is a systems programming language." },
      { role: "user", content: "Is it memory safe?" },
    ] };
    expect(deriveSessionAffinityKey(turn1, "ollama/llama3"))
      .toBe(deriveSessionAffinityKey(turn2, "ollama/llama3"));
  });

  it("returns a different key for a different first user prompt", () => {
    const a = { model: "m", messages: [{ role: "user", content: "first conversation topic" }] };
    const b = { model: "m", messages: [{ role: "user", content: "second conversation topic" }] };
    expect(deriveSessionAffinityKey(a, "m")).not.toBe(deriveSessionAffinityKey(b, "m"));
  });

  it("isolates by model", () => {
    const a = { model: "a", messages: [{ role: "user", content: "same prompt" }] };
    const b = { model: "b", messages: [{ role: "user", content: "same prompt" }] };
    expect(deriveSessionAffinityKey(a, "a")).not.toBe(deriveSessionAffinityKey(b, "b"));
  });

  it("returns null for an empty body", () => {
    expect(deriveSessionAffinityKey({}, "m")).toBeNull();
  });
});

describe("session affinity store", () => {
  beforeEach(() => clearSessionAffinity());

  it("pins, reads and clears", () => {
    setSessionAffinity("key1", "conn-1");
    expect(getSessionAffinity("key1")).toBe("conn-1");
    clearSessionAffinity("key1");
    expect(getSessionAffinity("key1")).toBeNull();
  });
});

describe("per-account concurrent slots", () => {
  beforeEach(() => _resetConcurrency());

  it("default cap is 2", () => {
    expect(connectionMaxConcurrent({})).toBe(2);
  });

  it("respects explicit per-account override", () => {
    expect(connectionMaxConcurrent({ maxConcurrentRequests: 5 })).toBe(5);
  });

  it("acquires up to the cap, refuses beyond, releases cleanly", () => {
    const conn = "conn-a";
    expect(tryAcquireConnectionSlot(conn, 2)).toBe(true);
    expect(getInflightCount(conn)).toBe(1);
    expect(tryAcquireConnectionSlot(conn, 2)).toBe(true);
    expect(tryAcquireConnectionSlot(conn, 2)).toBe(false); // at cap
    releaseConnectionSlot(conn);
    releaseConnectionSlot(conn);
    expect(getInflightCount(conn)).toBe(0);
    expect(tryAcquireConnectionSlot(conn, 2)).toBe(true);
  });
});


describe("slot ownership across response termination", () => {
  beforeEach(() => _resetConcurrency());

  it.each(["error", "cancel", "abort"])("releases exactly once on %s", async mode => {
    let upstream;
    const abort = new AbortController();
    const response = new Response(new ReadableStream({ start(out) { upstream = out; } }));
    expect(tryAcquireConnectionSlot("stream", 2)).toBe(true);
    const wrapped = withSlotRelease(response, "stream", abort.signal);
    if (mode === "error") {
      const read = wrapped.text();
      upstream.error(new Error("upstream disconnected"));
      await expect(read).rejects.toThrow("upstream disconnected");
    } else if (mode === "cancel") {
      await wrapped.body.cancel();
    } else {
      abort.abort();
      await wrapped.body.cancel();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getInflightCount("stream")).toBe(0);
    expect(tryAcquireConnectionSlot("stream", 2)).toBe(true);
    abort.abort();
    expect(getInflightCount("stream")).toBe(1);
  });

  it("evicts affinity records when the store reaches its cap", () => {
    clearSessionAffinity();
    for (let i = 0; i < 5001; i++) setSessionAffinity(String(i), "account");
    expect(getSessionAffinity("0")).toBeNull();
    expect(getSessionAffinity("5000")).toBe("account");
  });
});
