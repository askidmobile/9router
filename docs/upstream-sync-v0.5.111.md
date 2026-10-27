# Обновление 9router v0.5.111 — 2026-10-27

Upstream `3a978a63` (v0.5.111, 2026-10-26) объединён с fork `19655afe` поверх v0.5.109. 17 upstream commit, 56 изменённых upstream файлов. История и наши доработки сохранены; backup branch: `codex/backup-before-v0.5.111-20261027`.

Источники: [release](https://github.com/decolua/9router/releases/tag/v0.5.111), [compare](https://github.com/decolua/9router/compare/v0.5.109...v0.5.111). Проверки: [verification.json](audit/2026-10-27-upstream-v0.5.111/verification.json).

## Изменения upstream

- Ollama Local: Phonon TTS и embedding adapter, каталог моделей, нормализация host и опциональный API key.
- Runcrate и Kimi K3.1 Pro для CommandCode / OpenCode Go.
- OpenCode Free: TLS fingerprint transport через опциональный wreq-js, timestamp sessions и env marker; совместимые tool definitions нормализуются без переименования. DeepSeek Free CTX ограничен 330000.
- Pi: Apply сохраняет ручные имена и лимиты; в карточке появились CTX/OUT selectors.
- Headroom сохраняет native Claude PDF, подписанные thinking blocks, citations и tool history; tool-result image_url переводится в Claude images.
- DeepSeek исправляет upstream ID; OpenAI Compatible сохраняет effort max для GPT-5.6/6; Haiku 5+ сохраняет adaptive thinking.
- Codex image_generation использует gpt-6-sol; каталог image aliases обновлён upstream.

## Сохранение fork

Разрешены 10 конфликтующих файлов. Сохранены requestPolicy с отменой, deadline и dispatcher timeouts, строгая per-provider proxy policy, ручные reasoning overrides, специфичные provider effort enums, budget behavior старых Opus/Sonnet, собственные providers (включая Respan и OrcaRouter), каталоги, цены, metadata и порядок registry. Общие завышенные лимиты CommandCode не восстановлены.

TLS adapter вызывается только после разрешения proxy policy; выбранный proxy имеет приоритет. Исправлено расхождение upstream с обещанным fallback: отсутствие опционального TLS runtime допускает native fetch, ошибка уже начатого TLS request не вызывает такой replay. Тесты проходят через настоящий BaseExecutor/proxyAwareFetch с контролируемыми transport fixtures.

Kimi K3.1 Pro в CommandCode получила точечный native thinking override. Публичный `https://api.commandcode.ai/provider/v1/models` подтвердил context_length 1048576; maxOutput 131072 унаследован из Kimi family, отдельным live output probe не подтверждён. Неизвестным CommandCode-моделям общий 1M/384k fallback не возвращён.

Новый Ollama TTS fallback без сохранённых credentials также получает resolveConnectionProxyConfig: отсутствие выбранного обязательного proxy не разрешает прямой запрос. Добавлена regression-проверка HTTP handler; финальный Docker image дополнительно проверяет этот сценарий через настоящий HTTP endpoint.

Account affinity / concurrency, Combo routing, ClinePass, model metadata persistence, балансы и quota layout сохранены. Их существующие regression suites включены в полный прогон.

## Проверки перед деплоем

- До: 5206 passed + 14 expected fail, 3 failed, 96 skipped, 1 todo, 495 test files.
- После: 5294 passed + 14 expected fail, те же 3 failed, 96 skipped, 1 todo, 508 test files. Новых failing assertions нет.
- Исходные failures: combo-credit-fallback (общий 400), headroom-responses-format (устаревшее ожидание skip), security-audit (source-string assertion маскировки). Они не объявляются исправленными.
- В промежуточном полном прогоне были дополнительные сбои bridge/proxy и native SQLite ABI. Без изменения их кода отдельный recheck прошёл: 58/58; последующий полный прогон вернулся к трём исходным failures.
- Production build + standalone assets прошли на Node 22.17.1 / Next 16.4.3. Docker image проверяется отдельно.
- ESLint: 2 ошибки react-hooks/set-state-in-effect в TtsExampleCard до и после, новых ошибок нет. git diff --check прошёл.
- Registry baseline: 107 providers; alias baseline: 141 tokens; OAuth URLs без изменений. Приняты только Runcrate и Ollama TTS catalog additions.
- Добавлены проверки Pi POST на mock filesystem и OpenCode transport на реальном executor/proxy path. Снимки обновлены только для рассмотренных Respan/Runcrate entries и версии Kimi header.

## Деплой

На omni-fr / [публичный endpoint](https://omni-fr.archteam.org) развёрнут source commit `566d69529f18acdfb9391a4cf58710ea23c6a1aa`. Merge commit: `eb636f18`; provider baseline: `bfea5ff0`; TTS proxy-policy repair: `566d6952`. Все отправлены в origin/master. Последующие изменения отчёта не меняют runtime.

Exact image: `sha256:ae8af78e1e46f692d6b8dbf5e549ee321bd4e030ad957217c7e82fe88074ea7c`, tag `9router-local:upstream-v0.5.111-20261027-566d6952`. Docker build выполнен штатным Dockerfile, Node 22.23.4 / Next 16.4.3.

До переключения image проверен на consistent SQLite copy с `--network none`: восемь management API, dashboard Models/Combos, provider asset и 17 JS/CSS с побайтной сверкой; 13 HTTP routing calls проверили A/A/B saturation, re-pinning, Combo capacity spill, cancellation и сохранение лимита concurrency. Три controlled HTTP media calls проверили embeddings, WAV и PCM. Дополнительный HTTP request подтвердил отказ при отсутствии обязательного proxy у default-host TTS fallback. Реальные Ollama/Phonon service и hardware не использовались.

Переключение выполнено при `active=0, pending=0`. Health восстановился за **5.45 секунды**. После переключения API, страницы и 17 assets прошли те же проверки локально и через публичный HTTPS. `restartCount=0`, SQLite `quick_check=ok`, fatal runtime log markers не обнаружены.

На cutover полные protected configuration fingerprints совпали: **50 connections, 15 API keys, 12 combos**, provider nodes, bound proxy pools, provider strategies, modelCaps/pricing/customModels/disabledModels/modelNames/modelAliases/mitmAlias. Environment, mounts и port bindings контейнера сохранены. Секреты, БД и исходные credential snapshots не включены в repository receipts.

При последующей проверке сработала существующая free-proxy autosync: у 10 привязанных managed proxy обновились health-поля (lastTestedAt, latencyMs, exitIp, lastError и updatedAt); один ранее автоматически выключенный proxy восстановился и получил active. Код этого scheduler не менялся. Сравнение строк с backup подтвердило неизменность proxy URL, настроек, strict policy, provider bindings и всех полей вне исчерпывающего списка health-обновлений. Другие изменения model catalog рассмотрены отдельно ниже. Изменения штатного health не откатывались. [Proxy health reconciliation](audit/2026-10-27-upstream-v0.5.111-deploy/proxy-health-result.json).

Через три минуты после старта ранее включённая `settings.catalogSyncProviders` автосинхронизация обновила pricing у opted-in Cheaper и добавила четыре новых catalogOnly entries: gpt-6.1-terra-fast, gpt-6.1-sol-pro, gpt-6.1-terra, gpt-6-sol-pro. Код sync/import не менялся. Сравнение с backup подтвердило отсутствие удаления/изменения существующих customModels, неизменность modelCaps, names/aliases, selection и других protected scope. Синхронизированные цены не объявляются побайтно неизменными и не возвращались к устаревшим значениям. [Catalog reconciliation](audit/2026-10-27-upstream-v0.5.111-deploy/catalog-refresh-result.json).

Дополнительная ограниченная production probe `oc/deepseek-v4.1-flash-free` через существующую provider policy вернула **HTTP 429 за 1.11 секунды**; успешная live inference этим обновлением не подтверждена. Настройки proxy ради этой probe не менялись; платные модели не запрашивались. UI проверен HTTP/assets acceptance, отдельная визуальная browser regression не проводилась.

Rollback container: `9router-before-upstream-v0.5.111-20261027-566d6952`. Consistent backup и исходная конфигурация: `/root/9router-releases/upstream-v0.5.111-20261027-566d6952/backup`. Старый production image/container сохранены. Временный QA container, QA database copies и промежуточный образ удалены.

Receipts: [release](audit/2026-10-27-upstream-v0.5.111-deploy/release.json), [offline QA](audit/2026-10-27-upstream-v0.5.111-deploy/qa-result.json), [cutover](audit/2026-10-27-upstream-v0.5.111-deploy/deployment-result.json), [production / public HTTPS](audit/2026-10-27-upstream-v0.5.111-deploy/production-result.json), [free probe](audit/2026-10-27-upstream-v0.5.111-deploy/live-result.json).
