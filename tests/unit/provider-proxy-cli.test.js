import { describe, expect, it } from "vitest";
import { DevinCliExecutor } from "../../open-sse/executors/devin-cli.js";
import { ZcodeExecutor } from "../../open-sse/executors/zcode.js";

describe("external CLI providers fail closed", () => {
  it.each([DevinCliExecutor, ZcodeExecutor])("does not launch %s when a proxy is required", async Executor => {
    await expect(new Executor().execute({ proxyOptions: { proxyRequired: true } })).rejects.toThrow("cannot guarantee provider proxy routing");
  });
});
