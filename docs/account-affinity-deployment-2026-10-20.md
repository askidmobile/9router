# Account affinity deployment — 2026-10-20

Deployed to `omni-fr` / `https://omni-fr.archteam.org`.

- Runtime revision: `7e11a4d555de58ab023e42989430da33dd264e30`.
- Image: `9router-local:affinity-20261020-7e11a4d5`.
- Image ID: `sha256:7921c57722b9d9e18d8d60483004e89f73eae2aade71fe4c10427b94ff877a3a`.
- Release evidence: `/root/9router-releases/affinity-20261020-7e11a4d5/` (build, QA, cutover and production result files).
- Rollback container: `9router-before-affinity-20261020-7e11a4d5`.
- Consistent SQLite backup and original container configuration: release directory `backup/`.

## Behavior

Chat requests use per-account `maxConcurrentRequests` (default 2), editable through Providers → Edit Connection. Dialogue-prefix affinity retains the selected account while capacity is available. Saturated accounts spill to another account; local saturation can fall through a Combo without opening the upstream provider circuit. Counters release on completion, stream error, cancellation or request abort.

Pre-deployment verification found and repaired saturated affinity pinning, slot leaks on stream errors/cancellation and proxy-resolution errors, a cancellation gap after credential selection, and unbounded affinity-store growth. Tests now exercise three simultaneous requests with the same dialogue prefix, which the preceding integration test did not cover.

## Validation

- 218 targeted tests passed across 9 suites; changed runtime files and tests passed ESLint and `git diff --check`.
- Production Docker build passed on the server. The exact image was tested with a consistent copy of the production database in an isolated container using `--network none`.
- Real built-server HTTP routing against a controlled loopback upstream passed 13 calls: three held-open SSE streams selected A, A, B; a follow-up stayed on B after A became free; full account pools fell through a Combo to another provider without freezing the saturated pair; cancelled streams released reusable slots; the connection edit API saved and returned a limit of 3; non-streaming JSON also succeeded.
- QA and production management checks passed for health, settings, providers, combos, keys, models, model capabilities and usage stats. Authenticated dashboard routes and 17 JS/CSS assets passed, including byte comparisons against image assets. Production checks also passed through the public HTTPS endpoint.
- Cutover waited for `active=0, pending=0`. Health recovered in 5.54 seconds.
- Live production `code-free` JSON and SSE requests returned HTTP 200; SSE included usable content and `[DONE]`.
- Original environment, port bindings and mounts were preserved. Protected configuration fingerprints remained equal: 49 connections, 14 keys, 12 combos, provider nodes, bound proxies and model configuration. SQLite `quick_check` returned `ok`; restart count was 0 and no fatal log markers were detected.
- Temporary QA container and copied QA database were removed; rollback resources and evidence were retained.

## Limits

Concurrency and affinity are in memory and apply to the chat path in one server process. They reset on restart. Identical dialogue prefixes can share an affinity key; context compaction that replaces the prefix can change it. No upstream cache-hit or cost-savings measurement, provider stress test, or browser visual acceptance was performed. Deterministic concurrency checks used an isolated controlled upstream; live checks verified normal inference through existing production configuration.
