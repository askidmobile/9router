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

Suggested models and connection model discovery refresh the rotating free
catalog. They include the free router and `-free` IDs with explicitly zero
prices; paid models are excluded. Custom model IDs still pass through, so
manually selecting a paid ID can incur upstream charges. Keep the `-free`
suffix on free models. Free calls are recorded with zero token cost.

Key validation and the connection Test button use an **authenticated**
`GET /v1/models`: the anonymous catalog is public, but invalid keys receive
HTTP 401. A valid key confirms authentication, not inference entitlement.

Free access has per-minute/day limits, a prompt-size cap on the lower tier,
and may require an established GitHub account linked to the workspace owner
or sufficient lifetime paid usage. Limits and available models change;
see [Free Models](https://docs.orcarouter.ai/routing/free-models) and
[the public free-package configuration](https://api.orcarouter.ai/api/free-package/public).
The upstream free router never falls back to a paid model.

Live inference requires a valid key and account access. The public catalog
and an invalid-key rejection alone do not verify generation or streaming.
