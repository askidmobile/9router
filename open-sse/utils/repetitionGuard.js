/**
 * Детектор репитишн-коллапса в стримящемся ответе ассистента.
 *
 * Flash-модели иногда «залипают» на одной фразе и повторяют её до лимита ответа:
 * в одной кодекс-сессии такое сообщение выросло до 145 211 символов — 11
 * осмысленных строк, а дальше одна и та же фраза 1527 раз. Стрим при этом
 * формально успешен, клиент получает мегабайты мусора и ждёт минуты.
 *
 * Гард считает подряд идущие одинаковые строки видимого ответа. Как только
 * одна строка повторилась `minRepeats` раз, он сообщает о срабатывании, и
 * вызывающий код обрывает генерацию протокольно корректным терминальным
 * кадром.
 *
 * Что НЕ считается:
 *   * reasoning/thinking — это не то, что клиент видит как ответ;
 *   * аргументы tool-call — там длинные повторы легитимны;
 *   * строки внутри ```-блоков — код, таблицы и JSON с одинаковыми строками
 *     это норма, а не коллапс (для них отдельный, кратно более высокий порог,
 *     чтобы незакрытый забор не отключал гард до конца ответа);
 *   * строки короче `minLineChars` — короткие повторы слишком шумные
 *     («}», «ok», пустые строки).
 */

// Строка короче этого порога не считается кандидатом в коллапс: у коротких
// повторов слишком много легитимных причин.
export const DEFAULT_MIN_LINE_CHARS = 60;

// Сколько раз строка должна повториться подряд, чтобы это перестало быть
// случайностью. Шестнадцать повторов — это ~1.2 КБ мусора на клиенте вместо
// 145 КБ, при этом легитимные повторы (строки журнала, таблицы) не задеваются.
export const DEFAULT_MIN_REPEATS = 16;

// Во сколько раз выше порог внутри ```-блока: там одинаковые строки — норма,
// но бесконечный повтор в незакрытом блоке всё равно надо ловить.
export const FENCE_REPEAT_MULTIPLIER = 8;

// Предел незавершённой (без \n) строки в буфере: ответ без переводов строк
// иначе рос бы бесконечно. Держим хвост — детектору важнее конец.
const MAX_PENDING_CHARS = 8192;

// Строка-забор Markdown.
const FENCE_TOKEN = "```";

// Нормализация: пробельные отличия не должны маскировать повтор
// («I will  open» и «I will open» — одна и та же фраза). В реальном rollout
// строки приходили с хвостовым пробелом и отступом в два пробела.
function normalizeLine(line) {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * @param {object} [options]
 * @param {number} [options.minLineChars] - минимальная длина строки-кандидата
 * @param {number} [options.minRepeats]   - сколько подряд одинаковых строк считать коллапсом
 * @returns {{ push: (text: string) => ({ line: string, repeats: number, chars: number } | null), fired: () => (object | null), reset: () => void }}
 */
export function createRepetitionGuard(options = {}) {
  const minLineChars = Number.isFinite(options.minLineChars) && options.minLineChars > 0
    ? options.minLineChars
    : DEFAULT_MIN_LINE_CHARS;
  const minRepeats = Number.isFinite(options.minRepeats) && options.minRepeats > 1
    ? options.minRepeats
    : DEFAULT_MIN_REPEATS;
  const fenceRepeats = minRepeats * FENCE_REPEAT_MULTIPLIER;

  let pending = "";      // хвост без перевода строки
  let inFence = false;   // внутри ```-блока
  let previous = "";     // предыдущая нормализованная строка
  let streak = 0;        // сколько таких строк подряд встретилось
  let consumed = 0;      // всего символов на входе
  let hit = null;        // первое срабатывание

  const resetStreak = () => {
    previous = "";
    streak = 0;
  };

  const push = (text) => {
    if (hit) return hit;
    if (typeof text !== "string" || text.length === 0) return null;

    consumed += text.length;
    pending += text;

    const lines = pending.split("\n");
    pending = lines.pop() || "";
    if (pending.length > MAX_PENDING_CHARS) pending = pending.slice(-MAX_PENDING_CHARS);

    for (const raw of lines) {
      const trimmed = raw.trim();

      // Забор Markdown переключает режим и рвёт серию: граница блока — не повтор.
      if (trimmed.startsWith(FENCE_TOKEN)) {
        inFence = !inFence;
        resetStreak();
        continue;
      }

      const line = normalizeLine(raw);

      // Пустая строка — разделитель абзацев, а не повод сбросить серию:
      // «A\n\nA\n\nA» — тот же залипший повтор.
      if (line.length === 0) continue;

      if (line.length < minLineChars) {
        resetStreak();
        continue;
      }

      if (line === previous) {
        streak += 1;
      } else {
        previous = line;
        streak = 1;
      }

      if (streak >= (inFence ? fenceRepeats : minRepeats)) {
        hit = { line: line.slice(0, 200), repeats: streak, chars: consumed, inFence };
        return hit;
      }
    }

    return null;
  };

  return {
    push,
    fired: () => hit,
    reset: () => {
      pending = "";
      inFence = false;
      consumed = 0;
      hit = null;
      resetStreak();
    },
  };
}
