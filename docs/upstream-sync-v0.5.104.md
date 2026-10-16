# Обновление 9router v0.5.104 — 2026-10-16

Upstream v0.5.104 объединён с нашим fork с сохранением истории. Изменение подготовлено и проверено локально; push и production-деплой не выполнялись.

Исходный fork: `fc49692f`. Предыдущая upstream-база: `ce4460ef` (v0.5.99). Целевой upstream: `87a74e1b` (v0.5.104), 38 commits, 140 изменённых файлов. Резервная ветка: `codex/backup-before-v0.5.104-20261016`.

Источники: [upstream compare](https://github.com/decolua/9router/compare/v0.5.99...v0.5.104), [upstream changelog](https://github.com/decolua/9router/blob/87a74e1b/CHANGELOG.md). Проверки: [verification.json](audit/2026-10-16-upstream-v0.5.104/verification.json).

## Что добавлено

- Nous Research: OAuth Device Code, API key, бесплатные модели, обновление токенов и attribution tags.
- Cursor: квоты через DashboardService, разрешение Auto в модель аккаунта, восстановление длинных сессий и strict proxy для AgentService HTTP/2.
- Quota: расписания auto-ping по местному времени, DST и режимы Off / On reset / Schedule. При редактировании сохраняется часовой пояс существующего расписания.
- Выбор моделей: regex, исключения, фильтрация провайдеров и пакетный выбор. В наших редакторах Combo, Vision/Audio adapter, media combo и API key allow-list добавлены атомарные batch callbacks. В CLI-формах без такого callback сохранён индивидуальный выбор; кнопки массовых действий там скрыты.
- Gemini 4 Argon для Google AI Studio и Vertex, корректный project/location, очистка sampling parameters и порядок functionResponse. Наши Antigravity tiers, Gemini Flex и native endpoint сохранены.
- OpenCode Zen/Go: free-tier identity, multi-turn reasoning_content, Haiku 5.5 adaptive thinking и очистка неподдерживаемого response_format.
- Combo fallback при незавершённом JSON-ответе без содержимого; forced-SSE JSON корректно возвращается Claude-клиенту с нашими provider/model/cost metadata.
- Copilot embeddings endpoint, Qoder add-on quotas, учёт input_tokens/output_tokens в статистике, обновление Antigravity IDE fingerprint и portal для подсказок/меню прокси.
- Удалены upstream registry entries для устаревших Codex GPT-5.5 / image variants; пользовательские настройки не мигрируются и не удаляются.

Upstream добавление token quotas и pattern access для API keys было отменено самим upstream до v0.5.104; оно не включено в итоговый код.

## Сохранение наших доработок

31 конфликт разрешён по действующим контрактам. Сохранены private-ID masking и envelopes ClinePass; явная per-provider proxy policy и запрет direct fallback; provider/model/cost accounting; Combo cancellation, recovery, circuit health, conservative caps и индикация отключённых участников; Codex catalog/history/compaction/namespaces; ручные имена, capabilities, reasoning, selection и pricing; наши балансы и quota snapshots.

OpenCode Free сохранён на нашей уже развёрнутой реализации 2.0.29: `/inference/openai/v1` и `/inference/anthropic/v1`, настоящие CLI schemas, стабильные sessions, восстановление имён tools и истории. Upstream 2.0.26 с `/inference/v1` не заменял более новую реализацию. Совместимый `reasoningInject` перенесён.

Сохранён наш conservative default для неизвестных CommandCode-моделей; provider-specific Haiku 5.5 использует явные upstream limits. Не откатывалась наша adaptive Haiku 5.5 поддержка у других провайдеров.

Дополнительно устранены обнаруженные при интеграции дублирование Argon High, смена Antigravity default, потеря batch selections из-за последовательных React state updates и замена сохранённого timezone локальным. При ошибке загрузки connections picker сохраняет переданный список и отменяет устаревший результат после закрытия.

Незакоммиченная пользовательская правка `CLAUDE.md` проверена по SHA-256 и исключена из commit. Рабочие данные production и реальные provider credentials не использовались.

## Проверки

- До обновления: **4538 passed, 0 failed, 96 skipped, 1 todo**, 437 test files.
- После обновления: **4755 passed, 0 failed, 96 skipped, 1 todo**, 457 test files. Финальный полный прогон выполнен после последних изменений кода.
- Production build и standalone asset copy прошли на Node 22.17.1 / Next 16.3.0.
- Provider baseline: 98 providers; alias baseline: 136 tokens; OAuth URLs без изменений. Snapshots обновлены только для рассмотренных registry changes, версии headers и Nous.
- Lint изменённых файлов: 22 ошибки до и после, новых нет. Прежние ошибки React hooks не исправлялись в рамках обновления.
- В браузере на standalone build: regex `/gpt-6/` нашёл 7 моделей; Select All и Deselect All обработали все 7; `codex -review` дал 15 моделей без review. Расписание сохранило `Pacific/Honolulu`, anchor `09:00`, window 5h и 2 слота при timezone браузера `Europe/Moscow`. Console errors: 0.
- На отдельной тестовой SQLite без provider credentials `/v1/models` вернул HTTP 200 и 32 модели, включая 4 OpenCode no-auth entries.

В одном промежуточном прогоне одновременно со сборкой проявилась существующая timing race `zcode-protocol.test.js` (`replies.json` ещё не создан). Тест и соответствующий код не менялись; два последующих полных прогона прошли. Существующий native `better-sqlite3` имеет другой ABI; штатный `node:sqlite` fallback успешно использован при сборке и QA.

Live inference, настоящий OAuth login, публикация npm, Docker image и production-проверки не выполнялись. Локальные проверки не подтверждают доступность внешних аккаунтов и моделей на production.
