# Анализ 85 падений тестов upstream v0.5.91

Из 85 падений 63 связаны с устаревшими ожиданиями тестов, 8 — с неверными моками, 4 — со старым транспортом CommandCode, который в нашем fork уже удалён, и 2 — с устаревшим `it.fails`. Три падения показывают реальные дефекты upstream, уже исправленные в fork. Ещё три обнаруживают потерю событий usage, которая сохраняется в fork несмотря на зелёные тесты. Один тест относится к явно отключённому автоподбору Combo по search, один — к внешнему live endpoint MiMo.

Фраза «те же 85 ошибок, что и чистый upstream, новых нет» верна для **набора названий упавших тестов ветки PR #3989 и чистого upstream**, но не означает, что это 85 текущих ошибок нашего fork или что все они безвредны. Кроме этих 85 assertions в обоих прогонах есть **6 файлов с ошибками загрузки или обнаружения тестов**.

Дата анализа: 30 сентября 2026 года. Проведён разбор сохранённых отчётов, diff тестов и исходников, повторные прогоны и отдельные проверки действительного пути записи usage и перевода запросов. Изменены только файлы этого отчёта и его воспроизводимые проверки.

## Какие ветки и прогоны сравнивались

| Исходники | Revision | Сохранённый прогон |
|---|---|---|
| Чистый upstream v0.5.91 | `f01fb909e37189008080632ddaf404f096345cde` | 2889 cases: 2745 passed, 85 failed, 59 skipped; 294 файла |
| Ветка PR #3989 поверх upstream | `a369be29cce1f9518bef46a26382259fbab9e1e0` | 3046 cases: 2902 passed, 85 failed, 59 skipped; 304 файла |
| Наш fork после merge | `e58eedbc865ed3ac0d33865fb35aa46c6fbcb7a0` | 3501 cases: 3445 passed, 0 unexpected failures, 56 skipped; 336 файлов |

Сравнение выполнено по паре `(путь файла, fullName теста)`. Все 85 пар совпали у PR и upstream. Различия чисел внутри сообщений DB-тестов объясняются временем выполнения: миллисекундная дедупликация даёт разное число сохранившихся записей. Новых названий упавших тестов в PR нет.

Повтор выполнен на одном установленном Node `26.7.0` и Vitest `4.1.10`, с отдельными временными `DATA_DIR`. Установлены `RUN_REAL=0`, `RUN_LIVE_TESTS=0`; файл MiMo `*.live.test.js` исключён явно, поскольку upstream ещё не учитывает этот флаг.

| Повторный прогон | Всего | Passed | Failed assertions | Skipped | Файлов с ошибками загрузки |
|---|---:|---:|---:|---:|---:|
| Upstream | 2887 | 2744 | 84 | 59 | 6 |
| PR | 3044 | 2901 | 84 | 59 | 6 |
| Fork | 3499 | 3445 | 0 | 54 | 0 |

Повторные 84 падения снова полностью совпали. Единственное падение из исходных 85, которое не повторялось, — live chat MiMo. Во время повторного PR-прогона Vitest создал отсутствующий `golden-url-header` snapshot; этот сгенерированный файл после проверки удалён. Успешность этого snapshot-теста не используется как доказательство корректности прежнего эталона и не влияет на сравнение 84 падений. В полном прогоне fork 3445 passed включают **3432 обычных успешных теста и 13 проверок ожидаемого сбоя `it.fails`**. Поэтому зелёный suite не означает отсутствие известных ограничений.

Полные исходные отчёты находятся в `/private/tmp/9router-release-20260930/`; повторные — в `/private/tmp/9router-test-audit-20260930/`. Долговечные краткие результаты и SHA256 исходных отчётов включены в [summary.json](</Volumes/Askid Dev/Projects/Routers/9router/docs/audit/2026-09-30-upstream-test-failures/summary.json>), все 85 отдельных тестов — в [failures.json](</Volumes/Askid Dev/Projects/Routers/9router/docs/audit/2026-09-30-upstream-test-failures/failures.json>).

## Классификация всех 85 падений

