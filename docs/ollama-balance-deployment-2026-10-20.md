# Ollama balance API deployment — 2026-10-20

Runtime revision `78c61dcb43143425d00646d45275788734af4818` deployed to `omni-fr` / `https://omni-fr.archteam.org`.

- Image: `9router-local:ollama-balance-20261020-78c61dcb`.
- Image ID: `sha256:417f49717bbf884b4a20bee685c51e6591284dfbf734cf7f6ec89a7dd3e9ec0f`.
- Private release evidence: `/root/9router-releases/ollama-balance-20261020-78c61dcb/` (build, isolated QA, real-account probes, browser checks and configuration fingerprints).
- Rollback container: `9router-before-ollama-balance-20261020-78c61dcb`.
- Consistent SQLite backup and original container configuration: release directory `backup/`.

## Checks

81 targeted tests passed across 8 suites. Docker production build succeeded. The exact image passed isolated QA using a copied production database and `--network none`; only Ollama balance responses were replaced with controlled fixtures. Monthly included/purchased USD credit data and legacy session/weekly remaining percentages and reset dates were verified through the built HTTP usage route. Concurrent refresh deduplication and the one-minute cache required only two upstream fixture requests. No deprecated settings-cookie request occurred.

The first cutover attempt waited six minutes for an idle window and exited without stopping production. The successful retry used Next production graceful shutdown: stop admitting new connections, finish existing responses, then replace the container. The old container exited with code 0; health recovered in 7.24 seconds from shutdown initiation.

Production HTTP checks passed locally and through public HTTPS: health, settings, providers, combos, keys, models, capabilities, usage stats, quota/models/combo dashboard routes and 17 JavaScript/CSS assets (verified against image bytes). Environment, ports, mounts and protected configuration fingerprints were preserved: 49 connections, 14 keys and 12 combos. SQLite `quick_check` passed, restart count was 0 and no fatal log markers were detected.

Both configured real Ollama accounts returned HTTP 200 with monthly included credits, exact reset timestamps and purchased balances. One account had available monthly credits; the other was depleted. Both purchased balances were zero. No credentials were included in this document, and account subscriptions, account activation and parallelism settings were not changed.

## Browser verification

Read-only checks on `/dashboard/quota?provider=ollama` used a separate temporary browser session. Two monthly-credit rows and two purchased-balance rows rendered correctly. Displayed balances and remaining percentages matched API responses; reset tooltips matched API timestamps in the browser timezone. Edit Connection retained `Max concurrent requests` and no longer displayed the settings-cookie field. No application console errors or failed network requests were observed; there was one unused-font-preload warning.

Screenshots were inspected at widths 1440, 768 and 375 pixels, without horizontal page overflow. Narrow cards ellipsize some values and labels under the existing layout; this was not redesigned. No baseline screenshots exist, so formal visual regression is inconclusive; a full accessibility audit was not performed.

Real accounts currently use the monthly-credit schema. Legacy session/weekly responses were validated with isolated fixtures, not a real legacy subscription. Balances are point-in-time observations and can change with ongoing traffic. Temporary browser authentication and QA database/container were removed; rollback resources and private evidence were retained.
