# Отслеживание квоты: активные провайдеры и ошибки отображения

Дата проверки: 14 октября 2026 года, около 22:20 МСК. Это анализ, реализация и деплой не выполнялись.

## Вывод

OpenRouter уже отдаёт правильный баланс. Ошибка находится в представлении данных: денежный остаток проходит через нормализатор обычных квот, теряет свои признаки и отображается как расход с неизвестным пределом и нулевым остатком в процентах.

С текущими credentials можно добавить данные APInex, Requesty, Kenari, Kilo Code, Jina AI и Jina Reader. Это подтверждено read-only запросами из production. Cheaper Inference имеет подходящий официальный API, но текущему ключу не хватает прав. Fireworks и xAI имеют официальные APIs квот/биллинга, однако требуют дополнительной настройки идентификатора аккаунта или credentials. Для части других провайдеров подходят заголовки реальных ответов, а не отдельный опрос баланса.

Помимо OpenRouter обнаружены проблемы достоверности: Cloudflare превращает GraphQL-ошибку в «100% доступно», Ollama ожидает другую структуру ответа, Groq пытается читать квоты из `/models`, который при проверке не вернул квотных заголовков. Command Code уже получает остаток кредитов, но отбрасывает его.

## Объём и метод проверки

- Исходники и production image совпадали по ревизии `17c76fe8d99b6ad8c8c559863358c37095864a6e`; label image — `17c76fe8`.
- Production SQLite открывалась с `readOnly: true`. Найдены 47 подключений, из них 42 включены, к 30 provider IDs: 28 встроенных и два custom OpenAI-compatible узла — Kenari и Z.ai.
- «Активный» здесь означает `isActive=1`, а не успешный последний inference. `testStatus` — сохранённый результат прежней проверки, а не доказательство текущей доступности. Например, Requesty, Command Code и некоторые Kilo connections имеют `unavailable`, но их read-only APIs отвечают успешно.
- Реестр допускает в текущий раздел 12 из этих провайдеров, суммарно 18 включённых подключений. Остальные исключены до запроса квот: `src/app/api/providers/client/route.js`, `isUsageEligible`, использует `features.usage` и `features.usageApikey` из registry.
- Выполнялись только чтение метаданных, GET-запросы баланса/квот и GraphQL query Cloudflare. Генерация, поиск, платежи, обновление OAuth, изменение credentials и базы не выполнялись. Ключи, токены, личные данные и номера аккаунтов в отчёт не включены.

## OpenRouter: причина скриншота и дополнительные дефекты

Путь данных: `getOpenRouterUsage` в `open-sse/services/usage/misc.js` → `/api/usage/[connectionId]` → `parseQuotaData` в `ProviderLimits/utils.js` → `QuotaTable.js`.

1. Сервис записывает баланс в `used`, выставляя `total: 0`, `unlimited: true`, `remainingPercentage: 100`. В `parseQuotaData` нет отдельного случая OpenRouter, а generic fallback сохраняет только `used`, `total`, `resetAt`. `QuotaTable` получает обычную строку, вычисляет 0% для `total=0`, рисует красный индикатор и знаменатель `∞`. Пример пользователя «17,48 / ∞ · 0%» воспроизведён на настоящих функциях нормализации.
2. DeepSeek использует уже существующие `isCreditBalance: true` и `currency`, а сумма находится в `total`. Этот путь умеет показывать деньги без процентной полосы. Его достаточно переиспользовать для OpenRouter.
3. `/api/v1/key` отдаёт `limit_remaining`, периодные `usage_daily`, `usage_weekly`, `usage_monthly`, параметры BYOK, а текущий код считает остаток как `limit - usage`, где `usage` — расход за всё время. Для периодического лимита это неверно; приоритет должен иметь остаток, возвращённый провайдером. `limit=0` также нельзя пропускать как отсутствие лимита, а `limit=null` означает отсутствие ограничения именно ключа.
4. `/api/v1/key` также возвращает `free_model_daily_requests: {used, limit, remaining}`. Эти данные доступны и на проверенном платном аккаунте. Сейчас строка создаётся только для `is_free_tier`, её расход подменяется числом всех локальных записей OpenRouter, включая платные запросы; использование ключа другими приложениями не учитывается.
5. В free-tier ветке используется `totalCredits`, объявленный внутри другого блока. Сценарий воспроизведён на настоящей функции с fixture API-ответами: `OpenRouter error: totalCredits is not defined`.
6. Weekly reset вычисляется как «сейчас + 7 дней», хотя документация описывает текущую UTC-неделю с понедельника. Произвольную дату нельзя показывать как точный reset. Нулевое значение `total_credits` сейчас исключает строку баланса, а отрицательный баланс скрывается обрезанием до нуля.

