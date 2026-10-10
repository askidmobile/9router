import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { openAICompletionToResponses } from "../../open-sse/translator/response/openai-responses-json.js";
import { parseTextToolCalls } from "../../open-sse/translator/concerns/textToolCalls.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// Real apinex free-tier output: the model prints the call as XML text instead
// of emitting structured tool_calls, so Codex renders the markup as an answer.
const APINEX_SAMPLE = `Начинаю реализацию плана. Сначала проверю текущее состояние репозитория.

<tool_calls>
<tool_exec_command>
<parameter=cmd>
cd "/Volumes/Askid Dev/Projects/Yttri" && git status --short | head -20
</parameter>
<parameter=yield_time_ms>
10000
</parameter>
</tool>
</tool_call>`;

const NESTED_SAMPLE = `<tool_calls>
<tool_list_mcp_resources>
<server>
context7
</server>
</tool_list_mcp_resources>
<exec>
<cmd>
<cmd>
pwd
</cmd>
</exec>
</tool_calls>`;

function textChunk(text) {
  return { id: "chatcmpl-1", choices: [{ index: 0, delta: { content: text } }] };
}

function finishChunk() {
  return {
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };
}

function runStream(parts) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = [];
  for (const part of parts) {
    events.push(...openaiToOpenAIResponsesResponse(typeof part === "string" ? textChunk(part) : part, state));
  }
  events.push(...openaiToOpenAIResponsesResponse(null, state));
  return events;
}

function streamedText(events) {
  return events
    .filter((event) => event.event === "response.output_text.delta")
    .map((event) => event.data.delta)
    .join("");
}

function doneItems(events) {
  return events
    .filter((event) => event.event === "response.output_item.done")
    .map((event) => event.data.item);
}

function completedOutput(events) {
  return events.find((event) => event.event === "response.completed")?.data?.response?.output;
}

describe("textual tool-call parser", () => {
  it("recovers the apinex XML call and keeps the visible prose", () => {
    const parsed = parseTextToolCalls(APINEX_SAMPLE);
    expect(parsed.calls).toEqual([{
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: 'cd "/Volumes/Askid Dev/Projects/Yttri" && git status --short | head -20',
        yield_time_ms: 10000,
      }),
    }]);
    expect(parsed.text).toBe("Начинаю реализацию плана. Сначала проверю текущее состояние репозитория.");
  });

  it("recovers nested non-parameter tags from a mixed block", () => {
    const parsed = parseTextToolCalls(NESTED_SAMPLE);
    expect(parsed.calls).toEqual([
      { name: "list_mcp_resources", arguments: JSON.stringify({ server: "context7" }) },
      { name: "exec", arguments: JSON.stringify({ cmd: "pwd" }) },
    ]);
    expect(parsed.text).toBe("");
  });

  it("leaves text without a tool block untouched", () => {
    expect(parseTextToolCalls("обычный ответ без вызовов")).toEqual({
      text: "обычный ответ без вызовов",
      calls: [],
    });
  });

  it("leaves an unparseable block as text", () => {
    const text = "<tool_calls>\nпросто заметка\n</tool_calls>";
    expect(parseTextToolCalls(text)).toEqual({ text, calls: [] });
  });
});

describe("streaming chat → Responses recovery", () => {
  it("emits function_call items instead of the raw XML, even split across chunks", () => {
    const parts = APINEX_SAMPLE.match(/[\s\S]{1,9}/g);
    const events = runStream([...parts, finishChunk()]);

    const text = streamedText(events);
    expect(text).toContain("Начинаю реализацию плана");
    expect(text).not.toContain("tool_calls");
    expect(text).not.toContain("<parameter");

    const call = doneItems(events).find((item) => item.type === "function_call");
    expect(call).toMatchObject({ name: "exec_command" });
    expect(JSON.parse(call.arguments)).toEqual({
      cmd: 'cd "/Volumes/Askid Dev/Projects/Ytsri" && git status --short | head -20'.replace("Ytsri", "Yttri"),
      yield_time_ms: 10000,
    });

    expect(completedOutput(events)).toEqual(doneItems(events));
  });

  it("keeps a message item with the prose before the recovered call", () => {
    const events = runStream([APINEX_SAMPLE, finishChunk()]);
    const message = doneItems(events).find((item) => item.type === "message");
    expect(message.content[0].text).toContain("Начинаю реализацию плана");
    expect(message.content[0].text).not.toContain("<tool_calls>");
  });

  it("does not touch ordinary streamed text", () => {
    const events = runStream(["Привет, ", "мир!", finishChunk()]);
    expect(streamedText(events)).toBe("Привет, мир!");
    expect(doneItems(events).map((item) => item.type)).toEqual(["message"]);
  });
});

describe("non-streaming chat → Responses recovery", () => {
  it("returns a stripped message plus a function_call item", () => {
    const response = openAICompletionToResponses({
      id: "chatcmpl-1",
      model: "free/minimax-m3.1",
      choices: [{ index: 0, message: { role: "assistant", content: APINEX_SAMPLE }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });

    expect(response.status).toBe("completed");
    expect(response.output[0]).toMatchObject({ type: "message", role: "assistant" });
    expect(response.output[0].content[0].text).not.toContain("<tool_calls>");
    expect(response.output[1]).toMatchObject({ type: "function_call", name: "exec_command" });
    expect(JSON.parse(response.output[1].arguments)).toMatchObject({ yield_time_ms: 10000 });
  });

  it("keeps structured tool_calls as the only calls", () => {
    const response = openAICompletionToResponses({
      id: "chatcmpl-2",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "calling",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
    });
    expect(response.output.map((item) => item.type)).toEqual(["message", "function_call"]);
    expect(response.output[1].call_id).toBe("call_1");
  });
});

describe("SSE pipeline recovery", () => {
  async function transform(chunks) {
    const input = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });
    const output = stream.pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "deepseek", null, null, "free/minimax-m3.1",
    ));
    const reader = output.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  it("turns streamed XML text into function_call events and never leaks the markup", async () => {
    const halves = [APINEX_SAMPLE.slice(0, 90), APINEX_SAMPLE.slice(90)];
    const output = await transform([
      ...halves.map((text) => ({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: text } }] })),
      { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
    ]);

    expect(output).toContain('"type":"function_call"');
    expect(output).toContain("exec_command");
    expect(output).not.toContain("<tool_calls>");
    expect(output).not.toContain("<parameter");
    const completed = output.split("\n").filter((line) => line.startsWith("data: ") && line.includes('"type":"response.completed"'));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toContain('"name":"exec_command"');
  });
});
