# Отслеживание квот: реализация и production-приёмка

14 октября 2026 года на `omni-fr` развёрнут commit `d396e23426f088bc9c15d5aa3d9fe3b582870538`. Image: `sha256:77f557f60519784d79a491c32abde49f1ea1ecc8085f7ab2375088d9b3114318`. Состав работ основан на [анализе активных провайдеров](quota-provider-audit-2026-10-14.md).

## Результат

- OpenRouter показывает денежный остаток отдельной строкой, как DeepSeek, без процента, знаменателя `∞` и пустой даты. Нулевой/отрицательный баланс сохраняется. Лимит ключа использует upstream `limit_remaining`, периодические расходы — соответствующее окно; недельный reset относится к UTC-понедельнику. Бесплатные запросы берутся из `free_model_daily_requests`, а не локального счётчика всех запросов. Исправлен free-tier ReferenceError.
- Добавлены APInex, Requesty, Kilo Code, Jina AI, Jina Reader и Cheaper Inference. APInex разделяет доступные средства, резерв и RPM; Requesty показывает месячный расход и лимит собственного ключа; Jina показывает токены, trial и paid, без передачи личных полей ответа в UI.
- Kenari работает с существующими custom connections, без миграции аккаунтов. Источник выбирается только для точного HTTPS origin `kenari.id`; credentials других custom узлов туда не отправляются. Доступны IDR-баланс, резерв, подписочные окна и истечение купона.
- Command Code показывает кредитный баланс отдельно от 5h/weekly окон. GLM сохраняет процентные окна и добавляет абсолютные кредитные остатки, когда они есть в ответе.
- Заголовки реальных chat JSON/SSE ответов Groq, Anthropic, Nebius и Cerebras, а также ответов Brave Search сохраняются в существующем SQLite `kv` scope `providerQuota`. Миграция схемы не нужна. Снимки имеют model/window и время наблюдения, переживают перезапуск и удаляются вместе с connection. По истечении reset данные становятся неизвестными, а не автоматически 100%. Synthetic inference/search для опроса лимитов не выполняется.
- Cloudflare GraphQL errors больше не превращаются в полную квоту. Ollama явно сообщает, если ответ содержит статистику без подтверждённых подписочных лимитов. Нехватка reporting permission отображается сообщением.
- Общие quota presentation flags проходят через нормализатор; старый browser quota cache заменён `quotaCacheDataV2`. Компоненты и формы сохранены. URL с query credentials исключён из TLS diagnostic logging.

## Проверки

141 целевой unit test в 18 файлах прошёл: account dispatch/normalization, отрицательные и нулевые балансы, free-tier, частично запрещённый OpenRouter balance API, whitelist custom origin, malformed data и privacy, заголовки и реальные search handler calls, expiry/persistence, существующие OAuth/quota/tool/usage сценарии. Локальная и серверная production-сборки прошли.

Новый код прошёл targeted ESLint. Полный targeted UI lint продолжает находить два существовавших до правки `react-hooks/set-state-in-effect` в pagination effects `QuotaTable.js`, а также прежнее предупреждение о `expiringFirst` dependency. Два errors воспроизведены на исходнике `HEAD` до изменений. Эти эффекты не изменялись.

Финальный image проверен через настоящие HTTP endpoints на консистентной копии production SQLite в контейнере с `network=none`. Upstream ответы заменялись fixtures до загрузки приложения; реальные credentials не отправлялись провайдерам. Проверены:

- runtime health, dashboard/API auth, models, ChatGPT manifest и helper;
- namespace custom/обычные tools через JSON и SSE, включая следующий ход с результатом инструмента;
- новые quota endpoints, eligibility и проход только разрешённых метрик;
- Cloudflare/Ollama unknown states и Cheaper scope error;
- получение Groq headers через настоящие compiled JSON/SSE chat routes;
- чтение сохранённого header snapshot после перезапуска того же QA image.

## Деплой и live-проверка

Архив исходников создан из Git commit и проверен по SHA256; image label совпал с source revision. Переключение выполнено после свежего `active=0`, `pending=0`. Health восстановился за 4,4 секунды. Runtime environment, mounts, port bindings и fingerprints сохранённой конфигурации совпали. SQLite backup прошёл `quick_check`; архив остальных volume files прошёл gzip-проверку.

После переключения настоящие `/api/usage/{connectionId}` подтвердили балансы OpenRouter, DeepSeek, APInex, всех трёх Kilo accounts, Jina AI/Reader и обоих Command Code accounts, месячный расход Requesty и IDR-балансы обоих Kenari connections. Cheaper показал reporting permission; Cloudflare и оба Ollama connections показали отсутствие подтверждённого остатка. В `/api/providers/client` доступны 32 активных подключения вместо прежних 18; сами enabled/disabled states не менялись.

Браузерная проверка настоящего опубликованного bundle через временный read-only authenticated localhost proxy подтвердила денежную строку OpenRouter без `∞`/`0%`/`N/A`, а также отдельные available/reserved/RPM строки APInex. Chrome DevTools connector был занят другим browser profile; проверка выполнена через Codex In-app Browser, без остановки чужого браузера. Fixtures или browser overlays в live-проверке не использовались.

Public HTTPS health ответил `ok=true`, restart count — 0. В последних runtime logs не обнаружены uncaught exception, unhandled rejection, SQLite corruption/error, ReferenceError или TypeError.

Release/evidence: `/root/9router-releases/quota-20261014-d396e234/` на `omni-fr`. Backup состоит из `backup/stable-volume.tgz` и отдельного `backup/data.sqlite`; для полного восстановления нужны оба. Rollback container сохранён как `9router-before-quota-20261014-d396e234`. Локальные evidence files: `/var/folders/gl/2__5nbtj72d05h5zxlcsyb9m0000gn/T/9router-quota-deploy-20261014.k6i2r58k/`.

## Ограничения

Reporting rights ключей не расширялись. Cheaper требует отдельного доступа; административный billing Fireworks/xAI/Anthropic и не подтверждённые источники Cline/ClinePass, Gemini/NVIDIA не подключались. У текущих Cloudflare/Ollama APIs подтверждённые остатки всё ещё недоступны, теперь UI сообщает об этом явно. Header snapshots появляются после реального запроса; в live production новые платные inference/search probes для этой проверки не запускались. Внутренние APIs Jina/Kilo могут изменять контракт.

Настоящие числовые балансы являются снимками на момент чтения и могут меняться от обычного трафика. Этот documentation commit следует после деплоя и не меняет установленную code revision.
