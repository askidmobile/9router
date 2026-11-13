# Внедрение upstream 0.5.119 — 2026-11-13

`upstream-clean` отслеживает `upstream/master`, копия для сравнения —
`origin/upstream-clean`. В чистую ветку не вносить изменения fork.
Обновлять её только fast-forward с upstream. Сравнение последующих обновлений:
`git log --oneline master..upstream-clean`; версия для слияния — проверенный тег.

Слияние `2046692a` имеет двух родителей: наш `7dd807cb` и upstream
`1855aa44`. Отдельные коммиты fork: Kiro `0e6bb1d9`, Qubax `804c4d60`.

| Конфликт / риск | Решение |
| --- | --- |
| `CHANGELOG.md` | Оставлены записи обеих веток; версия приложения и CLI — 0.5.119. |
| `opencode.js`, `proxyFetch.js` | wreq получает выбранный proxy; отсутствие wreq допускает прежний нативный fetch только на прямом маршруте. Сохранены лимиты пула, CONNECT, TLS verification, scoped timeouts, multipart, proxy context и запрет повтора неопределённого POST. OpenCode повторяет только классифицированный overload 429; валидный внешний session ID остаётся. |
| `stream.js` | Неполный хвост `[DONE]` отправляется один раз с полным разделителем. Сохранены учёт трейлера, дедупликация, метаданные, отмена и обработка Responses. |
| Antigravity registry и `usage/google.js` | Carbon добавлен без дубликатов; Flash остаётся прежней моделью по умолчанию, Argon и его квоты сохранены. |
| ClinePass registry и `usage.js` | Новые квоты совместили с нашим unwrap и правилами tool routing. Сохранены Qubax, CommandCode, Experiential и общие обработчики квот. |
| Registry index и providers/alias baselines | Добавлены Synthetic и SenseNova Intl, не исчез ни один существующий provider. Старые 148 alias tokens не изменились; проверка расширена до 154. OAuth URL без изменений. |
| `accountFallback.js` | Cooldown NVIDIA на 15 минут сохраняет привязку к модели. Правила request-scoped 4xx, Combo fallback и блокировки аккаунта сохранены. |
| Provider page и `ModelSelectModal.js` | Живые каталоги Claude/CommandCode добавлены к нашей загрузке; Qoder остаётся на каталоге конкретного подключения. Имена пользователя сохраняются. Общий импорт моделей не заменён циклом перезаписи Qoder имён. |
| Provider models/test/validate routes | Добавлены живой CommandCode и Synthetic quota validation; сохранены live cache, Qubax billing validation и остальные маршруты fork. |
| Providers client и usage route | MiniMax desktop lease принят общим предикатом наравне с существующими OAuth/API-key и custom quota providers; Kiro `api_key` по-прежнему поддерживается. |
| `/v1/models` и `src/sse/services/model.js` | `thinking_levels` учитывает ручные capabilities. Живой CommandCode не заменяет явный allowlist. Голый Claude ID может перейти на OAuth; явный prefix, пользовательский alias, Combo и выключенные участники сохраняют семантику. |
| Golden headers, capabilities и Haiku tests | Динамический Claude UA остаётся нормализован в snapshot; Kimi отражает новую версию приложения. Проверены адаптивный Haiku 5.5 и прежний бюджетный Haiku 4.5. |
| Чисто слитые изменения Codex Images и STT | Нативные edits сохраняют наши метаданные в JSON/SSE; нестандартные параметры остаются на Responses. Multipart работает напрямую и через HTTP CONNECT с undici 7. |
| Kiro и Qubax (свои изменения) | Только AWS OIDC получает TLS X25519:P-256; для других upstream настройки прежние. Qubax Chat получает запрос без двух общих OpenRouter-флагов; явный выбор продавца и запрос следующего Combo-участника не меняются. |
| Caddy (диагностика) | Оба предупреждения — отмена запросов `trading-intelligence/0.1`, не перезапуск или таймаут Caddy. У клиента подтверждён таймаут анализа в том же окне, одна попытка Kimi отражена в его журнале попыток; точного сопоставления обеих отмен по request ID нет. Caddy и TraidingBot не менялись. |

Проверка на Node 22.23.4: 6 269 тестов, 6 161 прошло, 8 известных падений,
99 пропусков и 1 todo. Новых падений относительно того же запуска исходного
fork нет (в baseline 9). Один нестабильный тест конвертации STT в итоговом
прогоне прошёл, поэтому он не считается исправленным этой работой.
Локальная standalone-сборка прошла на Next.js 16.4.6 / undici 7.30.2.
У ESLint на затронутых файлах тот же набор 17 исходных ошибок.

Первый production-образ `804c4d60` прошёл проверку на изолированной копии
SQLite: HTTP JSON/SSE Qubax с tools, один `[DONE]`, native GPT Image,
multipart через CONNECT, Combo spill и освобождение слотов при отмене.
Сравнение до и после проверило 55 подключений, 17 ключей, 13 Combo,
привязки прокси и ручные настройки. Production перешёл на 0.5.119;
health восстановился за 10,76 с, публичные маршруты и баланс/RPM Qubax
прошли проверку. Запрос без токенов через новый транспорт дошёл до AWS,
а управляемая проверка обновила реальные токены трёх аккаунтов Kiro.

После выкладки обнаружилось, что standalone не мог загрузить исходный
модуль фонового обновления. `a23117a0` переносит запуск в Node instrumentation.
На локальной standalone-сборке проверено без HTTP: планировщик обновляет
просроченный токен и сохраняет пару access/refresh. Дополнительно прошёл
31 профильный тест. Caddy и настройки TraidingBot не менялись.
