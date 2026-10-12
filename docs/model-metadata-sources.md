# Model metadata sources

Capability imports and the scheduled provider catalog sync use the same field-wise merge for every provider, including custom connections. The direct models.dev import also uses this merge.

Priority: manual/legacy pins → provider declarations → reviewed manufacturer documentation → models.dev → OpenRouter's public model catalog → registry defaults. Missing fields in a partial refresh do not downgrade previously recorded higher-priority observations. Resetting a manual override reveals the automatic layer.

The public OpenRouter catalog (`https://openrouter.ai/api/v1/models`) is cached for 12 hours in `modelSources`. Requests have a 15-second timeout, share an in-flight fetch and use the last cached result on failure. No account credentials or inference requests are sent. Models.dev retains its existing cache. Cross-provider metadata never imports prices; its limits and protocol choices are supplementary, not proof of support on the selected provider.

Matching uses normalized exact IDs (including free wrappers), canonical slugs, published Hugging Face IDs, reviewed aliases, then unique model ID suffixes. Explicit manufacturer namespaces, dates, preview versions and model sizes are preserved. Ambiguous matches are skipped. `hy4` is a reviewed alias for `tencent/hy4-preview`; it is an identity mapping, not an attestation of a broker's deployed weights.

Manufacturer document snapshots live in `src/lib/modelSources/manufacturer.js`. They carry the document URL and review date (`snapshot: true`); scheduled imports do not pretend to re-read those documents. Add a snapshot only after reviewing the official documentation. The initial snapshot covers Hy4-preview: Tencent publishes 1M context / 64k output, no image/video input, tools, reasoning low/high and a thinking disable switch. `none` represents disabled thinking; OpenRouter explicitly publishes none/low/high in its model catalog. Its API may translate these parameters differently from another provider.

`capability_sources` and `/api/models/caps` expose each value's source, URL, matched model ID, match type, observation/review date, stale/snapshot status and whether it was declared by the current provider. Supplementary sources remain `verified: false`. The editor links CTX, OUT and effort metadata to their sources. The DSH updater accepts the additional observed source types while preserving local pins.

This is a shared mechanism, not a claim that every model has complete public metadata. Unmatched or undocumented fields keep their existing defaults and remain unconfirmed. Providers without a model listing can supplement their registry IDs; no new model names are invented. Automatic sync still requires the provider's existing opt-in setting.
