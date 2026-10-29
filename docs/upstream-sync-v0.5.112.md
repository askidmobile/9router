# Обновление 9router v0.5.112 — 2026-10-29

Upstream `1fe586bb` (v0.5.112, 2026-10-28) объединён с fork `6fe7ac9a`. 13 upstream commit, 48 изменённых upstream файлов. Merge commit: `98f2aabf`. История и наши доработки сохранены; backup branch: `codex/backup-before-v0.5.112-20261029`.

Источники: [release](https://github.com/decolua/9router/releases/tag/v0.5.112), [compare](https://github.com/decolua/9router/compare/v0.5.111...v0.5.112). Локальные проверки: [verification.json](audit/2026-10-29-upstream-v0.5.112/verification.json).

## Изменения upstream

- MiniMax Code получил lease auth через локальный named-pipe/unix-socket broker desktop-приложения, dashboard-кнопку и usage attribution.
- Добавлен Nace Drex в System One lane: `drex-max`, `drex-v2.0`, `drex`.
- CommandCode запросы выровнены с CLI 1.88.0 через общий builder identity headers.
- В Codex добавлен `gpt-6.1-terra`; Copilot получает правила Claude 5.5 для dotted model IDs.
- Lazy runtime installer и Docker image теперь содержат рабочие `wreq-js` и `playwright-core` для OpenCode Free.
- Non-streaming Chat возвращает upstream ошибку из SSE `error` frame вместо generic 502; Gemini schemas проверяют protobuf type predicates.
- NVIDIA NIM нормализует reasoning aliases; bulk-add сохраняет полный `LLM|id|secret`; DeepSeek PoW переведён на компактный noble-hashes port.

## Сохранение fork

Разрешены 9 конфликтов. CommandCode остаётся на официальном `/provider/v1/chat/completions`, а не возвращается к `alpha/generate`; старый proprietary NDJSON executor остаётся удалённым. Новые CLI 1.88 identity headers добавлены к нашему transport и используются validation/usage кодом.

Registry сохранил порядок и собственные providers; Nace добавлен отдельным entry `p153`. Сохранены Qoder prefix normalization, request lifecycle с централизованным `trackDone`, provider/catalog/pricing/proxy contracts, Combo affinity/concurrency, Responses и ClinePass behavior. Golden snapshot нормализует новые случайные CodeBuddy request IDs.

## Проверки перед деплоем

- Full suite: 5550 tests, 5436 passed, 3 failed, 14 expected fail, 96 skipped, 1 todo, 515 files.
- Три failures уже были на fork до merge: `combo-credit-fallback`, `headroom-responses-format`, `security-audit`; их полные test identities совпадают с baseline.
- Focused upstream set: 165/165. Golden URL/header snapshots: 176/176.
- Production build и standalone assets прошли. Registry baseline: 107 providers; alias baseline: 141 tokens; OAuth URLs не менялись.
- ESLint новых errors не дал. Четыре `react-hooks/set-state-in-effect` в provider page существуют в pre-merge HEAD и не связаны с релизом. `git diff --check` прошёл.

## Деплой

На `omni-fr` / [публичный endpoint](https://omni-fr.archteam.org) развёрнут source commit `98f2aabf9a4a9dbdc582a81b34e891dcb1b6f136`.

Exact image: `sha256:749ea6d7c8072a75a4f1d8ec79bae7ac23f22be130c9138f8ec9d7de1caab6d1`, tag `9router-local:upstream-v0.5.112-20261029-98f2aabf`, размер 291276587 bytes. Source archive SHA-256: `3730ae770534fe815c7d0c304a672ecf2c8597be31e3fea6522c46b423dedb7a`. Image labels: revision `98f2aabf…`, version `0.5.112`; runtime Node 22.23.4 / Next 16.4.3.

До cutover exact image прошёл QA на consistent SQLite copy в `--network none`: affinity, per-account concurrency, cancellation, Combo spill, management API, dashboard и 17 assets, embeddings, WAV/PCM TTS, strict proxy policy, SSE error propagation, registry additions, Docker lazy-runtime modules и MiniMax lease через fake broker с protocol frames `status → lease → lease`. QA DB `quick_check=ok`, test residue отсутствует. Receipts: [qa-result.json](audit/2026-10-29-upstream-v0.5.112-deploy/qa-result.json).

Cutover выполнен при `active=0, pending=0`. Health восстановился за 8.78 секунды. Сохранены 49 connections, 15 API keys, 12 combos, environment, mounts, ports и protected settings. SQLite backup: `/root/9router-releases/upstream-v0.5.112-20261029-98f2aabf/backup`; rollback container: `9router-before-upstream-v0.5.112-20261029-98f2aabf`. Receipts: [release](audit/2026-10-29-upstream-v0.5.112-deploy/release.json), [cutover](audit/2026-10-29-upstream-v0.5.112-deploy/deployment-result.json), [postcheck](audit/2026-10-29-upstream-v0.5.112-deploy/production-result.json), [catalog](audit/2026-10-29-upstream-v0.5.112-deploy/catalog-live.json).

После cutover management API, dashboard и assets прошли локально и через публичный HTTPS. `restartCount=0`, SQLite `quick_check=ok`, fatal log markers отсутствуют. Штатный free-proxy health sync обновил только health поля у 10 managed proxies; URL, bindings и strict policy не менялись. Authenticated `/api/models` содержит Nace Drex и GPT-6.1 Terra; `/v1/models` содержит GPT-6.1 Terra и CommandCode, а Nace в OpenAI catalog не публикуется, поскольку его lane — System One.

Реальный MiniMax desktop sign-in, Nace inference и платные модели в acceptance не использовались. Эти routes подтверждены unit/integration QA, registry и management catalog, но не live provider response.