| Причина | Число | Что имеет смысл делать |
|---|---:|---|
| Устаревшие ожидания контракта или политики | 63 | Обновлять assertions по действительному контракту. В fork это уже сделано; не возвращать прежнее поведение ради старого теста. |
| Мок не соответствует пути выполнения | 8 | Исправлять форму данных или точку перехвата. Runtime по этим падениям менять не требуется. |
| Старый транспорт CommandCode | 4 | В fork проверять действующий OpenAI-compatible маршрут. Для upstream отдельно проверить его native transport; удаление наших legacy-тестов переносить туда автоматически нельзя. |
| Устаревший `it.fails` | 2 | Положительное утверждение уже проходит; заменить ожидаемое падение обычной проверкой. Fork уже это делает. |
| Реальные дефекты upstream, исправленные в fork | 3 | Сохранить исправления и регрессионные проверки. При необходимости выделить отдельные upstream changes. |
| Потеря независимых событий usage | 3 | Исправлять идентичность событий в коде. Уникальные имена моделей в тестах не решают проблему. |
| Search auto-switch явно отключён | 1 | Решить, нужна ли функция, затем определить и проверить её контракт. |
| Внешний live endpoint MiMo | 1 | Оставить отдельным opt-in прогоном. Для диагностики провайдера потребуется свежий live ответ с телом ошибки. |
| **Всего** | **85** | |

## Разбор по файлам

Все файлы ниже имеют префикс `tests/`; число относится к assertions из исходного upstream JSON. Одна строка может включать несколько причин, которые разделены в `failures.json`.

