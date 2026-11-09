# Refuseless reasoning и сравнение моделей — 2026-11-09

## Исправление Refuseless

Общий OpenAI normalizer пропускал `minimal`, `medium`, `xhigh` и `auto`, которые Refuseless отклоняет. Отдельный provider thinking format сохраняет OpenAI transport и преобразует уровни: `minimal→low`, `medium→high`, `xhigh/ultra→max`, `none→off`. `auto` опускается, чтобы действовал default модели. Для always-on моделей запрос отключения по-прежнему ограничивается минимальным уровнем.

Контракт: [Refuseless reasoning](https://docs.refuseless.com/guides/reasoning.md). Проверен реальный путь `translateRequest → DefaultExecutor` для OpenAI/Claude клиентов; другие провайдеры сохраняют прежнюю обработку.

## Скорость и таблица

- Токены/с: сумма provider-reported output tokens / сумма времени от первого содержательного output до завершения потоковых ответов за 24 часа. Role-only кадры и ожидание исключаются. Thinking учитывается, если провайдер включил его в output total.
- TTFT считается до первого наблюдаемого text/thinking/tool output. Измерение сетевое, не benchmark внутреннего inference engine.
- Оценочные usage, отменённые и явно ошибочные ответы не входят в замеры. При отсутствии измерений отображается `—`; прошлые запросы не пересчитываются. Непотоковые JSON-ответы не имеют достоверной границы первого output и не добавляют generation speed.
- Пять новых counters используют существующий hourly modelHealth buffer/flush. Новых таблиц, inference-вызовов или сохранения текстов для расчёта не требуется; observability может быть выключен.
- Исправлен двойной учёт generic HTTP 400 в error counter. Исторические buckets не изменяются, поэтому старые ошибки остаются в окне 24ч.
- В модели-группе показана скорость самого быстрого измеренного провайдера с его собственными sample count/TTFT; tooltip указывает alias.
- Сохранены четыре цены, context/max output, статусы, запросы, редактирование и cooldown reset. Counts перенесены в status cell, actions собраны отдельно. Сортировка по запросам сохранена, добавлена сортировка по скорости; CSV дополнен тремя полями в конце.
- Table layout ограничивает ширины колонок, ID переносятся по сегментам, заголовок закреплён; длинные labels и лишний `w-full` у selects больше не раздвигают controls. На узком экране scroll остаётся внутри таблицы.

## Проверки

6057 tests: 5940 passed, те же 7 исходных failures, 13 expected fail, 96 skipped, 1 todo. Новых failures нет. Проверены timed OpenAI/Claude/Responses streams, поздний SSE error, отдельный usage trailer, cancellation, weighted aggregation/persistence, CSV и wire enum Refuseless.

Providers baseline: 110; aliases: 148; OAuth URLs unchanged. ESLint изменённых production JS прошёл. Production webpack build прошёл. Browser QA использует fixture data: 1440/1280 без горизонтального scroll, 1024/375 с contained table scroll, sorting и edit modal. Параллельные Qubax изменения исключены: итоговая проверка и коммит выполняются в отдельном worktree на базе `9201b563`.

Данные проверки: [verification.json](../audit/2026-11-09-models-performance/verification.json).

Уточнение usage trailer: источник для output speed отделён от временных client estimates. Поздний provider usage используется даже если legacy accounting state сохранил `estimated`; расчёт стоимости и отдаваемые SSE usage поля не изменены.
