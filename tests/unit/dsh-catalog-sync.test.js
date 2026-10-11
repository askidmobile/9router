import { describe, it, expect } from "vitest";
import { syncDshProfile, connectionFromProfile } from "../../public/9router-dsh.mjs";

const profile = `plugins:
  - name: llm
    config:
      providers:
        nine-router:
          apiKey: "fixture"
          baseURL: "https://router.test/v1"
          models:
            - id: apinex/free/muse-spark-1.3
              name: Keep this name
              contextWindow: 1048576
              maxTokens: 64000
              input:
                - text
                - image
              reasoningEfforts:
                high: high
                max: max
          compat:
            supportsTools: true
        other:
          models:
            - id: other-model
              contextWindow: 100
`;
const sources = Object.fromEntries(["contextWindow", "maxOutput", "reasoningLevels"].map(k => [k, {source:"provider",updatedAt:"2026-10-11T00:00:00Z"}]));
const model = {id:"apinex/free/muse-spark-1.3",context_length:1000000,max_output_tokens:131072,reasoning_levels:["none","low","high"],capability_sources:sources};

describe("DSH model catalog synchronization", () => {
  it("updates CTX, OUT and effort wire choices while preserving unrelated configuration", () => {
    const out = syncDshProfile(profile,[model]);
    expect(out.text).toContain("contextWindow: 1000000");
    expect(out.text).toContain("maxTokens: 131072");
    expect(out.text).toContain('off: "none"');
    expect(out.text).toContain('low: "low"');
    expect(out.text).not.toContain("max: max");
    expect(out.text).toContain("name: Keep this name");
    expect(out.text).toContain("                - image");
    expect(out.text).toContain("          compat:\n            supportsTools: true");
    expect(out.text).toContain("              contextWindow: 100");
    expect(out.changes).toHaveLength(3);
  });
  it("does not mistake a YAML map reorder for a local pin", () => {
    const first = syncDshProfile(profile,[model]);
    const reordered = first.text.replace('off: "none"\n                low: "low"\n                high: "high"', 'high: "high"\n                low: "low"\n                off: "none"');
    const next = syncDshProfile(reordered,[{...model,reasoning_levels:["none","medium","high"]}],first.state);
    expect(next.text).toContain('medium: "medium"');
    expect(next.text).not.toContain('low: "low"');
  });
  it("does not replace local pins made after a previous synchronization", () => {
    const first = syncDshProfile(profile,[model]);
    const edited = first.text.replace("contextWindow: 1000000","contextWindow: 900000");
    const next = syncDshProfile(edited,[{...model,context_length:1200000,max_output_tokens:64000}],first.state);
    expect(next.text).toContain("contextWindow: 900000");
    expect(next.text).toContain("maxTokens: 64000");
  });
  it("refreshes a Combo using the router's derived limit", () => {
    const out = syncDshProfile(profile,[{...model,capability_sources:{...sources,contextWindow:{source:"combo",verified:false}}}]);
    expect(out.text).toContain("contextWindow: 1000000");
  });
  it("does not turn unknown registry estimates into confirmed client settings", () => {
    const out = syncDshProfile(profile,[{...model,capability_sources:{}}]);
    expect(out.text).toBe(profile);
    expect(out.changes).toEqual([]);
  });
  it("is idempotent and disables reasoning when the provider explicitly offers none", () => {
    const first = syncDshProfile(profile,[{...model,reasoning_levels:[]}]);
    expect(first.text).toContain("reasoningEfforts: false");
    expect(syncDshProfile(first.text,[{...model,reasoning_levels:[]}],first.state).changes).toEqual([]);
  });
  it("respects a manually disabled reasoning flag over automatic effort choices", () => {
    const out = syncDshProfile(profile,[{...model,capabilities:{reasoning:false},capability_sources:{...sources,reasoning:{source:"manual"}}}]);
    expect(out.text).toContain("reasoningEfforts: false");
    expect(out.text).not.toContain('high: "high"');
  });
  it("does not pretend DSH supports an unavailable ultra control", () => {
    const out = syncDshProfile(profile,[{...model,reasoning_levels:["high","ultra"]}]);
    expect(out.unsupported).toEqual([{id:model.id,levels:["ultra"]}]);
    expect(out.text).not.toContain("ultra:");
  });
  it("resolves DSH's existing credential reference without copying a key into the profile", () => {
    const referenced = profile.replace('apiKey: "fixture"','apiKeyEnv: DSH_FIXTURE_KEY_92');
    expect(connectionFromProfile(referenced,"nine-router",{DSH_FIXTURE_KEY_92:"fixture"}).key).toBe("fixture");
    expect(referenced).not.toContain('apiKey:');
  });
  it("never includes malformed credential contents in diagnostics", () => {
    const invalid=profile.replace('apiKey: "fixture"','apiKey: "private-fixture-key');
    expect(()=>connectionFromProfile(invalid)).toThrow("Invalid quoted value");
    try { connectionFromProfile(invalid); } catch (error) { expect(error.message).not.toContain("private-fixture-key"); }
  });
  it("reads the configured route without logging or embedding its credentials elsewhere", () => {
    expect(connectionFromProfile(profile)).toEqual({url:"https://router.test/v1/models",key:"fixture"});
    expect(()=>connectionFromProfile(profile.replace("https://router.test/v1","http://router.test/v1"))).toThrow("HTTPS");
  });
});
