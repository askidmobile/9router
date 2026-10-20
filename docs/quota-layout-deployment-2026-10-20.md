# Responsive quota rows deployment — 2026-10-20

Runtime revision `0081184f27baa4ad3ff248ba1eec089857350159` deployed to `omni-fr` / `https://omni-fr.archteam.org`.

- Image: `9router-local:quota-layout-20261020-0081184f`.
- Image ID: `sha256:c47cf5e8d55a6566151696af006059dced66ae52918a5b4ddc25849ba0fb0f14`.
- Private release evidence: `/root/9router-releases/quota-layout-20261020-0081184f/`.
- Rollback container: `9router-before-quota-layout-20261020-0081184f`.
- SQLite backup and original container configuration: release directory `backup/`.

## Change

The shared `QuotaTable` uses a container query at 30rem (480px). Narrow cards put the quota label and hide action on the first row, the full-width amount/progress/remaining balance on the second, and the reset time below. Wide cards keep the horizontal layout. Labels, amounts, details and reset dates wrap instead of using ellipsis. No quota arithmetic, account settings or routing behavior changed.

## Browser verification

The previous production layout was reproduced at a 375px viewport: amount fields were only 2–18px wide, with the remaining-balance details also clipped.

A local isolated database and controlled upstream responses exercised monthly USD credits, purchased balances, legacy session/weekly quotas and large amounts. Browser checks at 320, 375, 768 and 1440px found no clipped financial fields or horizontal page overflow. This validates the rendered component and CSS, rather than testing implementation class strings.

After deployment, read-only browser checks on `/dashboard/quota?provider=ollama` repeated all four widths against both real Ollama accounts. Each width checked six financial fields and four quota labels: zero clipped elements, zero horizontal overflow, and no application console errors. Additional mobile/touch emulation at 375px also passed. Container widths 254px, 309px and 336px selected the stacked grid; 512px selected the horizontal flex layout. Screenshots were inspected with account names redacted. Temporary authentication was cleared afterward.

## Release verification

30 related quota tests passed. Scoped ESLint passed with the existing `react-hooks/set-state-in-effect` finding excluded; the existing hook logic was not changed. `git diff --check` and the production Docker build passed. The exact image passed isolated QA on a copied production database with networking disabled, including both Ollama balance response schemas and cached/coalesced reads.

Cutover used graceful shutdown; the old container exited with code 0 and health recovered in 8.16 seconds. Local/public HTTPS management endpoints, quota/models/combo pages and 17 JS/CSS assets passed. Both real Ollama account quota endpoints returned usable HTTP 200 responses. Configuration fingerprints, environment, ports and mounts were preserved: 49 connections, 14 keys and 12 combos. SQLite quick-check passed, restart count was 0 and no fatal log markers were found.

Only unused build cache older than 24 hours was removed to free server disk space; runtime data and rollback images/containers were retained. Temporary local preview and server QA container/database were removed. A full accessibility audit and a full provider regression run were outside this CSS change's validation scope.
