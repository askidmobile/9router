import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { getModelTargetFormat, getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OPENAI_CHAT_TOOL_LIMIT } from "../../open-sse/config/runtimeConfig.js";

describe("OpenAI provider endpoint routing", () => {
  it("declares both Chat Completions and Responses transports", () => {
    expect(PROVIDERS.openai.transports?.map((t) => t.format)).toEqual(["openai", "openai-responses"]);
  });

  it("declares the Responses thinking format so effort is nested, not top-level", () => {
    const responses = PROVIDERS.openai.transports.find((t) => t.format === FORMATS.OPENAI_RESPONSES);
    expect(responses.thinkingFormat).toBe("openai-responses");
  });

  it.each([
    "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    "gpt-5-pro", "gpt-5.4-pro", "gpt-5.5-pro", "o3-pro",
  ])("routes %s tools to Responses", (model) => {
    expect(getModelTargetFormat("openai", model)).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelSupportedFormats("openai", model)).toEqual([FORMATS.OPENAI_RESPONSES]);
    expect(resolveTransport("openai", FORMATS.OPENAI_RESPONSES).baseUrl).toBe("https://api.openai.com/v1/responses");
  });

  it("keeps ordinary GPT chat models on Chat Completions", () => {
    expect(getModelTargetFormat("openai", "gpt-4o")).toBeNull();
    expect(resolveTransport("openai", FORMATS.OPENAI).baseUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("declares the Chat Completions tool cap in one place", () => {
    expect(OPENAI_CHAT_TOOL_LIMIT).toBe(128);
  });
});
