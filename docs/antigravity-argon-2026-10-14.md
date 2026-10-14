# Antigravity / Gemini 4 Argon — 2026-10-14

## Sources and integration

- Fork baseline: `4d634b1bc984df88c634218f2ff57f4ddb1dac89`.
- Fresh `upstream/master`: `ce4460ef79382bfddb4aa5fc0ff9f3cb0d5f95a8` (`v0.5.99`), already included in the fork. No new master commits were available.
- [Upstream PR #4507](https://github.com/decolua/9router/pull/4507), head `91f92f32fcea15789701dcf08ee24f581a54af9c`, remains open. Its capabilities/pricing approach was adapted, rather than merging its outdated modality and 1M synchronous-output claims.
- [Related Antigravity integration](https://github.com/antiantiops/9router/pull/7), head `b65b08baee33eff2a9b0faee3303a8370c074043`, also remains open. Its catalogue, CLI, MITM and quota surfaces were reviewed against our current code.
- [Official Gemini model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon), [migration/limits](https://ai.google.dev/gemini-api/docs/latest-model), [pricing](https://ai.google.dev/gemini-api/docs/pricing), and [Antigravity availability](https://antigravity.google/docs/models) were checked on this date. Context7 returned older Gemini examples, so Argon-specific details use the official pages.
- Installed `/Applications/Antigravity.app`, version `2.23.0`: read-only inspection of `Contents/Resources/bin/language_server` confirmed `gemini-4-argon`, `gemini-4-argon-high`, `gemini-4-argon-medium`, and `gemini-4-argon-low`.

## Behavior

All four IDs are registered in Antigravity, the standalone CLI, MITM selectors/mappings, and quota display. Existing model entries and default selection are retained. Tier variants use the existing thinking-suffix mechanism; the outbound model has no parenthesized suffix.

Argon advertises a unified 1,048,576-token context and synchronous 65,536-token output, image/PDF/audio/video input, tools, grounding, and low/medium/high reasoning. The shared Gemini thinking adapter clamps unsupported efforts to the model's declared levels; `none` and `minimal` become `low` for Argon, while Flash retains `minimal`.

Official introductory reference pricing is input $2, output $10 (including thinking), and implicit cached input $0.10 per million tokens. The canonical entry and variant pricing share the same values. These rates require an update to $4/$20/$0.20 on 2026-12-01; Antigravity subscription credits are not inferred from API reference pricing.

## Verification

- Before changes: targeted Antigravity/Gemini/Codex/Combo checks, 317 passed and 6 skipped.
- After changes: Argon routing/execute, import, quota and shared thinking checks, 95 passed. Outbound JSON and SSE URLs, exact tier IDs, thinking config, schema sanitization and omission of `requestType: agent` are covered with mocked upstream transport.
- Exact snapshot comparison retained all 97 provider definitions, provider aliases, default models and all 1163 existing model entries, including names, ordering, capabilities, reasoning levels and pricing. Same-ID entries for different modalities are compared in order.
- Full suite before: 4406 passed, 5 failed, 96 skipped. After: 4422 passed, 6 failed, 96 skipped. All original failures remain; the additional `strict-proxy-enforcement` network rejection test passed on an isolated rerun (8/8 tests). No collection errors.
- Original failures: two Cline/ClinePass header snapshots in `golden-url-header.test.js`; two socket/proxy cases in `chatgpt-bridge.test.js`; `backupDbLite` in `request-details-tab.test.js` because the installed `better-sqlite3` binary targets another Node ABI. These paths were not edited.
- ESLint: zero errors; one unchanged `import/no-anonymous-default-export` warning in the provider registry.
- `npm run build` and postbuild succeeded on Node `v22.17.1`; all 152 static pages generated.
- OAuth URL baseline passed. Historical provider/alias baseline files already drifted before this change (`cheaper`, `requesty`, `apinex`, `idToAlias` and `modelKeys`); preservation is proved against the freshly captured fork snapshot instead of rewriting those historical baselines.
- `git diff --check` passed. Reports are in `/tmp/9router-antigravity-20261014.Zv1Qai/` for this workstation run.

## Limits

No production deployment or live Argon generation was performed. The client IDs are present in the installed binary; account entitlement and upstream inference acceptance are separate checks. Google documents Argon for Ultra/Enterprise in the Antigravity app, CLI and IDE extensions, and excludes the Antigravity IDE.

Long-decode continuation is not implemented. The existing Antigravity executor's 64,000-token clamp is preserved, even though Google's synchronous upper bound is 65,536. OAuth identity, proxy policy, token refresh, Codex adaptations and passive Combo recovery are retained.

The change is source-only. Existing unpushed commits are not published as part of this task.
