# OpenAI tool routing fix — 2026-11-04

Deployed to `omni-fr` / `https://omni-fr.archteam.org`.

- Source revision: `f4e5a3090cd45b78d37098c0c9de1b46a0c0c4d2` (`origin/master`).
- Image: `9router-local:openai-tools-20261104-f4e5a309`.
- Image ID: `sha256:2bfab0e18b12383dd7f2cc20c0456546b1b5ebe17f16d0835ea50cbd8701fc79`.
- Rollback container: `9router-rollback` (previous image `sha256:2b933cb3ddbfd777c9375d3e5f1c81a23da07202345235d179a578cdd9ca73f2`).
- Deploy log: `/root/9router-deploy.log` on `omni-fr`.

## Failure

A ZCode request reached `openai/gpt-6-astra` through `/v1/chat/completions` with 179 tools:

```
[400]: Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 179 instead.
```

The same account produced a second deterministic 400 on another request:

```
[400]: Invalid schema for function 'js': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level.
```

## Root cause

Live probes against `api.openai.com` on 2026-11-04:

- `/chat/completions` rejects more than 128 tools for every model tested.
- `/responses` accepts 179 tools and completed normally.
- `gpt-5.6-*` and `gpt-6*` reject function tools on `/chat/completions` with `Function tools with reasoning_effort are not supported ...`.
- `gpt-5-pro`, `gpt-5.4-pro`, `gpt-5.5-pro` and `o3-pro` are not served on `/chat/completions` at all.
- A root-union tool schema (`anyOf` without `type: object`) is rejected on both wires; wrapping it under an object root works. With `strict: true` the wrapped union still fails unless every nested object carries `additionalProperties: false`; dropping strict preserves the schema and is accepted.

9router declared no Responses transport for the `openai` provider, so all Chat clients stayed on the capped endpoint.

## Change

- `open-sse/providers/registry/openai.js`: declare Chat Completions and Responses transports; mark GPT-6, GPT-5.6, `*-pro` and `o3-pro` as Responses-only for tools.
- `open-sse/handlers/chatCore.js`: route an OpenAI Chat request with more than 128 tools to the Responses transport (`OPENAI_CHAT_TOOL_LIMIT` in `runtimeConfig.js`).
- `open-sse/translator/concerns/toolSchema.js`: shared schema normalization — object-root wrapping, strict-mode feasibility, Responses `tool_choice` shape, namespace flattening and name dedupe.
- `open-sse/translator/request/openai-responses.js`: merge top-level tools with `input[].additional_tools`, forward `tool_choice`/`parallel_tool_calls`, keep Responses-only tool fields, and no longer force `stream: true` over the caller's value.
- `open-sse/translator/formats/openai.js`: apply the same schema normalization on the Chat path.
- `open-sse/executors/default.js`: run the normalization at dispatch time, because native Responses passthrough skips the translator.
- `open-sse/handlers/ttsProviders/openai.js`: treat a bare known TTS model id (`tts-1`) as a model rather than a voice; keep the legacy bare-voice form.

## Validation

- Focused suites: 583 passed, 14 expected failures, 74 skipped (30 files), including all translator golden tests.
- Full unit suite: 5062 passed, 10 failed, 22 skipped, 1 todo. The same 10 failures reproduce on the unmodified tree (security audit, custom-model bulk API, combo credit fallback, Headroom Responses skip, two ChatGPT bridge proxy tests, request-details backup); no new failure was introduced.
- Production build (`npm run build`) passed.
- Built standalone server with a copied production SQLite database passed: 179-tool Chat request in JSON and SSE, Responses request with a union `js` tool, two-step tool round-trip (`tool_calls` then tool output), plain GPT-6/GPT-4o/GPT-5.4 chat, embeddings and TTS.
- Live `handleChatCore` checks against the real OpenAI key passed all five scenarios before the deploy.
- Post-deploy public HTTPS checks: 179-tool Chat request HTTP 200 with `OK`; union-schema Responses request HTTP 200 `completed`; tool round-trip returned the weather answer; embeddings HTTP 200; TTS HTTP 200 (valid MP3); STT of that MP3 via `whisper-1` HTTP 200 `Hello.`
- Container healthy, restart count 0, SQLite `quick_check=ok`; 54 connections, 16 keys and 12 combos preserved.

## Limits

- Not every catalog model was exercised through 9router; model-level routing was verified for GPT-6, GPT-5.6, GPT-5.4 and GPT-4o, and the remaining Responses-only entries match live endpoint probes.
- GPT-6/5.6/`-pro` requests now always use `/v1/responses`, including clients that previously received Chat-shaped JSON; the response is translated back to the client format by the existing pipeline.
- Tool-schema normalization can downgrade `strict` to `false` for schemas that cannot satisfy OpenAI's strict subset. The schema itself is preserved.

## Follow-up: reasoning effort shape (same day)

ZCode's next request failed with:

```
[400]: Unsupported parameter: 'reasoning_effort'. In the Responses API, this parameter has moved to 'reasoning.effort'.
```

The new Responses transport did not declare `thinkingFormat`, so `applyThinking` kept the Chat-shaped top-level field. The transport now declares `thinkingFormat: "openai-responses"`, and the dispatch normalizer migrates any leftover `reasoning_effort` into `reasoning.effort` (dropping it for a disabled effort).

- Source revision: `cc4506be`.
- Image: `9router-local:openai-reasoning-20261104-cc4506be`, ID `sha256:e4a46664df0d8d3fb059d5bd13513842c778205f551865e5b62ea23890bf924e`.
- Rollback container: `9router-rollback` (previous image `sha256:2bfab0e18b12383dd7f2cc20c0456546b1b5ebe17f16d0835ea50cbd8701fc79`).
- Tests: 643 focused passed (14 expected failures, 74 skipped); full unit suite 5070 passed with the same 10 pre-existing failures.
- Built standalone server passed the ZCode shape (179 tools + `reasoning_effort: xhigh`, SSE with `[DONE]`), a Responses request with the union `js` tool, and `xhigh`/`high`/`low` across GPT-6 Astra, GPT-5.4 and GPT-4o.
- Post-deploy public HTTPS: 179-tool ZCode-shaped SSE request HTTP 200 with `OK` and `[DONE]`; streaming `tool_choice: "required"` returned `get_weather` with `finish_reason: "tool_calls"`; union-schema Responses request HTTP 200 `completed`.
- Container healthy, restart count 0, SQLite `quick_check=ok`; 54 connections, 16 keys and 12 combos preserved.
- Unrelated 400s in the log are CommandCode `insufficient credits` from an existing Kimi combo member, not this change.
