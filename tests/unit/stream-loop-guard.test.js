// Гард репитишн-коллапса в SSE-стриме.
//
// Регрессия: flash-модель в одной генерации повторила одну и ту же строку
// 1527 раз (145 211 символов). Клиент (Codex) получил мегабайт повторов и
// ждал минуты, хотя ответ фактически закончился на 11-й строке.
//
// Здесь проверяем весь путь: chat→Responses (основной путь Codex), chat→Claude,
// повторы внутри кода и tool-call (не должны резаться) и учёт/закрытие потока.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";
import { DEFAULT_MIN_REPEATS } from "../../open-sse/utils/repetitionGuard.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

const LINE = "I will open the local preview and visually check the new card before committing.";

const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;

const roleChunk = () => sse({ id: "x", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
const contentChunk = (text) => sse({ id: "x", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const finishChunk = () => sse({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const DONE = "data: [DONE]\n\n";

function makeController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: vi.fn(() => { connected = false; }),
    handleError: vi.fn(() => { connected = false; }),
    handleDisconnect: vi.fn(() => { connected = false; }),
    abort: vi.fn(() => { connected = false; }),
  };
}

function upstream(frames) {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text + dec.decode();
}

// Прогоняем кадры через настоящий pipeWithDisconnect + createDisconnectAwareStream,
// чтобы проверить и закрытие потока, и колбэки контроллера.
async function runStream({ frames, targetFormat, sourceFormat, provider = "test" }) {
  const controller = makeController();
  const onCut = vi.fn();
  const transform = createSSETransformStreamWithLogger(
    targetFormat, sourceFormat, provider, null, null, "test-model", "conn", { model: "test-model" },
    null, null, null, null, null, vi.fn(), undefined, onCut,
  );
  const body = createDisconnectAwareStream(
    { readable: upstream(frames).pipeThrough(transform), writable: { getWriter: () => ({ abort: async () => {} }) } },
    controller,
    () => `data: {"error":"abort"}\n\n`,
  );
  const text = await readAll(body);
  return { text, controller, onCut };
}

function responsesEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") continue;
    try { out.push(JSON.parse(raw)); } catch { /* не JSON */ }
  }
  return out;
}

describe("loop guard: chat -> Responses (Codex)", () => {
  it("режет повтор, отдаёт один response.completed с usage и не шлёт error", async () => {
    const repeats = Array(DEFAULT_MIN_REPEATS + 5).fill(LINE);
    const { text, controller, onCut } = await runStream({
      frames: [
        roleChunk(),
        contentChunk("Сборка и тесты прошли, проверяю карточку.\n"),
        // все повторы в одном сетевом чанке — самый частый случай
        contentChunk(repeats.join("\n") + "\n"),
        finishChunk(),
        DONE,
      ],
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });

    const events = responsesEvents(text);
    const names = events.map((e) => e.type);
    const completed = events.filter((e) => e.type === "response.completed");

    expect(completed).toHaveLength(1);
    expect(names[names.length - 1]).toBe("response.completed");
    expect(names).not.toContain("response.failed");
    expect(text).not.toContain('"error":{');
    expect(text).not.toContain('data: {"error"');
    expect(onCut).toHaveBeenCalledTimes(1);
    expect(controller.handleError).not.toHaveBeenCalled();
    expect(controller.handleComplete).toHaveBeenCalled();

    // usage в терминальном кадре: по нему Codex считает окно и автокомпакт
    expect(completed[0].response?.usage?.output_tokens).toBeGreaterThan(0);

    // до клиента дошло меньше копий, чем было в апстриме
    const delivered = events
      .filter((e) => e.type === "response.output_text.delta")
      .reduce((n, e) => n + String(e.delta || "").split(LINE).length - 1, 0);
    expect(delivered).toBeLessThan(DEFAULT_MIN_REPEATS);
  });
});

describe("loop guard: chat -> Claude", () => {
  it("закрывает поток ровно одним message_stop", async () => {
    const repeats = Array(DEFAULT_MIN_REPEATS + 5).fill(LINE);
    const { text, controller } = await runStream({
      frames: [
        contentChunk("Проверяю карточку.\n"),
        contentChunk(repeats.join("\n") + "\n"),
        finishChunk(),
        DONE,
      ],
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.CLAUDE,
    });

    const events = responsesEvents(text);
    expect(events.filter((e) => e.type === "message_stop")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_delta")).toHaveLength(1);
    expect(controller.handleError).not.toHaveBeenCalled();
    expect(text.split(LINE).length - 1).toBeLessThan(DEFAULT_MIN_REPEATS);
  });
});

describe("loop guard: не режет легитимное", () => {
  it("повторы внутри ```-блока уходят целиком", async () => {
    const repeats = Array(DEFAULT_MIN_REPEATS + 5).fill(LINE);
    const { text, onCut } = await runStream({
      frames: [
        contentChunk("```text\n" + repeats.join("\n") + "\n```\n"),
        finishChunk(),
        DONE,
      ],
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });
    expect(onCut).not.toHaveBeenCalled();
    const delivered = responsesEvents(text)
      .filter((e) => e.type === "response.output_text.delta")
      .reduce((n, e) => n + String(e.delta || "").split(LINE).length - 1, 0);
    expect(delivered).toBe(repeats.length);
  });

  it("повторы внутри аргументов tool-call не считаются", async () => {
    const args = JSON.stringify({ cmd: LINE });
    const frames = [roleChunk()];
    for (let i = 0; i < DEFAULT_MIN_REPEATS + 5; i++) {
      frames.push(sse({ id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: i === 0 ? "call_1" : undefined, function: { name: i === 0 ? "exec" : undefined, arguments: args } }] }, finish_reason: null }] }));
    }
    frames.push(finishChunk(), DONE);

    const { text, onCut } = await runStream({ frames, targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI_RESPONSES });
    expect(onCut).not.toHaveBeenCalled();
    expect(text).toContain("function_call");
  });
});