Живые `/key` и `/credits` ответили HTTP 200; остаток из `total_credits - total_usage` совпал с суммой около 17,48 USD на скриншоте. DeepSeek `/user/balance` ответил HTTP 200 и подтвердил 16,90 USD.

Важное расхождение: [текущая OpenAPI-схема OpenRouter](https://github.com/OpenRouterTeam/docs/blob/main/openapi/openapi.yaml) помечает `/credits` как требующий management key. Однако проверенный ключ с `is_management_key: false` получил HTTP 200. Для этого подключения новый ключ сейчас не нужен; для других подключений нужно корректно обрабатывать 403 и сохранять доступные данные `/key`. Правила прав доступа могут измениться.

Источники: [OpenRouter limits](https://github.com/OpenRouterTeam/docs/blob/main/api_reference/limits.mdx), [DeepSeek balance API](https://api-docs.deepseek.com/api/get-user-balance).

## Новые данные, которые можно подключить

| Провайдер | Источник и доступные данные | Результат проверки и способ отображения |
|---|---|---|
| APInex Bond | `GET https://api.apinex.bond/v1/balance`: `balance_usd`, `reserved_usd`, `rpm`, `rpm_plan` | HTTP 200. Денежный баланс и резерв отдельно; RPM — предел скорости, а не известный текущий остаток. [Balance API](https://apinex.bond/developers/balance). |
| Requesty | `GET https://api-v2.requesty.ai/v1/manage/apikey/self`: `monthly_spend`, `monthly_limit` | HTTP 200 при `manage: none`. Собственный ключ можно читать без расширения прав. В проверенном подключении лимит равен строке `"0"`: это unlimited, а не нулевой бюджет. Показать месячный расход; прогресс нужен только при положительном лимите. Баланс организации этим ответом не подтверждён. [API](https://docs.requesty.ai/api-reference/endpoint/manage-apikey/manage-api-key-get). |
| Kenari | `GET https://kenari.id/v1/account/balance` и `/v1/account/quota` | Оба APIs ответили HTTP 200 у двух подключений. Баланс, резерв и доступно — в micro-IDR, делить на 1 000 000. Подписочные окна 5h/week/month, остаток и reset; купон имеет срок истечения. Сейчас баланс нулевой, `plan` и `coupon` равны null. Это реальные состояния, не ошибка чтения. [Balance](https://kenari.id/en/docs/account-balance), [Quota](https://kenari.id/en/docs/account-quota). |
| Kilo Code | `GET https://api.kilo.ai/api/profile/balance`: `balance`, `isDepleted`; официальный клиент также читает `kiloPass.getState` | Баланс ответил HTTP 200 на всех трёх подключениях. Дополнительное состояние Kilo Pass содержит кредитные начисления, расход и следующую дату биллинга; эта ветка live не проверялась. Не путать дату биллинга с reset окна. [Исходник клиента](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-gateway/src/api/profile.ts), [Kilo Pass](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-gateway/src/api/kilo-pass.ts). |
| Jina AI / Jina Reader | Внутренний API официального кабинета: `GET https://dash.jina.ai/api/v1/api_key/fe_user?api_key=…`; `wallet.total_balance`, `trial_balance`, `regular_balance`, `metadata.speed_level` | HTTP 200 с обоими текущими ключами. Показывать остаток в токенах и разбиение trial/paid; не переводить его в USD. Это внутренний frontend API, а не обещанный стабильный публичный контракт. Ключ передаётся в query: URL и ответ с личными полями нельзя логировать или отдавать frontend. [Официальный кабинет](https://jina.ai/api-dashboard/), исследованный bundle `index-CNHh1KWq.js`, методы `getCurrentKeyInfo` и `getKeyInfo`. |
| Cheaper Inference | `GET https://api.cheaperinference.com/v1/account/balance`: `balance_usd`, `available_usd`, `reserved_usd`; `/v1/usage/daily` и `/v1/usage/requests` | Балансовый запрос получил `403`, `insufficient_scope`, `permission_denied_error`. Источник пригоден, но надо отдельно обеспечить разрешённый reporting scope. Основная сумма — `available_usd`, а не сумма с резервом. [Документация](https://www.cheaperinference.com/docs#account), [индекс с контрактом](https://cheaperinference.com/llms.txt). |
| Fireworks AI | `GET /v1/accounts/{account_id}/quotas`: `value`, `maxValue`, `usage`; `/billing/summary` и `billingUsage` — затраты/потребление | Официальные APIs существуют. В текущем connection нет `accountId`; live чтение не выполнялось. Квота и billing summary не равны текущему предоплаченному балансу. [Quotas](https://docs.fireworks.ai/api-reference/list-quotas), [Billing summary](https://docs.fireworks.ai/api-reference/get-billing-summary). |
| xAI | Management API: `/v1/billing/teams/{team_id}/prepaid/balance`, `/postpaid/spending-limits`, историческое usage | Нужны отдельный management key и team ID, которых эта интеграция сейчас не хранит как отдельные reporting credentials. Не запрашивать их автоматически вместо текущего inference key. Live не проверено. [Management guide](https://docs.x.ai/developers/management-api-guide), [Billing API](https://docs.x.ai/developers/rest-api-reference/management/billing). |
| Anthropic | Admin Usage/Cost и Rate Limits APIs; обычные ответы Messages содержат rate-limit headers | Организационные отчёты требуют Admin API credentials и подходящего аккаунта. Workspace inference key не обеспечивает этот доступ. Можно начать с заголовков реальных ответов. Токеновые расходы и spend cap не являются wallet balance. [Usage/Cost](https://platform.claude.com/docs/en/manage-claude/usage-cost-api), [Rate Limits API](https://platform.claude.com/docs/en/manage-claude/rate-limits-api). |

APInex особенно показателен: его `llms.txt` ещё описывает token balance, а текущий balance endpoint и краткая страница документации описывают USD. Использовать живой контракт с полями USD; не вводить прежний фиксированный пересчёт «$1 = N токенов».

## Остальные активные провайдеры: что уже есть и чего не хватает

В таблице перечислены все оставшиеся provider IDs. Cline и ClinePass разделены, поскольку у первого OAuth, а три текущих ClinePass credentials являются API keys.

| Провайдер (включённых connections) | Доступные метрики и текущая поддержка | Проверка / ограничение |
|---|---|---|
| Antigravity (3) | Уже есть модельные и групповые квоты, сессионные/недельные остатки и reset через внутренний Google API | Структура проверена в `usage/google.js` и `antigravity-weekly.js`; live в этом анализе не подтверждена. Один сохранённый `testStatus=unavailable`. |
| Codex (1) | Уже есть подписочные окна, Review/Spark, credits; внутренний `/backend-api/wham/usage` | HTTP 200; ответ содержит `rate_limit`, `code_review_rate_limit`, `additional_rate_limits`, `model_usage`, `credits`, `spend_control`. Это квота подписки, а не баланс OpenAI API. |
| GitHub Copilot (1) | Уже есть premium requests, chat/completions и reset через `/copilot_internal/user` | Внутренний account API; live в этой проверке не подтверждён. Не гарантировать доступность как публичного стабильного endpoint. |
| Kiro (3) | Уже есть credits, free trial и reset через `getUsageLimits` | Внутренний account API. Нужно сохранять разницу восстановления регулярного лимита и истечения trial. Live в этой проверке не подтверждён. |
| GLM Coding (1) | Уже есть 5h/weekly окна через `/api/monitor/usage/quota/limit` | HTTP 200; получены `CREDIT_LIMIT`, абсолютные `currentValue`, `remaining`, потолок `usage`, процент и `nextResetTime`. Сейчас парсер оставляет только процент, можно показать также реальные кредитные остатки. Не подписывать их как токены. |
| Ollama Cloud (2) | Уже есть обработчик, ожидающий `limits.<window>.usage` | HTTP 200 от `/api/usage`, но ответ содержит `range/scope/granularity/from/until/totals/buckets`, без `limits`. Этот ответ нельзя использовать как подтверждённый остаток подписки. Нужен актуальный источник квот; web-cookie доступ отдельно не расширялся. |
| OpenCode Go (1) | Уже есть rolling 5h, weekly, monthly | HTTP 200; получены `status`, `percent`, `resetsAt`. Weekly/monthly реально `rate-limited`. Сохранённый старый статус connection не должен скрывать успешное чтение этих метрик. |
| Command Code (2) | Уже есть 5h/weekly через `/alpha/billing/credits` | У проверенного ключа HTTP 200. Ответ также содержит `credits.monthlyCredits/purchasedCredits/freeCredits`, которые обработчик отбрасывает. Weekly exceeded подтверждён; деньги/кредиты и недельный предел должны отображаться разными строками. Второй ключ отдельно не проверялся. |
| Groq (1) | Уже есть обработчик заголовков `x-ratelimit-*` | `/models` HTTP 200 без этих headers. Сохранять их из реальных inference-ответов по model/org и показывать возраст снимка. `requests` означает RPD, `tokens` — TPM. [Официальные headers](https://console.groq.com/docs/rate-limits). |
| Cloudflare Workers AI (1) | Уже есть GraphQL analytics и сравнение с free allocation | HTTP 200 с `unknown field "aiWorkersAiInvocationsAdaptiveGroups"`. Обработчик игнорирует GraphQL `errors`, получает пустую выборку и показывает 100%. Дополнительно 10k neurons — бесплатная дневная часть; Paid может работать дальше с оплатой, это не универсальный hard cap. [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). |
| Cline OAuth (1) | Официальный клиент использует `/api/v1/users/{uid}/balance` и organization balance | Интеграции usage нет. Read-only проба с JWT subject и текущими 9router headers получила HTTP 400; корректность mapping UID/headers не подтверждена. В официальном клиенте amount делится на 100. Сначала проверить идентификатор и контракт авторизации. [Клиент](https://github.com/cline/cline/blob/main/apps/vscode/src/services/account/ClineAccountService.ts), [единицы](https://github.com/cline/cline/blob/main/apps/vscode/src/core/controller/account/getUserCredits.ts). |
| ClinePass (3) | Балансовый endpoint Cline OAuth не доказывает доступ к лимитам Pass с API key | Пригодный контракт Pass-окон и доступ текущих API keys не подтверждены. Не подменять это квотами обычного Cline или OpenRouter. |
| Brave Search (1) | Ответы поиска содержат `X-RateLimit-Limit/Policy/Remaining/Reset` для нескольких окон | Можно отражать RPS и месячный остаток из реальных запросов. Новые платные поиски для диагностики не запускались. [Headers](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting). |
| Cerebras (1) | Модельные RPM/TPM/TPH/TPD, отдельные uncached/total token ограничения | `/models` HTTP 200 без квотных headers. Точные текущие остатки с нынешним ключом не подтверждены; проверять реальные ответы, не переносить исторические header names без проверки. [Rate limits](https://inference-docs.cerebras.ai/support/rate-limits). |
| Nebius (1) | Динамические RPM/TPM и остатки доступны в `x-ratelimit-*` реальных ответов | Интеграции usage нет. Можно использовать headers, включая dynamic-scale и over-limit. Балансовый endpoint с текущим inference key не подтверждён. [Rate limits](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits), [Billing](https://docs.tokenfactory.nebius.com/other-capabilities/billing-new). |
| Google AI Studio / Gemini (2) | RPM, TPM, RPD и проектные ограничения | Это provider `gemini`, не OAuth `gemini-cli`. Обычный API key не подтверждает возможность читать полный остаток project quota или cloud balance. Лимиты относятся к проекту, RPD reset — Pacific time. Cloud IAM/Monitoring credentials отдельно не получались. [Документация](https://ai.google.dev/gemini-api/docs/rate-limits). |
| NVIDIA NIM (1) | Лимиты/ошибки и возможные headers реальных запросов | Публичный balance/quota endpoint с текущим ключом не подтверждён. Нельзя ставить выдуманный общий потолок или рассчитывать остаток по локальному usage. |
| Custom Z.ai (1) | Custom connection на `api.z.ai`, отдельный от GLM Coding | OpenAI compatibility не включает quota API. Сначала выяснить тип плана/ключа: нельзя автоматически использовать Coding quota endpoint для обычного PAYG connection. Доступ не подтверждён. |

## Как отображать данные

Использовать существующие компоненты и тип денежных строк DeepSeek. Полная переработка страницы и новая форма для каждого провайдера не нужны.

| Вид данных | Представление |
|---|---|
| Баланс | `Баланс: 17,48 USD`; при наличии `Доступно: … · В резерве: …`. Без `∞`, процентов и пустой даты `N/A`. Нулевой баланс показывать явно. |
| Лимит расходов ключа | `Потрачено X из Y USD за месяц · Осталось Z USD`. Процент только при известном положительном Y; unlimited key не означает unlimited деньги аккаунта. |
| Подписочное окно | `Осталось 74% · Восстановление …`; абсолютные credits/tokens/request counts добавлять, только если их действительно отдаёт API. |
| Скоростное окно | `Запросы/мин`, `Токены/мин`, `Запросы/день` с оставшимся количеством и временем снимка. Не считать stale headers текущими данными. |
| Trial / coupon | Остаток отдельно, дата «Истекает», а не «Восстановится». |
| Недостаточно прав / неизвестно | `Нужен доступ к статистике`, `Провайдер не вернул квоту`, ошибка или устаревший снимок. Ни 0%, ни 100% не заменяют неизвестное значение. |

Остатки денежных счетов нельзя суммировать по credentials: несколько ключей могут показывать один wallet. То же касается проектных/org/model лимитов. Для Jina Reader и Jina AI нужно предусмотреть отображение общего кошелька, если их account identity совпадает. Валюты USD и IDR не сводить к общей сумме без отдельно заданного курса.

## Порядок реализации

1. Исправить достоверность: OpenRouter normalizer/денежная строка, `limit_remaining` и бесплатные counters; Cloudflare GraphQL errors; Ollama — перестать интерпретировать несовпадающий контракт как доступную квоту.
2. Добавить подтверждённые источники APInex, Requesty, Kenari, Kilo и Jina; добавить credit balance Command Code. Для каждого нужен обработчик, dispatch, flags registry, проход метрик через нормализатор и небольшая проверка реального response shape. Для Kenari оставить существующий custom node, явно связав quota handler с этой интеграцией; generic OpenAI-compatible узлам баланс не назначать.
3. Сохранять headers реальных ответов Groq, Brave, Nebius и Anthropic; проверить Cerebras. Это затрагивает JSON и SSE пути получения upstream response. Не отправлять synthetic inference/search только ради обновления процентов.
4. Отдельно настроить reporting access Cheaper, Fireworks, xAI и Anthropic Admin API, если нужен более полный биллинг. Cline/ClinePass и проектные Google квоты доисследовать по фактическому типу credentials.

## Проверка и ограничения

Успешно выполнены три assert-проверки на фактическом исходном коде с изолированными зависимостями: потеря OpenRouter flags в `parseQuotaData`, ReferenceError free-tier ветки `getOpenRouterUsage`, ложные 100% после GraphQL error в `getCloudflareUsage`. Проверка нормализации также подтвердила сохранение DeepSeek credit row. Это воспроизведение дефектов, не тестирование внесённого исправления.

Живое чтение подтвердило ответы OpenRouter, DeepSeek, APInex, Requesty, Kenari, Kilo, Jina, GLM, OpenCode Go, Command Code и Codex; также зафиксированы отсутствие квотных headers `/models` Groq/Cerebras, контракт `/api/usage` Ollama, scope error Cheaper, GraphQL error Cloudflare и неуспешная проба Cline.

Попытка импортировать необандленные usage modules прямо в standalone container не смогла выполнить общий handler из-за отсутствующих `uuid`/`undici` в этом режиме. Эти ошибки диагностического запуска не являются доказательством сбоя Next.js runtime. Для последующей проверки использовался штатный Node fetch к фиксированным upstream endpoints; production route с OAuth refresh не вызывался. Автоматическое обновление токенов и connection proxy paths этими пробами не проверены.

Полная браузерная проверка, сборка и inference-тесты не запускались: исходники приложения не изменялись. У внутренних APIs Jina, Kilo, Cline и подписочных провайдеров остаётся риск изменения контрактов; для каждого необходимо обрабатывать отсутствие данных и показывать дату последнего успешного чтения.
