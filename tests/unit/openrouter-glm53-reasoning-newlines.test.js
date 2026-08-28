import { describe, expect, it } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function transform(model, chunks) {
  const stream = createPassthroughStreamWithLogger("openrouter", null, model, null, {});
  const response = new Response(stream.readable);
  const consumed = response.text();
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n`).join("")));
  await writer.write(new TextEncoder().encode("data: [DONE]\n"));
  await writer.close();
  return consumed;
}

const chunk = (reasoning) => ({
  id: "gen-test-123",
  object: "chat.completion.chunk",
  created: 1,
  choices: [{
    index: 0,
    delta: {
      content: "",
      role: "assistant",
      reasoning,
      reasoning_details: [{ type: "reasoning.text", text: reasoning, format: "unknown", index: 0 }],
    },
    finish_reason: null,
  }],
});

describe("OpenRouter GLM-5.3-Flash reasoning stream", () => {
  it("drops upstream newline tokens interleaved between words", async () => {
    const output = await transform("z-ai/glm-5.3-flash", [chunk("Empty"), chunk("\n"), chunk(" directory\n"), chunk("Next")]);
    const events = output.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
    expect(events.map((event) => event.choices[0].delta.reasoning_content).join("")).toBe("Empty directory Next");
    expect(events.flatMap((event) => event.choices[0].delta.reasoning_details || []).map((detail) => detail.text).join("")).toBe("Empty directory Next");
  });

  it("leaves other OpenRouter models unchanged", async () => {
    const output = await transform("other/model", [chunk("line one\nline two")]);
    expect(JSON.parse(output.split("\n").find((line) => line.startsWith("data: {")).slice(6)).choices[0].delta.reasoning_content).toBe("line one\nline two");
  });
});
