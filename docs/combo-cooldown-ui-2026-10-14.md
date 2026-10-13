# Combo: приёмка скрытия истёкшего cooldown — 2026-10-14

Развёрнут commit `d56fa7b267253ed569b43901d4fdbdeffb59e50f` на omni-fr. Image `sha256:a920bddda5fef27180f2ff20bd6c2e79ae549e02e7f1dfdde3b6d22d576f006f`; release `/root/9router-releases/combo-ui-20261014-d56fa7b2/`.

## Проверки

- 15 unit tests UI/availability прошли. Локальная и серверная production-сборки прошли.
- Тот же финальный image прошёл HTTP smoke, JSON/SSE custom tools и continuation на консистентной копии production SQLite в контейнере с `network=none`.
- Переключение выполнено при active=0, pending=0. Backup: `backup/stable-volume.tgz` и отдельный консистентный `backup/data.sqlite` (quick_check=ok). Для восстановления файлов нужны оба; rollback container: `9router-before-combo-ui-20261014-d56fa7b2`.
- Env/mounts/ports и хеши сохранённой конфигурации совпали. Health восстановился за 5.26 секунды. Public HTTPS health=ok, restartCount=0, критических ошибок в последних 5 минутах нет.

## Браузерная приёмка

Реальный опубликованный `/dashboard/combos` открыт в Chrome через read-only localhost proxy и SSH tunnel к production. Cookie получен внутренним login, секреты не выводились. Код и assets отдавал реальный production-контейнер; localhost proxy только аутентифицировал GET.

Для воспроизводимого таймера browser-only fetch overlay заменил исключительно `/api/models/availability`: три пары участников `deepseek-v4-pro`, state=open, HTTP 503, failureCount=4 и deadline +20 секунд. Production health records, настройки и модели не менялись; генерации не выполнялись. Один первый DOM-check после reload попал до загрузки карточек; повтор после загрузки подтвердил активную блокировку.

| Проверка | Старая версия после expiry | Новая версия до expiry | Новая версия после expiry |
|---|---|---|---|
| Ready to retry | есть | нет | нет |
| frozen | есть | есть | нет |
| Причина ошибки | есть | есть | нет |
| Combo unavailable | есть | есть | нет |

После deadline все три истёкшие записи продолжали приходить в fixture API. DOM assertions подтвердили отсутствие оранжевых badges и всех четырёх предупреждений без reload между активным и истёкшим состояниями. Скриншоты до/после сохранены в сообщениях текущего чата. Evidence: `browser-results.json` рядом с release manifest; локально `/tmp/9router-combo-ui-20261014-d56fa7b2/`.

Ограничение: это проверка отображения на реальном опубликованном bundle с контролируемыми metadata в браузере. Реальный upstream отказ намеренно не создавался. Успешное восстановление модели не проверяется этой UI-правкой.
