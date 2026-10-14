import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import "../translator/registerAll.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { getDefaultModel, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { parseModel } from "../../open-sse/services/model.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { applyThinking, stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetch }));
const require = createRequire(import.meta.url);
const mitm = require("../../src/mitm/config.js");
const ids = ["gemini-4-argon", ...["high", "medium", "low"].map(tier => `gemini-4-argon-${tier}`)];
afterEach(() => vi.clearAllMocks());

describe("Antigravity Gemini 4 Argon", () => {
  it.each(ids)("exposes %s across the registry, MITM and CLI", id => {
    expect(parseModel(`ag/${id}`)).toMatchObject({ provider: "antigravity", model: id });
    expect(antigravity.models.filter(model => model.id === id)).toHaveLength(1);
    expect(MITM_TOOLS.antigravity.modelAliases).toContain(id);
    expect(MITM_TOOLS.antigravity.defaultModels.map(model => model.id)).toContain(id);
    expect(mitm.MODEL_SYNONYMS.antigravity[id]).toBe(id);
    expect(mitm.extractModel("/v1internal:streamGenerateContent", Buffer.from(JSON.stringify({ model: id })))).toBe(id);
    expect(mitm.MODEL_PATTERNS.antigravity.find(({ match }) => match.test(id))?.alias).toBe(id);
    const cli = readFileSync(new URL("../../cli/src/cli/menus/providers.js", import.meta.url), "utf8");
    expect(cli.match(/\n  ag: \[([\s\S]*?)\n  \],/)?.[1]).toContain(id);
  });

  it("keeps Flash as the default and preserves its existing effort mapping", () => {
    expect(getDefaultModel("ag")).toBe("gemini-3.8-flash-high");
    expect(getModelUpstreamId("ag", "gemini-3.8-flash")).toBe("gemini-3.8-flash-medium(medium)");
    expect(MITM_TOOLS.antigravity.defaultModels.find(model => model.mandatory)?.id).toBe("gemini-3.8-flash-medium");
  });

  it.each(["high", "medium", "low"])("sends the exact %s ID and thinking level through translation and execute", async tier => {
    const id = `gemini-4-argon-${tier}`;
    const upstream = getModelUpstreamId("ag", id);
    expect(upstream).toBe(`${id}(${tier})`);
    const credentials = { projectId: "test-project", accessToken: "test-token", connectionId: "test-connection" };
    for (const stream of [false, true]) {
      fetch.mockResolvedValueOnce(new Response("{}", { headers: { "content-type": "application/json" } }));
      const body = translateRequest("openai", "antigravity", upstream, {
        messages: [{ role: "user", content: "Use the read_file tool" }],
        tools: [{ type: "function", function: { name: "read_file", parameters: {
          type: "object", properties: { path: { type: "string", encrypted: true }, encrypted: { type: "boolean" } },
        } } }],
      }, stream, credentials, "antigravity");
      body.model = stripThinkingSuffix(upstream);
      const result = await new AntigravityExecutor().execute({ model: upstream, body, stream, credentials });
      const [url, options] = fetch.mock.calls.at(-1);
      const wire = JSON.parse(options.body);
      expect(url).toContain(stream ? ":streamGenerateContent?alt=sse" : ":generateContent");
      expect(wire.model).toBe(id);
      expect(wire.project).toBe("test-project");
      expect(wire.requestType).toBeUndefined();
      expect(wire.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: tier, includeThoughts: true });
      const schema = wire.request.tools.flatMap(tool => tool.functionDeclarations || []).find(tool => tool.name === "read_file")?.parameters;
      expect(schema.properties.path.encrypted).toBeUndefined();
      expect(schema.properties.encrypted).toEqual({ type: "boolean" });
      expect(result.response.ok).toBe(true);
    }
  });

  it.each(["none", "minimal", "max"])("clamps %s to an allowed Argon thinking level without changing Flash", effort => {
    const argon = { request: { generationConfig: {} }, reasoning_effort: effort };
    const flash = structuredClone(argon);
    applyThinking("antigravity", "gemini-4-argon", argon, "antigravity");
    applyThinking("antigravity", "gemini-3.8-flash", flash, "antigravity");
    expect(argon.request.generationConfig.thinkingConfig.thinkingLevel).toBe(effort === "max" ? "high" : "low");
    expect(flash.request.generationConfig.thinkingConfig.thinkingLevel).toBe(effort === "max" ? "high" : "minimal");
  });

  it.each(ids)("resolves official synchronous capabilities and introductory pricing for %s", id => {
    expect(getCapabilitiesForModel("antigravity", id)).toMatchObject({
      vision: true, pdf: true, audioInput: true, videoInput: true, tools: true,
      reasoning: true, search: true, contextWindow: 1048576, maxOutput: 65536,
      thinkingFormat: "gemini-level", thinkingCanDisable: false,
    });
    expect(getThinkingLevels("antigravity", id)).toEqual(["low", "medium", "high"]);
    expect(getPricingForModel("antigravity", id)).toEqual({ input: 2, output: 10, cached: 0.1 });
  });
});
