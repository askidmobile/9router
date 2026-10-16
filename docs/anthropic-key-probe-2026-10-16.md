# Проверка ключа Anthropic — 16 октября 2026

Первичное исправление: `17def318992e1ce09f43ddb5adcc34c133f5fc7a`. Обновление запасной модели до Haiku 5.5: `5d11cfd1ac3070c374e5939aa4900c7602b77f26`.

## Причина

`POST /api/providers/validate` и общий `testSingleConnection`, используемый индивидуальной и пакетной проверкой подключений, отправляли `POST /v1/messages` с `claude-3-haiku-20240307`. В каждой реализации был также такой же запасной model ID для Anthropic-compatible шлюзов.

По [официальному реестру Anthropic](https://platform.claude.com/docs/en/about-claude/model-deprecations), Haiku 3 отключена 20 апреля 2026 года; указанная замена — `claude-haiku-4-5-20251001`. Ответ 404 от старой модели ошибочно считался успешной проверкой штатного Anthropic, поскольку проверялось только отсутствие HTTP 401.

В production обнаружено одно штатное подключение Anthropic, совпадающее с суффиксом ключа из уведомления. Его `defaultModel` не указывает на Haiku 3. В доступных логах контейнера нет model ID или `not_found_error`; точная атрибуция двух запросов от 14 октября по журналам невозможна. Обнаруженные служебные вызовы объясняют уведомление, но количество запросов независимо не подтверждено.

## Изменение

- Штатный Anthropic проверяется через [GET /v1/models](https://platform.claude.com/docs/en/api/models/list), без тела запроса и генерации. Успех определяется `response.ok`; запрос ограничен 15 секундами.
- Сохранённые подключения продолжают использовать существующий транспорт с прокси. Общий helper покрывает индивидуальный и пакетный тест.
- У Anthropic-compatible шлюзов запасная модель заменена на `claude-haiku-5-5`; явно настроенная модель сохраняется.

Изменений ключей, схемы БД, пользовательских моделей и правил маршрутизации нет. Bedrock model ID не изменён: уведомление относится к Claude API.

## Проверки

- До исправления 13 из 19 новых регрессионных проверок падали; после исправления все 19 проходят.
- Шесть целевых test files: 119 passed. Проверены оба обработчика, сетевой сбой, HTTP 401/403/404/429/500, запасная и пользовательская модели шлюза, прокси и timeout.
- ESLint затронутых файлов и `git diff --check` прошли.

## Первичная production acceptance (`17def318`)

На `omni-fr` установлен тот же проверенный image `sha256:e9f1d7fb3aa7b6567e585d584f4cfc26085afabeafa7a4704e5734b39f7cd8be`, revision `17def318992e1ce09f43ddb5adcc34c133f5fc7a`.

- Production build прошёл. На копии production SQLite с `--network none` выполнено 13 настоящих HTTP-проб через собранные обработчики: все upstream requests — `GET /v1/models`, без тела запроса, с заголовками авторизации и timeout. Шесть вариантов HTTP-статуса проверены для обоих путей; пакетная проверка также прошла. Настройки внутри QA сохранились.
- Cutover дождался `active=0, pending=0`; health восстановился за 6,41 секунды. Публичный HTTPS `/api/health` вернул `{"ok":true}`.
- Реальный ключ из уведомления прошёл оба исправленных обработчика: validation и saved connection test вернули `valid: true`, `error: null`. Генераций не выполнялось.
- Отпечатки настроек, 47 подключений и связанных proxy pools совпали до и после переключения и живых проверок. Environment, mounts и port bindings сохранены. `restartCount=0`; упоминаний старой модели в логах нового контейнера на момент приёмки — 0.
- SQLite backup прошёл `PRAGMA quick_check`. Rollback container: `9router-before-anthropic-probe-20261016-17def318`.

Защищённые evidence и backup: `/root/9router-releases/anthropic-probe-20261016-17def318/` на `omni-fr`: `release.json`, `qa-result.json`, `deployment-result.json`, `live-result.json`, `final-result.json`, `backup/data.sqlite`.

Полный набор тестов и качество генерации не проверялись. Приёмка подтверждает исправление служебных проверок ключа; она не восстанавливает историческую атрибуцию двух запросов из письма.

## Обновление до Haiku 5.5

По уточнению пользователя обе запасные модели для Anthropic-compatible проверок обновлены с Haiku 4.5 на `claude-haiku-5-5`. Штатные проверки Anthropic через каталог моделей сохраняются.

Сверены [официальные параметры миграции](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide): служебный запрос не отправляет устаревший thinking budget, sampling parameters или assistant prefill. Реальный запрос с ключом из уведомления, `max_tokens: 1` и пользовательским сообщением `test` вернул HTTP 200, `model: claude-haiku-5-5`, один output token и `stop_reason: max_tokens`. Это проверяет принятие запроса, а не качество ответа.

25 целевых тестов, ESLint затронутых файлов и `git diff --check` прошли.

На `omni-fr` установлен image `sha256:57fbb14294aa273dd11a6709a227a2f8eed7e1dc9a6bc614b87dc991047f0344`, revision `5d11cfd1ac3070c374e5939aa4900c7602b77f26`. Production build прошёл. На exact image с копией данных и `--network none` прошли 15 HTTP-проб: 13 штатных обращений к каталогу и оба Anthropic-compatible обработчика, отправившие `claude-haiku-5-5` с `max_tokens: 1`. Пользовательская модель отдельно сохраняется unit tests.

Переключение выполнено при `active=0, pending=0`; health восстановился за 5,96 секунды. Публичный HTTPS health и обе проверки настоящего ключа после обновления прошли. Настройки 47 подключений и связанные proxy pools сохранились; `restartCount=0`. SQLite backup проверен; rollback container: `9router-before-anthropic-haiku55-20261016-5d11cfd1`.

Evidence и backup: `/root/9router-releases/anthropic-haiku55-20261016-5d11cfd1/` на `omni-fr`, включая `haiku55-live-result.json`, `qa-result.json`, `deployment-result.json`, `live-result.json`, `final-result.json`. Временный QA-контейнер и копия QA-данных удалены. Качество генерации и полный набор тестов не проверялись.
