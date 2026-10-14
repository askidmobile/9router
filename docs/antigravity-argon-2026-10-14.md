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

Live Argon generation awaits account availability. The client IDs are present in the installed binary; account entitlement and upstream inference acceptance are separate checks. Google documentation checked during implementation listed Ultra/Enterprise in the Antigravity app, CLI and IDE extensions, and excluded the Antigravity IDE. The user subsequently confirmed that the three current accounts have Pro subscriptions and reported an Argon rollout during October 14; its actual availability is checked separately below.

Long-decode continuation is not implemented. The existing Antigravity executor's 64,000-token clamp is preserved, even though Google's synchronous upper bound is 65,536. OAuth identity, proxy policy, token refresh, Codex adaptations and passive Combo recovery are retained.

## Production publication

The user authorized push and deployment after the initial source-only verification. `origin/master` was updated to `f331e20f6f78605176bddf823b753fa93aeca06a`, including the five preceding Codex/Combo commits and acceptance documents. Production already ran `d56fa7b2` containing those fixes.

- Release: `/root/9router-releases/argon-20261014-f331e20f/` on `omni-fr`.
- Deployed code: `f331e20f6f78605176bddf823b753fa93aeca06a`.
- Exact image: `sha256:99b8d8d5494eb7c69575b3b7153351f69eb344967c18c266b03aae0c96d12a34`, carrying the source revision label.
- The image passed HTTP QA on a consistent copy of production SQLite with `network=none`: four Codex custom/ordinary-function JSON/SSE cases including continuation, and ten Argon catalogue/routing/schema/thinking cases.
- Cutover used a fresh `active=0`, `pending=0` check. Health recovered in 6.52 seconds. Environment, mounts, ports and saved configuration hashes matched; credentials were retained.
- Backup: `backup/stable-volume.tgz` (SQLite files excluded) plus the separate consistent `backup/data.sqlite`; gzip validation and SQLite `quick_check` passed. Restore requires both.
- Rollback container retained: `9router-before-argon-20261014-f331e20f`. The temporary QA container and copied QA data were removed after acceptance.
- Public HTTPS health passed, restart count was zero, and no fatal startup/runtime/SQLite errors were found.
- Production `/v1/models` exposes all four Argon IDs with 1M context, synchronous output metadata and low/medium/high reasoning levels.
- Live Gemini 3.8 Flash SSE returned HTTP 200 with the expected text and one terminal choice (5.132 seconds). Live APInex GLM Responses returned HTTP 200 and a structured `functions.exec` custom tool call (1.247 seconds).
- Before cutover, all three Antigravity live catalogues returned HTTP 200 (24/24/20 models), with zero Argon entries. Argon inference remains pending the Pro account rollout, rather than being marked live-verified.

An existing Antigravity OpenAI-SSE limitation was independently confirmed: the old production image and the new image emit one terminal `finish_reason` and close without `[DONE]`. The initial QA assertion requiring `[DONE]` therefore failed; QA was rerun with explicit terminal-choice validation after verifying the same behavior on the old live Gemini route. The SSE converter is unchanged by this release; strict clients requiring `[DONE]` still need that separate fix.

Protected server evidence: `acceptance-result.json`, `qa-result.json`, `deployment-result.json`, `live-result.json`, and backup files in the release directory. Local copies of the non-secret acceptance reports are in `/tmp/9router-argon-deploy-20261014.rFfo5m/`. This documentation update follows the deployment and does not change the deployed code revision.
