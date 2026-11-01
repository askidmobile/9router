// Детектор репитишн-коллапса стримящегося ответа.
//
// Регрессия: flash-модель в одной генерации повторила одну и ту же строку
// 1527 раз (145 211 символов). Гард должен поймать это, не трогая легитимные
// повторы в коде и короткие строки.
import { describe, it, expect } from "vitest";
import {
  createRepetitionGuard,
  DEFAULT_MIN_LINE_CHARS,
  DEFAULT_MIN_REPEATS,
  FENCE_REPEAT_MULTIPLIER,
} from "../../open-sse/utils/repetitionGuard.js";

const LINE = "I will open the local preview and visually check the new card before committing.";

function feed(guard, lines) {
  return guard.push(lines.join("\n") + "\n");
}

// Быстрый гард: маленький порог, чтобы кейсы не строились на 16 строках.
const quick = (opts = {}) => createRepetitionGuard({ minLineChars: 20, minRepeats: 3, ...opts });

describe("createRepetitionGuard", () => {
  it("по умолчанию режет на 16-м повторе", () => {
    const guard = createRepetitionGuard();
    expect(DEFAULT_MIN_REPEATS).toBe(16);
    expect(feed(guard, Array(DEFAULT_MIN_REPEATS - 1).fill(LINE))).toBe(null);
    expect(feed(guard, [LINE])).toMatchObject({ repeats: DEFAULT_MIN_REPEATS });
  });

  it("срабатывает на повторе из реального срыва (1527 копий)", () => {
    const guard = createRepetitionGuard();
    const lines = ["Типы и тесты уже зелёные, сборка прошла."].concat(Array(1527).fill(LINE));
    const hit = feed(guard, lines);
    expect(hit).not.toBe(null);
    expect(hit.repeats).toBe(DEFAULT_MIN_REPEATS);
    // до клиента доходит не больше порога копий, а не полторы тысячи
    expect(hit.repeats).toBeLessThan(1527);
  });

  it("три повтора — ещё не коллапс", () => {
    const guard = quick();
    expect(feed(guard, [LINE, LINE])).toBe(null);
  });

  it("формат строк из rollout (отступ и хвостовой пробел) считается повтором", () => {
    const guard = quick();
    const raw = `  ${LINE} \n`;
    const hit = guard.push(`первая осмысленная строка ответа\n${raw}${raw}${raw}`);
    expect(hit).toMatchObject({ repeats: 3 });
  });

  it("разные строки не считаются повтором", () => {
    const guard = quick();
    expect(feed(guard, [LINE, LINE, "and now something completely different, spelled out"])).toBe(null);
  });

  it("пробельные отличия не маскируют повтор", () => {
    const guard = quick();
    const padded = LINE.replace(/ /g, "   ");
    expect(feed(guard, [LINE, LINE, padded])).toMatchObject({ repeats: 3 });
  });

  it("пустые строки между повторами не сбрасывают серию", () => {
    const guard = quick();
    expect(feed(guard, [LINE, "", LINE, "", LINE])).toMatchObject({ repeats: 3 });
  });

  it("не режет повторы внутри ```-блока до отдельного, кратного порога", () => {
    const guard = quick({ minRepeats: 3 });
    const fenceLimit = 3 * FENCE_REPEAT_MULTIPLIER;
    const below = ["```js"].concat(Array(fenceLimit - 1).fill(LINE)).concat(["```"]);
    expect(feed(guard, below)).toBe(null);
  });

  it("незакрытый ``` не отключает гард навсегда", () => {
    const guard = quick({ minRepeats: 3 });
    const fenceLimit = 3 * FENCE_REPEAT_MULTIPLIER;
    expect(feed(guard, ["```js"].concat(Array(fenceLimit).fill(LINE)))).toMatchObject({ inFence: true });
  });

  it("после выхода из ```-блока снова работает обычный порог", () => {
    const guard = quick({ minRepeats: 3 });
    expect(feed(guard, ["```", LINE, LINE, "```"])).toBe(null);
    expect(feed(guard, [LINE, LINE, LINE])).toMatchObject({ repeats: 3 });
  });

  it("короткие строки не считаются повтором", () => {
    const guard = createRepetitionGuard();
    expect(feed(guard, Array(50).fill("}"))).toBe(null);
    const short = "x".repeat(DEFAULT_MIN_LINE_CHARS - 1);
    expect(feed(guard, Array(50).fill(short))).toBe(null);
  });

  it("строка ровно на пороге считается", () => {
    const guard = quick({ minLineChars: 20, minRepeats: 3 });
    const line = "x".repeat(20);
    expect(feed(guard, [line, line, line])).toMatchObject({ repeats: 3 });
  });

  it("видит повтор, когда строка приходит кусками", () => {
    const guard = quick({ minRepeats: 3 });
    for (let i = 0; i < 2; i++) {
      expect(guard.push(LINE.slice(0, 20))).toBe(null);
      expect(guard.push(LINE.slice(20) + "\n")).toBe(null);
    }
    expect(guard.push(LINE.slice(0, 20))).toBe(null);
    expect(guard.push(LINE.slice(20) + "\n")).toMatchObject({ repeats: 3 });
  });

  it("после срабатывания возвращает тот же результат", () => {
    const guard = quick();
    const hit = feed(guard, [LINE, LINE, LINE]);
    expect(guard.push(LINE + "\n")).toBe(hit);
  });
});
