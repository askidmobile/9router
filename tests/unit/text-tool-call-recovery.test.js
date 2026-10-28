import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { openAICompletionToResponses } from "../../open-sse/translator/response/openai-responses-json.js";
import { parseTextToolCalls, stripToolProtocolArtifacts } from "../../open-sse/translator/concerns/textToolCalls.js";
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

const DSML_TAIL_SAMPLE = `Возможный остаток разрыва теперь надо отделить от HTTP/SSE.

 \t-
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

const CONTENT_TEXT = "Проверяю Q4_K/Q6_K: все warp'ы должны участвовать в сумме.\nПуть: C:\\test\\kernel.cu";
const SERIALIZED_CONTENT = JSON.stringify([{ text: CONTENT_TEXT, type: "text" }]);
const dsmlTail = (mark = "｜DSML｜", escape = "") =>
  ["parameter", "invoke", "calls"].map(kind => `${escape}</${mark} ${kind}>${escape}`).join("\n");
const APINEX_DSML_SAMPLE = SERIALIZED_CONTENT + dsmlTail();

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

  it("removes an already-consumed DSML closer stack and its empty bullet", () => {
    expect(stripToolProtocolArtifacts(DSML_TAIL_SAMPLE)).toBe(
      "Возможный остаток разрыва теперь надо отделить от HTTP/SSE."
    );
    expect(parseTextToolCalls(DSML_TAIL_SAMPLE)).toEqual({
      text: "Возможный остаток разрыва теперь надо отделить от HTTP/SSE.",
      calls: [],
    });
  });

  it("preserves a trailing Markdown bullet without protocol evidence", () => {
    const text = "Проверяю сборку.\n \t-\n";
    expect(stripToolProtocolArtifacts(text)).toBe(text);
  });
});

describe("serialized content and DSML artifacts", () => {
  it.each(["｜DSML｜", "｜｜DSML｜｜", "|DSML|", "||DSML||"])("cleans %s tails and unwraps only text blocks", mark => {
    for (const escape of ["", "\\"]) {
      expect(parseTextToolCalls(SERIALIZED_CONTENT + dsmlTail(mark, escape))).toEqual({ text: CONTENT_TEXT, calls: [] });
      const raw = CONTENT_TEXT + "\n \t-\n" + dsmlTail(mark, escape);
      const events = runStream([...(raw.match(/[\s\S]/g) || []), finishChunk()]);
      expect(streamedText(events)).toBe(CONTENT_TEXT);
    }
  });

  it("decodes multiple text blocks in either key order without reparsing their text as calls", () => {
    const text = JSON.stringify([{ type: "text", text: CONTENT_TEXT }, { type: "output_text", text: APINEX_SAMPLE }]);
    expect(parseTextToolCalls(text + dsmlTail())).toEqual({ text: CONTENT_TEXT + APINEX_SAMPLE, calls: [] });
    const events = runStream([...(text + dsmlTail()).match(/[\s\S]/g), finishChunk()]);
    expect(streamedText(events)).toBe(CONTENT_TEXT + APINEX_SAMPLE);
    expect(doneItems(events).map(item => item.type)).toEqual(["message"]);
  });

  it.each([
    SERIALIZED_CONTENT,
    JSON.stringify([{ type: "text", text: APINEX_SAMPLE }]),
    `JSON example:\n\`\`\`json\n${SERIALIZED_CONTENT}\n\`\`\``,
    `DSML example:\n\`\`\`xml\n${dsmlTail()}\n\`\`\``,
    `<｜DSML｜ calls><｜DSML｜ invoke name="shell"><｜DSML｜ parameter name="command">pwd${dsmlTail()}`,
  ])("preserves ordinary JSON, code examples and complete DSML envelopes: %s", text => {
    expect(parseTextToolCalls(text)).toEqual({ text, calls: [] });
    const events = runStream([...(text.match(/[\s\S]{1,2}/g) || []), finishChunk()]);
    expect(streamedText(events)).toBe(text);
    expect(completedOutput(events)).toEqual(doneItems(events));
  });

  it("preserves blocks with non-text payloads instead of discarding their fields", () => {
    const json = JSON.stringify([{ type: "image_url", image_url: { url: "https://example.test/image.png" } }]);
    expect(parseTextToolCalls(json + dsmlTail())).toEqual({ text: json, calls: [] });
  });

  it("removes the artifact at every possible two-chunk boundary", () => {
    for (let split = 1; split < APINEX_DSML_SAMPLE.length; split++) {
      const events = runStream([APINEX_DSML_SAMPLE.slice(0, split), APINEX_DSML_SAMPLE.slice(split), finishChunk()]);
      expect(streamedText(events), `split ${split}`).toBe(CONTENT_TEXT);
      expect(completedOutput(events)).toEqual(doneItems(events));
    }
  });

  it.each([1, 2, 3, 9])("cleans escaped tags split into %i-character chunks", size => {
    const text = SERIALIZED_CONTENT + dsmlTail("｜DSML｜", "\\");
    const events = runStream([...(text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) || []), finishChunk()]);
    expect(streamedText(events)).toBe(CONTENT_TEXT);
    expect(doneItems(events)).toHaveLength(1);
    expect(completedOutput(events)).toEqual(doneItems(events));
  });

  it("retains incomplete JSON and protocol tails verbatim", () => {
    const text = APINEX_DSML_SAMPLE.slice(0, -4);
    const finish = finishChunk();
    finish.choices[0].finish_reason = "length";
    const events = runStream([...(text.match(/[\s\S]/g) || []), finish]);
    expect(streamedText(events)).toBe(text);
    expect(events.find(event => event.event === "response.incomplete")?.data.response.status).toBe("incomplete");
  });

  it("normalizes non-streaming output while preserving structured call arguments", () => {
    const args = JSON.stringify({ content: APINEX_DSML_SAMPLE });
    const response = openAICompletionToResponses({ id: "test", choices: [{ message: {
      content: APINEX_DSML_SAMPLE,
      tool_calls: [{ id: "call_keep", type: "function", function: { name: "write_file", arguments: args } }],
    }, finish_reason: "tool_calls" }] });
    expect(response.output[0].content[0].text).toBe(CONTENT_TEXT);
    expect(response.output[1]).toMatchObject({ name: "write_file", arguments: args });
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

  it("removes a split DSML closer stack before a following function call", () => {
    const parts = DSML_TAIL_SAMPLE.match(/[\s\S]{1,3}/g);
    const events = runStream([
      ...parts.map(textChunk),
      {
        id: "chatcmpl-1",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: '{"command":"pwd"}' } }] },
          finish_reason: null,
        }],
      },
      finishChunk(),
    ]);

    expect(streamedText(events)).toBe("Возможный остаток разрыва теперь надо отделить от HTTP/SSE.");
    const items = doneItems(events);
    expect(items.find((item) => item.type === "message").content[0].text).toBe(
      "Возможный остаток разрыва теперь надо отделить от HTTP/SSE."
    );
    expect(items.find((item) => item.type === "function_call")).toMatchObject({ name: "shell" });
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

  it("removes the DSML closer stack from non-streaming message content", () => {
    const response = openAICompletionToResponses({
      id: "chatcmpl-3",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: DSML_TAIL_SAMPLE,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"command":"pwd"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    });

    expect(response.output[0].content[0].text).toBe(
      "Возможный остаток разрыва теперь надо отделить от HTTP/SSE."
    );
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

  it("normalizes serialized text and DSML before emitting every Responses text event", async () => {
    const output = await transform([...APINEX_DSML_SAMPLE].map(textChunk).concat(finishChunk()));
    const events = output.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("")).toBe(CONTENT_TEXT);
    expect(events.find(event => event.type === "response.output_text.done").text).toBe(CONTENT_TEXT);
    const completed = events.filter(event => event.type === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].response.output[0].content[0].text).toBe(CONTENT_TEXT);
    expect(output).not.toContain("DSML");
  });
});
