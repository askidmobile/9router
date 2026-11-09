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

## Production

Опубликованы `f0f0dbab` и `14d4372e`; финальная версия развёрнута на omni-fr из точного архива `14d4372e2e122b69a7d54b9f90aa657520aa5034`, v0.5.116. Образ: `sha256:40a6b525e65ec97f28aac9b9899a9fcace1a6a35368afece95d31325283e00d3`.

Образ предварительно проверен без внешней сети на копии production SQLite: маршрутизация/affinity/concurrency/cancellation, embeddings/TTS/strict proxy, ChatGPT tools/compaction, CodeBuddy, Refuseless JSON/SSE и Claude client с поздним usage, сохранение скорости при выключенном observability, native image metadata, multipart/CONNECT, management UI/assets и защита CommandCode secrets. Настройки после fixture-проверок совпали с исходными.

Перед остановкой `active=0, pending=0`. Сохранена согласованная SQLite backup; health восстановился за 10.07 с. После обновления: публичный и локальный health/UI/assets/secret guard прошли, `quick_check=ok`, 0 перезапусков и fatal log markers. Сохранены 55 подключений, 17 ключей, 13 Combo, environment, mounts, HostConfig и пользовательские настройки. Автоматическое обновление catalog-only записей, цен и proxy health продолжает штатную работу.

Rollback container `9router-before-models-performance-20261109-14d4372e` остановлен и готов; backup находится на сервере в `/root/9router-releases/models-performance-20261109-14d4372e/backup`. Секреты и база в репозиторий не копировались. Безопасные подтверждения: [production-result.json](../audit/2026-11-09-models-performance-deploy/production-result.json), [qa-result.json](../audit/2026-11-09-models-performance-deploy/qa-result.json), [deployment-result.json](../audit/2026-11-09-models-performance-deploy/deployment-result.json).

Платный live inference не выполнялся. Новые показатели появятся после новых успешных потоковых ответов; старые запросы не пересчитываются, прежние ошибки остаются в окне 24 часа.