| Файл | Число | Причина и состояние fork |
|---|---:|---|
| `translator/claude-kiro-direct.test.js` | 9 | Читается удалённый top-level `systemPrompt`, ожидаются прежние thinking tags. Актуальные инструкции находятся в `conversationState.currentMessage.userInputMessage.content`; native effort проверяется отдельно. Fork обновил проверки. |
| `unit/openai-to-kiro.test.js` | 19 | Та же смена Kiro payload плюс native thinking для поддерживаемых моделей. Часть названий тестов сохранилась, assertions уже проверяют актуальный контракт. |
| `unit/kiro-external-idp.test.js` | 1 | Первым base URL теперь идёт `q`, а `codewhisperer` остаётся следующим fallback. Устарело ожидание порядка. |
| `unit/kiro-terminal-integrity.test.js` | 2 | Мок содержит только два fetch-ответа, хотя failover делает дополнительные попытки. Fork задаёт ошибочный ответ для всех последующих попыток и проверяет ошибку SSE. |
| `unit/opencode-free-tool-choice.test.js` | 7 | Executor добавляет fingerprint tools к переданным tools. Тест требует прежнее точное равенство массива. Fork проверяет сохранение пользовательских tools и `tool_choice=auto`. |
| `unit/opencode-muse-spark-thinking.test.js` | 1 | Reasoning уже очищается корректно; assertion падает на добавленных fingerprint tools. |
| `unit/oauth-cursor-auto-import.test.js` | 8 | Изменились ответы route, список путей и manual fallback; SQL теперь использует точные ключи и `prepare().get()`, а не `all()` и fuzzy scan. Fork обновил fixture и ожидания. |
| `unit/cursor-models.test.js` | 1 | Мок `global.fetch` не перехватывает HTTP/2 Connect вызов. Fork перехватывает `http2`. |
| `unit/windsurf-executor.test.js` | 3 | Registry entry скрыта, executor использует собственные constants и `server.codeium.com`. Тесты ждут прежнюю registry entry и hostname. |
| `unit/codex-image-fetch.test.js` | 2 | DNS мок возвращает объект вместо массива адресов для `lookup({all:true})`; SSRF guard отклоняет fixture. Fork исправил форму мока. |
| `unit/image-fetch-hardening.test.js` | 1 | Та же неверная форма DNS мока в положительном PNG-сценарии. |
| `unit/image-generation.test.js` | 4 | Ожидается header `version: 0.154.0`, а текущий `CODEX_CLI_VERSION` равен `0.155.0`. В fork expectation обновлён. |
| `unit/claude-header-forwarding.test.js` | 1 | Тест требует `gotScraping`, хотя Anthropic route теперь идёт через native fetch. |
| `unit/force-stream-config.test.js` | 2 | В моке headroom отсутствует новый export `formatHeadroomSizeLog`; это ошибка fixture до проверки streaming. |
| `unit/executor-const-guard.test.js` | 1 | Для Antigravity 429 ожидаются 6 retries, registry задаёт 3. |
| `unit/combo-autoswitch.test.js` | 2 | Один тест сравнивает ссылку массива вместо сохранённого порядка; второй требует search auto-switch, который явно отключён в коде. Fork проверяет текущее отключённое состояние. |
| `unit/request-details-tab.test.js` | 2 | Включается несуществующий `enableObservability2`; актуальный setting — `enableObservability`. Details поэтому не записываются. Fork исправил fixture. |
| `unit/db-concurrent.test.js` | 3 | Миллисекундная дедупликация удаляет отдельные одинаковые запросы. Fork-тесты стали использовать разные модели и проходят, но код дедупликации не изменился. Это остающийся дефект. |
| `unit/security-audit.test.js` | 1 | Upstream использует полный API key в ключах публичного `byApiKey`. Fork хеширует ключи объекта; проверка с фиктивным ключом подтверждает исправление. Старый assertion в fork заменён проверкой нового способа защиты. |
| `translator/bugs-toClaude-context.test.js` | 1 | В upstream теряется assistant `reasoning_content`. В fork он становится Claude thinking block и переживает `prepareClaudeRequest`. |
| `translator/thinking-unified.test.js` | 1 | Upstream capabilities GLM-5.2 не разрешают `reasoning_effort`; запрошенный `low` исчезает. Fork сохраняет effort. |
| `unit/translator-helpers-edge.test.js` | 1 | Mid-conversation system text сохраняется в соседнем user turn для стабильного prompt prefix, а тест ждёт переноса в `body.system`. |
| `unit/translator-request-normalization.test.js` | 4 | Три assertions требуют строки вместо допустимого массива текстовых OpenAI content parts. Четвёртый вызывает NDJSON parser без обязательного `FORMATS.OLLAMA`. |
| `unit/openai-to-claude.test.js` | 1 | Tool arguments теперь буферизуются и очищаются при terminal chunk; fixture не содержит `finish_reason`. |
| `translator/bugs-claudeCode-context.test.js` | 1 | `it.fails` ожидает потерю image в tool result, но изображение уже сохраняется. Fork использует обычный `it`. |
| `translator/bugs-openai-bridge.test.js` | 1 | Второй тест той же исправленной image-loss проблемы с устаревшим `it.fails`. |
| `translator/bugs-gemini-cursor-commandcode.test.js` | 1 | Проверка image blocks старого native CommandCode envelope. В fork CommandCode-часть файла удалена, оставшиеся Gemini/Cursor проверки сохранены. |
| `unit/openai-to-commandcode.test.js` | 2 | Та же прежняя image shape в `/alpha/generate` transport. Fork удалил этот transport и эти tests. |
| `unit/commandcode-to-openai.test.js` | 1 | NDJSON error translator теперь бросает исключение, а тест ждёт error text как обычный content. Fork использует другой transport. |
| `unit/mimo-free.live.test.js` | 1 | Внешний chat endpoint ответил HTTP 400 вместо ожидаемого 200. Исходный JSON не содержит тело HTTP ошибки, поэтому причина 400 не установлена. В fork тест gated. |
| **Всего** | **85** | |

Крупные группы — Kiro 31, OpenCode 8, Cursor 9, Windsurf 3. Это не 51 независимая поломка runtime: большая часть assertions проверяет повторяющееся старое ожидание или один и тот же неверный mock.

## Дефект учёта usage который остаётся в fork

Путь выполнения: `streamingHandler` / `nonStreamingHandler` / `sseToJsonHandler` → [saveUsageStats](</Volumes/Askid Dev/Projects/Routers/9router/open-sse/handlers/chatCore/requestDetail.js:103>) → [saveRequestUsage](</Volumes/Askid Dev/Projects/Routers/9router/src/lib/db/repos/usageRepo.js:243>).

SQL проверяет совпадение timestamp с миллисекундной точностью, provider, model, connectionId, apiKey и чисел input/output tokens. Идентичность исходного запроса не участвует в сравнении. Два разных запроса с одинаковыми параметрами, завершившиеся в одну миллисекунду, считаются повторной записью одного события. Это уменьшает request counts и token totals; при ненулевой цене модели уменьшает и рассчитанную стоимость.

