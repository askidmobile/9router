# Qubax AI

Встроенный провайдер `qubax` (также `qubaxai`) использует API key из
[Qubax dashboard](https://qubax.ai/app/api-keys).
Пример модели: `qubax/deepseek-v4.1-flash`.

Поддержаны Chat Completions, Responses и Anthropic Messages через общий
executor. Endpoints и Bearer-аутентификация описаны в
[документации Qubax](https://qubax.ai/docs),
[Responses](https://qubax.ai/docs/responses) и
[Anthropic endpoint](https://qubax.ai/docs/provider-pinning).

Import Models и предложения моделей читают `/v1/models`. В список чата попадают
только модели с текстовым входом и выходом; image/video/audio-only, embeddings
и decisions исключаются. Импорт использует `context_length`,
`max_output_length`, capabilities и уровни reasoning, если они опубликованы.
Цены берутся из `pricing_summary` в USD за 1M токенов: это текущие публичные
предложения, фактическая стоимость зависит от маршрутизации и доступных продавцов.
Ручные overrides сохраняют обычный приоритет 9router.

`/v1/models` публичен и не проверяет ключ. Добавление и тест подключения выполняют
короткий запрос `gpt-4o-mini` с `max_tokens: 1`; он может расходовать кредиты.
Только успешный ответ подтверждает подключение; 402/429 и ошибки сервера
возвращаются как невозможность проверки.

## Перенос существующего custom-провайдера

После обновления приложения используйте Node.js с `node:sqlite`:

```sh
DB_PATH=/path/to/db/data.sqlite node scripts/migrate-qubax-to-native.mjs
DB_PATH=/path/to/db/data.sqlite node scripts/migrate-qubax-to-native.mjs --apply
```

Первый вызов только показывает найденный custom node с точным URL
`https://api.qubax.ai/v1`. Применять перенос следует при остановленном
приложении. Перед изменением скрипт создаёт SQLite backup; затем в одной
транзакции переносит все подключения, выбранные модели, overrides и provenance,
переадресует combo, model aliases и списки доступа API keys на `qubax/`.
Ключи, ID подключений, proxy и явный `enabledModels` сохраняются.
Старый custom node удаляется после переноса. Чужие endpoints не затрагиваются;
при нескольких Qubax nodes или конфликте native overrides скрипт останавливается.
Повторный вызов после успешного переноса ничего не меняет.

## Проверка 2026-11-09

После объединения с коммитами второй сессии прошли 130 тестов по провайдерам,
API-маршрутам, импорту, SQLite-переносу, Refuseless и streaming speed.
Provider baseline: 111 провайдеров. Серверная production-сборка прошла.
Точный образ проверен без внешней сети на согласованной копии production SQLite:
перенос, сохранение конфигурации, management API, dashboard assets и Qubax logo.

## Production 2026-11-09

`a79314fc8225f99f05520448f361222c2083cdf4` опубликован в `origin/master` и
развёрнут на omni-fr поверх исправлений второй сессии. Образ:
`sha256:7ad23aea10ac0832588ee9aba53bfef78316dba5448b66dc5d3ef20559c851d9`.

Custom Qubax перенесён во встроенный `qubax`. Сохранены ID и ключ подключения,
шесть выбранных моделей, proxy, overrides, provenance и ограничения доступа.
После переноса: 55 подключений, 17 API keys, 13 Combo; custom nodes стало 1 вместо
2. Настройки других провайдеров, environment, mounts и HostConfig сохранены.

Перед остановкой было `active=0, pending=0`; health восстановился за 10,52 с.
Локальные и публичные health/API/UI/assets прошли, `quick_check=ok`, рестартов и
fatal log markers — 0. Живой каталог вернул 249 чат-моделей без fallback.
Запрос через production `/v1/chat/completions` к `qubax/glm-5.3-flash`
завершился HTTP 200 с provider-reported usage: 2016 input / 16 output tokens.
Внешний inference Responses и Anthropic Messages отдельно не запускался.

Rollback container: `9router-before-qubax-20261109-a79314fc`.
Согласованная резервная копия SQLite и исходная конфигурация контейнера:
`/root/9router-releases/qubax-20261109-a79314fc/backup` на сервере.
Откат требует вернуть и предыдущий контейнер, и SQLite backup: старый образ
ожидает custom Qubax, а не native provider. База и секреты в Git не копировались.

Подтверждения: [deployment](audit/2026-11-09-qubax-deploy/deployment-result.json),
[production](audit/2026-11-09-qubax-deploy/production-result.json),
[migration](audit/2026-11-09-qubax-deploy/migration-production-check.json),
[offline QA](audit/2026-11-09-qubax-deploy/qa-result.json),
[live smoke](audit/2026-11-09-qubax-deploy/live-smoke.json).
