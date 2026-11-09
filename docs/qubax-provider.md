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

75 тестов по провайдерам, API-маршрутам, импорту и SQLite-переносу прошли;
production-сборка и provider baseline также прошли. Разбор живого публичного
каталога выделил 249 чат-моделей из 432 записей. Inference с действующим ключом,
перенос рабочего подключения и деплой в рамках этой правки не выполнялись.
