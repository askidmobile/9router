/**
 * Regression test: CodeBuddy API-key connections must be testable.
 *
 * The apikey branch of testApiKeyConnection is a switch over provider ids with no
 * case for codebuddy-intl/cn, so it fell through to `default` and returned
 * {"valid":false,"error":"Provider test not supported"} for a perfectly healthy
 * key. testSingleConnection then persisted that string as `lastError` and set
 * testStatus:"error", which later surfaced on unrelated chat failures as
 * "HTTP 503: [codebuddy-intl/deepseek-v4.1-flash] Provider test not supported"
 * — hiding the real cause (a 429 per-model frequency limit).
 *
 * The fix wires a cheap authenticated probe (the billing endpoint: 200 + credit
 * packages on a valid key, 401 on a bad one) and stops persisting the
 * "not supported" sentinel at all.
 *
 * testUtils.js is a Next.js server module, so these assertions inspect the source.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";

const src = fs.readFileSync(
  new URL("../../src/app/api/providers/[id]/test/testUtils.js", import.meta.url),
  "utf-8",
);

describe("CodeBuddy apikey test probe", () => {
  it("handles both regional ids in the apikey switch", () => {
    expect(src).toMatch(/case "codebuddy-intl":\s*\n\s*case "codebuddy-cn": \{/);
  });

  it("probes the billing endpoint rather than spending a chat request", () => {
    // A chat probe burns the per-model frequency limit and reads as a broken
    // credential; the billing meter is the cheap authenticated call.
    expect(src).toMatch(/billing\/meter\/get-user-resource/);
  });

  it("treats 401/403 as an invalid key and any other failure as an API error", () => {
    expect(src).toMatch(/billingRes\.status === 401 \|\| billingRes\.status === 403/);
    expect(src).toMatch(/CodeBuddy billing API error/);
  });

  it("does not persist the unsupported sentinel on the connection", () => {
    // The guard must run before the updateData block that writes lastError.
    const guardIdx = src.indexOf('result.error === "Provider test not supported"');
    const updateIdx = src.indexOf("testStatus: result.valid ? \"active\" : \"error\"");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(updateIdx);
  });
});
