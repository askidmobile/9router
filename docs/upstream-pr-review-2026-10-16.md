# Проверка наших upstream PR — 2026-10-16

Проверены все шесть открытых PR автора `askidmobile` в `decolua/9router`. Три самостоятельных PR обновлены до v0.5.104 (`87a74e1b`), опубликованы и имеют `MERGEABLE / CLEAN`. Один дублирующий PR закрыт; два исторических stack PR переведены в draft с описанием неперенесённых частей и ограничений.

[Машиночитаемая проверка](audit/2026-10-16-upstream-pr-review/verification.json) содержит точные heads, размеры diff, результаты тестов и hashes повторно прочитанных описаний.

## Результат

| PR | Действие | Проверка |
|---|---|---|
| [#3611 Streaming](https://github.com/decolua/9router/pull/3611) | Обновлён, head `36d14d82`; 6 файлов, +190/-13 | 19 focused tests; ESLint; полный прогон без уникальных сбоев |
| [#3612 Reset times](https://github.com/decolua/9router/pull/3612) | Обновлён, head `df279f00`; 3 файла, +104/-2 | 9 новых тестов; ESLint; полный прогон без уникальных сбоев |
| [#3989 Codex picker](https://github.com/decolua/9router/pull/3989) | Обновлён, head `d282c3bd`; 52 файла, +4243/-232 | 217 focused tests; production build; полный прогон с теми же failing IDs, что и upstream |
| [#3345 Model selection](https://github.com/decolua/9router/pull/3345) | Закрыт как дублирующая историческая ветка | Оба собственных commit `f7c960e3` / `b2ff7bc5` присутствуют в #3346 и нашем master |
| [#3032 Model management](https://github.com/decolua/9router/pull/3032) | Draft; описание переписано | 124 файла; конфликтующая база v0.5.55, смешаны модели, транспорт, auth, packaging и quotas |
| [#3346 Kiro / Cloudflare](https://github.com/decolua/9router/pull/3346) | Draft; описание переписано | 135 файлов; включает модельный stack, а старые Kiro catalog removals требуют пересмотра |

Общий новый PR не создавался. В [#3456](https://github.com/decolua/9router/pull/3456) maintainer явно просил отдельные самостоятельные PR по одной теме после обнаружения зависимостей от файлов, существовавших только в форке. Новые heads сохраняют историю существующих PR и не переносят весь наш master.

## Что исправлено в streaming PR

Дополнительно к старым изменениям воспроизведены и исправлены потеря reasoning-only чанка до нормализации, дублирование последнего `[DONE]` без newline, неполный SSE delimiter и ошибочный отказ после уже выданного tool call. Финальная provider usage из повторного finish доставляется отдельным usage-only trailer; реальные counts заменяют прежнюю оценку в учёте. JSON и forced-SSE JSON с пустым native failure проверены через `handleChatCore` и возвращают HTTP 502.

## Полная регрессия

| Ветка | Passed | Failed | Skipped | Todo | Collection failures |
|---|---:|---:|---:|---:|---:|
| Чистый upstream v0.5.104 | 3583 | 91 | 98 | 1 | 5 |
| #3611 | 3594 | 91 | 98 | 1 | 5 |
| #3612 | 3594 | 89 | 98 | 1 | 5 |
| #3989 | 3740 | 91 | 98 | 1 | 5 |

Сравнивались пары `(test file, fullName)` и collection failures. У #3611 и #3989 наборы совпали с базой; у #3612 являются подмножеством: два upstream MiniMax header snapshot failures в его запуске не повторились. Это не объявляется исправлением этих snapshots.

У GitHub PR отсутствуют status checks; `CLEAN` означает отсутствие конфликтов. Полная upstream suite в используемом окружении не является зелёной. Во время промежуточных запусков наблюдались DNS timeout и одиночный сбой неизменённого DB priority test; финальные полные прогоны эти случаи прошли. Три контрольных запуска DB suite на чистом upstream дали 23/0 каждый.

## Что остаётся в drafts

Models dashboard, ручной импорт/редактирование metadata и пользовательские capability/pricing overrides ещё отсутствуют в upstream. Его background models.dev refresh не заменяет эту функциональность. #3032 сохраняет предложение до самостоятельного переноса полного dependency chain на текущую базу.

Cloudflare model discovery и daily neuron usage также не перенесены. В #3346 разделены нужные поверхности: discovery связан с импортом моделей, usage — с отдельной квотной интеграцией. Устаревший список удаляемых Kiro-моделей и Antigravity rename нельзя переносить без повторной проверки текущих каталогов.

Закрытие #3345 не означает, что model-selection поведение уже реализовано upstream. Код, ветки и PR history сохранены. Эти drafts требуют отдельной переработки и текущего build/test acceptance перед готовностью к review.

Production, реальные аккаунты и установку Codex helper не меняли. Изменения исходников сделаны только в PR-ветках; наш master в этой задаче получает этот локальный отчёт. Незакоммиченная правка `CLAUDE.md` сохранена вне commit. Наш master не публиковался.
