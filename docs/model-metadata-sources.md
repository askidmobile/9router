# Model metadata sources and model selection

CTX, OUT and reasoning refresh only when the user presses Import from provider / Import pricing & capabilities, imports models.dev, or starts the catalog refresh manually. Background jobs refresh prices and available model IDs; they neither fetch the additional official sources nor update capabilities. Existing schedule opt-ins remain unchanged.

The user-triggered refresh fetches OpenRouter's public structured catalog and the live Tencent TokenHub / CloudBase model tables. Named table columns provide context/output and explicitly published capability flags. Published reasoning enums come from structured catalog metadata. There are no static capability snapshots. Observations persist with source URL, matched model ID, fetch date and stale status. A failed fetch or unrecognized document structure retains the last successful cache and reports a warning. The model editor displays warnings and links CTX/OUT/reasoning sources.

Priority: manual/legacy pins → provider declarations → live manufacturer documentation → models.dev → OpenRouter supplement → registry defaults. Partial refreshes do not downgrade previously published provider values. Old reviewed-snapshot observations can be replaced by live observations. Supplementary limits and protocol choices remain unconfirmed for a different broker, and never import that broker's prices.

Identity matching uses exact IDs, canonical slugs, published Hugging Face IDs, reviewed aliases, then unique model ID suffixes. Dates, preview versions, model sizes and explicit manufacturer namespaces are preserved. Ambiguous matches are skipped. `hy4` maps to `tencent/hy4-preview`; this mapping is not an attestation of a broker's deployed weights.

Available catalog models are tagged `catalogOnly: true`; they are not automatically selected. Explicitly adding/importing a chosen model promotes it. Provider lists, Combo selection and `/v1/models` omit catalog-only entries and disabled models. Explicit connection allowlists are honored, including an empty list; selected models from multiple active accounts are combined. Provider IDs and storage aliases refer to the same selected records.

The provider's Delete all models button atomically clears the selected list across its connections and hides selected custom/built-in models. Credentials, metadata and saved aliases remain intact. Explicitly adding a model afterwards selects that model; Active All restores the provider's default list. Existing Combo definitions are not rewritten by clearing a provider list.

`scripts/mark-imported-catalog-models.mjs` classifies historical bulk imports using the pre-import backup. It defaults to a dry run; APPLY=1 takes a new SQLite backup and marks only candidate rows. Pre-existing custom models, live Combo/alias references, named/capability-configured models and explicit manual capability edits remain selected. No model records are deleted.

## Price provenance

Every stored rate carries a provenance record (kv scope `pricingMeta`, one entry per provider and model): `source`, `updatedAt`, optional `url`, `verified`. Ranks are manual (5) → provider catalog (4) → manufacturer docs (3) → models.dev (2) → static tables (1); a weaker source can neither relabel nor overwrite a stronger rate. Rates that were never imported fall back to the static chain (`open-sse/providers/pricing.js`), which now reports the rung that answered: `provider-table`, `free`, `model-table` or `pattern`. Pattern matches are guesses from the model name and are presented as such.

An unpublished cache rate is stored and shown as absent, never as `$0`. Cost calculation still falls back to the input rate; the dashboard states that explicitly ("cache read is not published; billed at the input rate"). Warnings are emitted for zero prices on paid models, output below input, cache read above input, and a provider catalog that disagrees with models.dev by more than 20%.

`GET /api/models/catalog` serves the aggregated snapshot both dashboard views render, so the provider list and the model comparison cannot disagree. It reads only SQLite and static tables — no upstream calls — and is memoised for five seconds, invalidated by a metadata revision bumped on every caps/pricing/custom-model write.

Health status per provider|model comes from rolling hourly counters (kv scope `modelHealth`, seven-day retention) recorded in the request pipeline: successes, 4xx/429/5xx, timeouts and latency. Client cancels are excluded. A live cooldown lock or an open combo circuit overrides telemetry; otherwise the states are `ok` (error rate below 10%), `degraded` (10–50%, or a recent 429/5xx/timeout), `down` (50% or more) and `unknown` (fewer than five samples).

Live provider listings (`GET /api/providers/[id]/models`) are cached for 60 seconds, concurrent misses share one upstream call, direct compatible-provider fetches time out after 20 seconds, and `?refresh=1` bypasses the cache. A failed refresh serves the last good listing marked `stale`.

Metadata completeness still depends on published sources and safe identity matches. Missing fields retain their last known values/defaults and remain unconfirmed. Official document parser changes require a code update if a publisher changes its structure; such changes never replace valid metadata with an error page.
