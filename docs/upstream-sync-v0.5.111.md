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

Account affinity / concurrency, Combo routing, ClinePass, model metadata persistence, балансы и quota layout сохранены. Их существующие regression suites включены в полный прогон.

## Проверки перед деплоем

- До: 5206 passed + 14 expected fail, 3 failed, 96 skipped, 1 todo, 495 test files.
- После: 5293 passed + 14 expected fail, те же 3 failed, 96 skipped, 1 todo, 507 test files. Новых failing assertions нет.
- Исходные failures: combo-credit-fallback (общий 400), headroom-responses-format (устаревшее ожидание skip), security-audit (source-string assertion маскировки). Они не объявляются исправленными.
- В промежуточном полном прогоне были дополнительные сбои bridge/proxy и native SQLite ABI. Без изменения их кода отдельный recheck прошёл: 58/58; последующий полный прогон вернулся к трём исходным failures.
- Production build + standalone assets прошли на Node 22.17.1 / Next 16.4.3. Docker image проверяется отдельно.
- ESLint: 2 ошибки react-hooks/set-state-in-effect в TtsExampleCard до и после, новых ошибок нет. git diff --check прошёл.
- Добавлены проверки Pi POST на mock filesystem и OpenCode transport на реальном executor/proxy path. Снимки обновлены только для рассмотренных Respan/Runcrate entries и версии Kimi header.

## Деплой

Серверная сборка, изолированная acceptance и переключение фиксируются после выполнения. Production данные и credentials не включаются в repository receipts.
