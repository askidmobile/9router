# OrcaRouter free tier

Connect **OrcaRouter** in Dashboard → Providers → Free Tier with an API key
from [the OrcaRouter console](https://www.orcarouter.ai/console). Keys start
with `sk-orca-`; 9router sends them as `Authorization: Bearer …`.

The provider uses `https://api.orcarouter.ai/v1/chat/completions`. Both the
`orcarouter` and `orca` routing prefixes work, preserving upstream namespaces:

```text
orca/orcarouter/free
orca/deepseek/deepseek-v4.1-flash-free
orca/z-ai/glm-5.3-flash-free
```

The seeded lineup was checked against the public `/v1/models` catalog on
2026-10-18: the free router, DeepSeek V4.1 Flash, DeepSeek V4 Flash, GLM 5.3
Flash, Tencent Hy4 Preview, Tencent Hy3, and OrcaVerify Text 1.0. OrcaVerify
is an AI-text detector using the Chat Completions interface.

Suggested models refresh the rotating free catalog. **Import Models** reads
the complete authenticated catalog, including paid models. Non-chat entries
remain visible with an explanation and cannot be imported as chat models.
The import stores upstream IDs (for example `deepseek/deepseek-v4.1-flash`),
while chat selectors use routed IDs (`orcarouter/deepseek/deepseek-v4.1-flash`).
Already-added models are recognized using the upstream ID.

Selecting a paid model can incur upstream charges. Keep the `-free` suffix
on free models. Free calls are recorded with zero token cost; imported prices
use the provider's token rates, including cache reads.

Key validation and the connection Test button use an **authenticated**
`GET /v1/models`: the anonymous catalog is public, but invalid keys receive
HTTP 401. A valid key confirms authentication, not inference entitlement.

Free access has per-minute/day limits, a prompt-size cap on the lower tier,
and may require an established GitHub account linked to the workspace owner
or sufficient lifetime paid usage. Limits and available models change;
see [Free Models](https://docs.orcarouter.ai/routing/free-models) and
[the public free-package configuration](https://api.orcarouter.ai/api/free-package/public).
The upstream free router never falls back to a paid model.

OrcaRouter marks the free-access gate (`err_free_access_denied`, HTTP 429) and
prompt cap (`err_free_prompt_cap`, HTTP 400) as `retryable: false`. 9router
preserves the original status and structured reason without an account lock,
an invented retry deadline, or converting the refusal to HTTP 503. Linking
an established GitHub account is an account action in OrcaRouter, not an API-key
validation problem.

Live inference requires a valid key and account access. The public catalog
and an invalid-key rejection alone do not verify generation or streaming.