Проверка выполнена на настоящем SQLite adapter `node:sqlite` в отдельном временном `DATA_DIR`; сетевые провайдеры не вызывались. Timestamp фиксирован внутри отдельного процесса, чтобы воспроизвести одновременное завершение без случайной зависимости от скорости машины.

| Сценарий | Независимых событий | Сохранено в upstream | Сохранено в fork |
|---|---:|---:|---:|
| Одинаковая модель и tokens, одна миллисекунда | 2 | 1 | 1 |
| То же для 100 независимых событий | 100 | 1 | 1 |
| Контроль с разными миллисекундами | 100 | 100 | 100 |
| Вызов действительного handler helper `saveUsageStats` | 2 | 1 | 1 |

Исходные три concurrency tests показывали эту коллизию, хотя называли проблему потерей данных при параллельной записи. Сама SQLite transaction атомарна; проблема в неверном критерии дедупликации. Замена модели на `gpt-4-${i}`, `m-${i}` и `gemini-pro-${i}` устраняет совпадение ключей в fixture, но также убирает проверку отдельных одинаковых запросов.

Предлагаемое исправление после решения пользователя: передавать стабильный request identity от входящего запроса до конечной записи usage. Повторное событие одного requestId должно быть идемпотентным; разные requestId должны сохраняться независимо от совпадения времени, модели и tokens. Нужны проверки обоих сценариев, включая stream и JSON пути. Простое отключение дедупликации может вернуть двойной учёт одного запроса; добавление случайного значения только в тест также не решает production contract.

Частота такой коллизии на production и объём исторически потерянного usage не измерялись. Этот отчёт подтверждает дефект текущего кода и локального пути выполнения, а не утверждает размер ущерба на сервере.

## Реальные дефекты upstream уже устранённые в fork

| Дефект | Чистый upstream | Текущий fork | Проверка |
|---|---|---|---|
| API key в статистике | Фиктивный полный key виден в JSON `getUsageStats` | Полного key нет; ключи `byApiKey` хешируются | Периоды `24h`, `today`, `7d`, `all`; действительный `getUsageStats` |
| Assistant reasoning при OpenAI → Claude | `reasoning_content` исчезает | Сохраняется как thinking block | Действительный `translateRequest`, включая `prepareClaudeRequest` |
| GLM-5.2 effort | Запрошенный `low` удаляется | Передаётся `low` | Действительный `applyThinking` с provider `glm-cn` |

Не стоит заменять эти проверки более слабыми assertions ради зелёного upstream. Проверка секретов должна анализировать сериализованный DTO целиком; поиск строки в source не доказывает защиту всех полей и периодов. Здесь подтверждено поведение с фиктивным ключом; реальные credentials не использовались.

## Ещё 6 ошибок вне счётчика 85

`numFailedTests` считает упавшие assertions. Файл, который не собрал ни одного Vitest-теста, может иметь status `failed`, но не увеличивает это число. `numFailedTestSuites=69` в исходном JSON также нельзя читать как «69 упавших файлов»: в него входят вложенные `describe`.

| Файл | Причина | Состояние fork |
|---|---|---|
| `tests/auth/saml.test.js` | Используется `node:test`, а не Vitest. Отдельный plain Node запуск также требует настройки source aliases. | Переведён на Vitest. |
| `tests/unit/cline-auth.test.js` | `node:test`: Vitest сообщает `No test suite found`. | Переведён на Vitest. |
| `tests/unit/kimchi-strip-reasoning.test.js` | Та же несовместимость runner. | Переведён на Vitest. |
| `tests/unit/kimchi.test.js` | Та же несовместимость runner; дополнительно устарело `category=oauth`. | Vitest и актуальная `category=freeTier`. |
| `tests/unit/db-benchmark.test.js` | Legacy benchmark требует `lowdb`, которой нет в текущих dependencies. | Старый benchmark удалён. |
| `tests/unit/embeddings.cloud.test.js` | Импортируется отсутствующий `cloud/src/handlers/embeddings.js`. | Неактуальный cloud test удалён. |

