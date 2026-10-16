# Проверка и разделение upstream PR — 2026-10-16

Upstream v0.5.104 (`87a74e1b`) интегрирован в наш master, опубликован и развёрнут. Наши прежние изменения сохранены. Три ранее самостоятельных PR обновлены; два исторических draft заменены семью самостоятельными PR. Все десять открытых PR имеют `MERGEABLE / CLEAN`, не являются draft и основаны на текущем upstream. GitHub status checks к ним не подключены.

Проверка upstream через удалённый ref в конце работы подтвердила ту же базу `87a74e1bda3677193c6f71a7e2100c90311f0689`.

[Проверка опубликованных замен](audit/2026-10-16-upstream-pr-review/split-verification.json) содержит heads, размеры diff, результаты тестов, ограничения и проверку совместного слияния. [Первоначальная проверка](audit/2026-10-16-upstream-pr-review/verification.json) сохраняет результаты первого этапа, до разделения draft.

## Опубликованные самостоятельные PR

| PR | Изменение | Head | Тематические проверки |
|---|---|---|---:|
| [#4954](https://github.com/decolua/9router/pull/4954) | Явно настроенные и статические каталоги имеют приоритет перед live discovery в `/v1/models` | `9aa952c1` | 15 passed |
| [#4955](https://github.com/decolua/9router/pull/4955) | Канонический каталог Kiro без синтетических дублей; нынешние семейства и старые request aliases сохранены | `709674ff` | 27 passed |
| [#4956](https://github.com/decolua/9router/pull/4956) | Cloudflare discovery: inference IDs вместо UUID, пагинация, типы моделей, выбранный proxy и static fallback | `87e82355` | 6 passed |
| [#4957](https://github.com/decolua/9router/pull/4957) | Cloudflare daily free neuron allocation через актуальную GraphQL schema; явные ошибки analytics | `5e0bb52d` | 10 passed |
| [#4958](https://github.com/decolua/9router/pull/4958) | Удаление устаревшего cooldown-правила для malformed 400; fallback для 401/403/429 сохранён | `167d7261` | 9 passed |
| [#4959](https://github.com/decolua/9router/pull/4959) | Разделение Cline и ClinePass catalog namespaces с сохранением текущего free recommendation feed | `ddbf135f` | 16 passed |
| [#4960](https://github.com/decolua/9router/pull/4960) | Models dashboard, импорт, models.dev metadata, редактирование caps/pricing/aliases, DB export/restore | `868f9140` | 73 passed + build + browser |

Каждая ветка начинается непосредственно от текущего upstream. Зависимости между PR отсутствуют; все 21 пары веток сливаются без конфликтов. В #4960 UI, API, DB и проверки оставлены вместе как одна рабочая функция — 41 файл вместо исторического смешанного стека. Описания на английском повторно прочитаны после публикации и сверены с подготовленным текстом.

У #4960 production build прошёл на установленных Next.js 16.3.0 dependencies. Проверка в браузере использовала отдельную временную БД и локальные provider/models.dev fixtures: импорт двух моделей, повторный импорт без дублей, исключение image-only модели, редактирование и сброс caps/pricing, сохранение alias, правильные лимиты модели и alias через реальный HTTP endpoint, models.dev import и явная ошибка неуспешного сохранения без изменения состояния. Реальный SQLite export/restore, старые backups без caps и сохранение существующих custom rows проверены тестом. Новые UI/API/services/hooks проходят ESLint; четыре исходных ошибки существующих provider components и исходные registry warnings не относятся к этим изменениям.

## Ранее обновлённые PR

| PR | Head | Проверка |
|---|---|---|
| [#3611 Streaming](https://github.com/decolua/9router/pull/3611) | `36d14d82` | 19 focused tests; ESLint; полный прогон без уникальных сбоев |
| [#3612 Reset times](https://github.com/decolua/9router/pull/3612) | `df279f00` | 9 новых тестов; ESLint; полный прогон без уникальных сбоев |
| [#3989 Codex picker](https://github.com/decolua/9router/pull/3989) | `d282c3bd` | 217 focused tests; build; полный прогон с теми же failing IDs, что и upstream |

В streaming PR исправлены потеря reasoning-only чанка, дублирование последнего `[DONE]` без newline, неполный SSE delimiter и ошибочный отказ после выданного tool call. Финальная provider usage из повторного finish доставляется usage-only trailer; реальные counts заменяют оценку в учёте. JSON и forced-SSE JSON с пустым native failure проверены через `handleChatCore` и возвращают HTTP 502.

## Закрытые исторические стеки

[#3032](https://github.com/decolua/9router/pull/3032) и [#3346](https://github.com/decolua/9router/pull/3346) закрыты как заменённые; их описания перечисляют самостоятельные PR и границы переноса. Их исходные heads `1627f5af` и `324250e5`, ветки и история сохранены. [#3345](https://github.com/decolua/9router/pull/3345) ранее закрыт как duplicate; оба его commits включены в прежний #3346 и наш master, а новое самостоятельное предложение опубликовано в #4954.

Так выполнена просьба maintainer из [#3456](https://github.com/decolua/9router/pull/3456) о самостоятельных PR по одной теме. Устаревшие августовские удаления Kiro-моделей и Antigravity rename не перенесены. Наследуемые изменения auth, packaging, translators, logging, CommandCode и quotas исключены из model-management PR; собственные изменения форка сохранены. Закрытие старых PR не означает принятие новых upstream.

## Полная регрессия и ограничения

| Ветка | Passed | Failed assertions |
|---|---:|---:|
| Чистый upstream v0.5.104 | 3583 | 91 |
| #3611 | 3594 | 91 |
| #3612 | 3594 | 89 |
| #3989 | 3740 | 91 |
| #4954 | 3589 | 90 |
| #4955 | 3587 | 92 |
| #4956 | 3590 | 90 |
| #4957 | 3592 | 90 |
| #4958, финальный опубликованный source | 3588 | 91 |
| #4959 | 3585 | 91 |
| #4960, финальный опубликованный source | 3642 | 91 |

Сравнивались пары `(test file, fullName)` и collection failures. У исходного upstream есть 5 collection failures; полная suite не является зелёной. Два MiniMax header snapshots зависят от окружения и не всегда повторяют исходный сбой. В конкурентных запусках #4954/#4955/#4956/#4957 дополнительно наблюдался DNS timeout в неизменённом `strict-proxy-enforcement` test; отдельные повторные проверки на чистой базе и этих ветках дали 8/0. Остальные сбои входят в исходный baseline. Тематические проверки всех семи финальных изменений прошли. Совместная проверка 21 пары означает отсутствие конфликтов слияния; единый runtime всех семи PR отдельно не проверялся.

Cloudflare GraphQL introspection подтвердила текущие dataset/fields/scalars. Реальный read-only usage query вернул `not authorized for that account`: существующий inference token не имеет analytics permissions. Успешное получение live usage и сверка billing не подтверждены; разрешения token не расширялись. 10,000 neurons обозначают бесплатное дневное включение для Free/Paid, а не лимит платных расходов. Новая реализация показывает ошибку вместо ложного нулевого расхода.

## Наш master и production

Master опубликован. Production работает на проверенном source `02bf19b6`, image `sha256:d1b8818dbc4ac617c7e3a6f6416f0ae96b314f0ab0a94673fe8846b2c3c3851d`. Сохранены прежний контейнер и консистентный backup. После публикации PR повторная проверка показала `running`, `RestartCount=0` и HTTP 200 / `ok=true` через публичный health endpoint. [Последняя проверка](audit/2026-10-16-upstream-pr-review/production-followup.json), [подробности деплоя](upstream-sync-v0.5.104.md).

PR-ветки имеют независимые heads; исправления, сделанные при подготовке этих новых PR, не объявляются развёрнутыми в production. Перед deploy наш fork прошёл 4755 tests без failed assertions и build. QA и public HTTP/assets проверки прошли; единичный запрос к бесплатной OpenCode модели вернул HTTP 429, поэтому успешная live generation после deploy не заявляется.

Настройки маршрутизации, существующие custom models, 47 connections, 14 keys и 11 combos сохранены. Разрешённый пользователем фоновый catalog sync обновил prices существующих Cheaper models и добавил одну catalog-only Requesty запись; детали есть в deploy receipt. Незакоммиченный `CLAUDE.md` не изменялся и не включён в commits этой задачи.
