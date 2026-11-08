# Обновление 9router v0.5.116 — 2026-11-08

Upstream `1339107e624d1ab150c6a0c2c2ee22caa7e9db2f` объединён с fork `21f51357`. От общего предка `1fe586bb` — 29 upstream-коммитов, 95 изменённых файлов. Разрешены 12 конфликтующих файлов. Backup branch: `codex/backup-before-v0.5.116-20261108-21f51357`.

Источник: [upstream diff](https://github.com/decolua/9router/compare/1fe586bb...1339107e), [changelog](https://github.com/decolua/9router/blob/1339107e/CHANGELOG.md). Проверки: [verification.json](audit/2026-11-08-upstream-v0.5.116/verification.json).

## Изменения и сохранение fork

- Включены актуальные endpoints OpenCode Go, исправления thinking/tool-result turns, Gemini tool history и MIME, DashScope cache markers, MCP tool references, Argon quotas, native Codex Images/GPT Image 2.6, SenseNova, TTS voices, web fetch formats и CLI/runtime.
- CommandCode остаётся на `/provider/v1/chat/completions` через DefaultExecutor. Приняты headers CLI 1.88.5, passthrough и auto-import; удалённый legacy NDJSON executor не восстановлен. Новая live-проверка upstream для `/alpha/generate` не включена: она импортирует удалённый executor и проверяет другой transport. Наши проверки официального API сохранены.
- Сохранены Responses/tool-schema normalization и routing при большом числе tools, reasoning, tool-history reconciliation, Combo affinity/concurrency/cancellation/deadlines, repetition guard, registry providers, каталог моделей, ручные caps/selection и pricing provenance.
- Antigravity получил отдельные Argon buckets с сохранением наших registry aliases, фильтрации устаревших квот и выбора актуального reset.
- Codex Image сохраняет provider/model/cost metadata в JSON и SSE, включая новый native Images transport.

## Исправленные риски

1. CommandCode auto-import добавлен в local-only и always-protected маршруты. Удалённый dashboard JWT не даёт права читать секрет хоста. Ответ с ключом имеет `Cache-Control: no-store`.
2. CodeBuddy заменяет маркеры идентичности внутри текста, сохраняя остальные system/developer инструкции, в том числе ограничения доступа и удаления данных.
3. Add All Active Models использует существующий `selectedModelIds`: пустой allowlist не становится unrestricted, смешанные подключения сохраняют прежнюю семантику. Исключены catalog-only записи, их aliases и placeholders; подключены provider nodes для keyless compatible моделей.
4. Транспорт не добавляет собственный повтор POST после потери ответа или headers timeout. Сохранена существующая retry policy executor; её повтор использует свежий socket. Read-only replay разрешён только для GET/HEAD без тела. Fresh dispatcher отключает keep-alive через `pipelining: 0`.
5. При переходе на undici 8 сохранены pool limits, request-scoped Flex/Combo timeouts, proxy context, strict-proxy и проверка сертификатов по умолчанию. `strictTls`/обязательный proxy запрещают insecure fallback. Для HTTP proxy явно сохранён CONNECT.
6. Реальный loopback-тест выявил несовместимость Node FormData с undici 8: тело становилось строкой. Общая граница fetch преобразует его в FormData той же копии undici, сохраняя файлы и имена. Multipart проверен напрямую и через CONNECT proxy.
7. DeepSeek budgets разрешены на совместимом Chat endpoint; Responses endpoint сохраняет прежний OpenAI wire format и ручные capability overrides.

## Проверки

- Исходный fork: 5836 tests, 5718 passed, 7 failed, 14 expected fail, 96 skipped, 1 todo.
- После merge: 6036 tests, 5919 passed, 7 failed, 13 expected fail, 96 skipped, 1 todo; 559 файлов. Новых failures и ошибок загрузки suites нет. Все семь test identities совпадают с исходным fork.
- Сохранившиеся baseline failures: `combo-credit-fallback` (1), `headroom-responses-format` (1), `models-custom-bulk` (4), `security-audit` (1). Они не объявлены исправленными и не скрыты дополнительными skips.
- Регрессии рисков сначала воспроизведены падающими тестами. После исправлений проходят guards, prompts, model selection, native Images, реальные HTTP resets, multipart/CONNECT/relay и per-request dispatchers.
- Providers baseline: 110 providers; aliases: 148 tokens; OAuth URLs — без изменений.
- Production webpack build и standalone assets прошли. Локально: Node 22.23.4, Next 16.4.3, undici 8.12.4 (диапазон upstream `^8.12.3`). Реальный undici включён в standalone tracing.
- ESLint изменённых production JS: новых errors нет. Единственный `react-hooks/set-state-in-effect` в GenericExampleCard воспроизведён на исходном HEAD (строка 82 → 89, прежний `setLocalEndpoint` в effect).
- Собранный standalone на loopback с отдельным DATA_DIR прошёл `test-chatgpt-integration.mjs --disposable`: selection → bridge → HTTP server → translator → fixture provider, tools, legacy/v2/repeated compaction, decoded continuation, separate auth и downloadable installer. Внешний Codex CLI не запускался.
- На том же standalone: health, models catalog/caps, dashboard/models, три JS assets, public local-device voices и четыре remote auto-import запрета (`requireLogin` on/off × JWT present/absent). Реальные auth-файлы CommandCode не читались.
- `git diff --check` прошёл. Исходный untracked `.zcode/` не менялся.

## Деплой — 2026-11-08

Коммит `4ef0c7a490b7271b2e973c5bcc495303fb127f7a` отправлен в `origin/master` и развёрнут на `omni-fr` / [публичном endpoint](https://omni-fr.archteam.org). Production использует exact image `sha256:1261ba3f9db3a11dffb75309a3fcb918532b2291bcf0013b54a32ff7d96aeaa0`, tag `9router-local:upstream-v0.5.116-20261108-4ef0c7a4`, с revision label проверенного source commit. Архив содержит только Git-tracked файлы; его SHA-256: `d6fdc5e97fee7cca7f478c2c894e67762c0600e97c2c90a4aeaf5a980ba401bc`.

Образ собран, пока прежний контейнер продолжал обслуживать запросы. В нём Node 22.23.4, Next 16.4.5, undici 8.12.4. Next разрешился в рамках существующего диапазона зависимостей; acceptance выполнен именно на этом Docker image.

До cutover exact image прошёл QA на согласованной копии production SQLite с `--network none`. Проверены:

- HTTP Chat SSE/JSON, affinity, per-account concurrency, Combo spill и освобождение slots после cancellation;
- embeddings, WAV/PCM TTS и обязательный proxy без direct fallback;
- upstream SSE errors, registry, baked lazy-runtime dependencies и MiniMax lease через fake broker;
- собранные HTTP-маршруты CodeBuddy с сохранением system/developer инструкций и GPT Image 2.6 с provider/model metadata в SSE/headers; upstream — loopback relay с фиктивными credentials;
- четыре remote запрета CommandCode auto-import, настоящий multipart с undici 8, scoped timeouts и CONNECT;
- ChatGPT bridge, tools, legacy/v2/repeated compaction, decoded continuation и separate auth;
- management API, dashboard/models, dashboard/combos, dashboard/cli-tools и соответствующие JS/CSS assets.

QA fixtures удалены из копии; её protected configuration совпала с исходной. После проверки QA-контейнер удалён. Receipts: [qa-result.json](audit/2026-11-08-upstream-v0.5.116-deploy/qa-result.json), [release.json](audit/2026-11-08-upstream-v0.5.116-deploy/release.json).

Cutover дождался завершения активного запроса: `active=1,pending=1 → active=0,pending=0`. Health восстановился за 10.36 секунды. Сохранены 55 connections, 17 API keys, 13 combos, nodes, ручные caps/selection/names/pricing, proxy URLs и привязки. `Config.Env`, весь `HostConfig`, mounts и ports совпадают с прежним контейнером. После старта прошли local и public HTTPS management/UI smoke, включая публичный запрет импорта секретов с JWT и без него. `restartCount=0`, SQLite `quick_check=ok`, fatal log markers отсутствуют.

Во время сборки pre-cutover guard остановил первую попытку до остановки production: штатный free-proxy sync обновил health десяти managed pools. URL и привязки не менялись. После старта наблюдался один автоматический переход `autoDisabled`; сохранность ручного включения проверена по семантике существующего sync (`isActive || autoDisabled`). Health наблюдения не считаются пользовательской конфигурацией.

Также сохранился включённый пользователем автоматический catalog sync: он обновил автоматические цены и timestamps provenance. Ручные/legacy цены, source/url/verified provenance и состав каталога проверены отдельно и сохранены. Политика сравнения записана в [production-result.json](audit/2026-11-08-upstream-v0.5.116-deploy/production-result.json); [health-drift.json](audit/2026-11-08-upstream-v0.5.116-deploy/health-drift.json) фиксирует ожидаемые health изменения.

Rollback container: `9router-before-upstream-v0.5.116-20261108-4ef0c7a4` (остановлен, прежний image сохранён). Перед стартом нового контейнера создан consistent SQLite backup и сохранён полный container config: `/root/9router-releases/upstream-v0.5.116-20261108-4ef0c7a4/backup`. Receipts: [deployment-result.json](audit/2026-11-08-upstream-v0.5.116-deploy/deployment-result.json), [smoke-after-cutover.json](audit/2026-11-08-upstream-v0.5.116-deploy/smoke-after-cutover.json).

## Ограничения

Live inference checks внешних/платных провайдеров не запускались. Семь исходных failures полного suite остаются. CLI launcher проверен тестами; npm-пакет не публиковался. Корневой package-lock остаётся ignored согласно правилам репозитория. Исходный untracked `.zcode/` не изменён.