Четыре `node:test` файла дополнительно запущены родным runner с настроенными aliases: **38 tests, 37 passed, 1 failed**. Единственный assertion failure — Kimchi `oauth` против действительного `freeTier`. Следовательно, эти collection errors в основном отражают конфигурацию runner, но за ними может скрываться обычное устаревшее утверждение. Тесты Kimchi частично используют копии pure functions; этот прогон не доказывает работоспособность всего OAuth service.

## Что предлагается лечить

1. **В нашем fork сначала исправить usage identity.** Это подтверждённый остающийся дефект. Сохранить атомарные SQLite writes и идемпотентность повторной записи одного запроса; вернуть сценарий разных одинаковых запросов в проверки.
2. **Для чистого upstream оформить обслуживание тестов отдельно.** В первую очередь Kiro payload, DNS и HTTP/2 mocks, missing headroom export, OpenCode fingerprint tools, Codex version и настройку runner. Крупные группы можно перенести из fork после проверки diff; новые тесты должны сохранять положительные и отрицательные сценарии.
3. **Сохранить три исправления runtime fork.** Если цель — помочь upstream, выделить их отдельно от адаптера ChatGPT. Их нельзя заменить правкой ожиданий.
4. **Search auto-switch рассматривать как отдельную функцию.** В коде он явно отключён; зелёный fork-тест фиксирует это состояние. Решение о включении требует определения native search capabilities и взаимодействия с нашим hosted search.
5. **MiMo проверять отдельным live прогоном по необходимости.** По HTTP status 400 без тела нельзя выбрать между изменением внешнего API, неподходящей fixture и дефектом executor.

13 существующих `it.fails` fork находятся вне этих 85 падений. Они касаются image/audio и tool-result metadata, отдельных Gemini/Cursor/Kiro ограничений и особенностей Codex/Claude переводов. Их следует разбирать отдельным списком, если цель расширится до устранения всего известного долга. Семантика [`test.fails` в Vitest](https://vitest.dev/api/test.html#fails): тест зелёный, когда его тело падает; если тело перестало падать, тест становится красным. Это объясняет два ложных красных image-теста и отдельно ограничивает смысл общего passed count.

## Воспроизводимость и пределы проверки

[probe-runtime.mjs](</Volumes/Askid Dev/Projects/Routers/9router/docs/audit/2026-09-30-upstream-test-failures/probe-runtime.mjs>) использует исходные функции записи и перевода без моков их логики. Node hooks только разрешают aliases и расширения файлов, которые обычно обрабатывает bundler. Скрипт создаёт новый временный `DATA_DIR`, использует фиктивный key и не обращается к provider endpoints.

```sh
/opt/homebrew/bin/node docs/audit/2026-09-30-upstream-test-failures/probe-runtime.mjs \
  '/Volumes/Askid Dev/Projects/Routers/9router' /tmp/probe-fork.json

/opt/homebrew/bin/node docs/audit/2026-09-30-upstream-test-failures/probe-runtime.mjs \
  /private/tmp/9router-upstream-baseline-20260930 /tmp/probe-upstream.json
```

[analyze-reports.py](</Volumes/Askid Dev/Projects/Routers/9router/docs/audit/2026-09-30-upstream-test-failures/analyze-reports.py>) проверяет совпадение наборов 85 и 84, сумму классификации и успешность повторного fork suite, затем формирует два JSON-артефакта. Это проверка инвентаризации; она сама по себе не доказывает правильность экспертной классификации — её основания изложены выше и подтверждены исходниками и отдельными probes.

```sh
python3 docs/audit/2026-09-30-upstream-test-failures/analyze-reports.py \
  /private/tmp/9router-release-20260930 \
  /private/tmp/9router-test-audit-20260930 \
  docs/audit/2026-09-30-upstream-test-failures
```

Точные команды трёх повторных прогонов, их revisions, counts, durations, 85 отдельных cases и результаты probes сохранены в JSON-артефактах. Сырые временные отчёты могут быть удалены системой; SHA256 и компактные результаты остаются в репозитории. Из исходников продукта и существующих тестов ничего не менялось. Production runtime, deployed image, реальная нагрузка и актуальное состояние внешних провайдеров в этом анализе не проверялись.
