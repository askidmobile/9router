# Free proxy import and provider routing

Proxy Pools downloads up to 20 HTTP proxy candidates per source from Proxifly and
IPLocate. Automatic refresh is enabled by default, starts 30 seconds after server
startup, and repeats every 30 minutes. The Free proxies card also supports a manual
refresh and disabling automatic refresh. `FREE_PROXY_SYNC=off` disables the server
timer, including for isolated local QA.

Sources:

- Proxifly: `https://api.proxifly.dev/proxy?format=json&quantity=20&protocol=http&https=true&anonymity=elite`
- IPLocate: `https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt`

Only literal public IPv4 proxy endpoints are accepted. Discovery rejects private,
loopback, link-local, multicast, reserved/documentation addresses, invalid ports,
and unsupported protocols. Feed downloads have a size limit and timeout and do not
follow redirects. No provider credentials are used for discovery or validation.

Before import, an endpoint must complete an HTTPS request through the proxy to
`https://api64.ipify.org?format=json`, with certificate verification enabled, and
report an exit IP different from the server's direct exit IP. Probes run in bounded
batches. The managed catalog holds at most 40 entries. Failed, unassigned automatic
entries are pruned; entries selected by providers or connections are preserved.
User-created duplicates are never overwritten. A sync never changes a provider
policy or global outbound proxy settings.

## Using a proxy

1. Open **Proxy Pools** and use **Load and check now**, or wait for automatic sync.
2. Open the provider page and enable **Provider proxy**.
3. Select one fixed proxy and save. Rotation defaults to off.
4. For rotation, explicitly choose Round-robin or Random and select at least two
   proxies. Only these saved IDs participate; new imports never join automatically.

Provider-wide proxy routing defaults to off. Existing manually assigned
connection proxies are preserved on upgrade. Saving an explicit disabled provider
policy forces direct routing for that provider, overriding connection/environment
proxy settings. Existing account-selection strategy fields are preserved.

A required proxy never falls back to direct or environment proxies. Fixed mode
does not substitute another address if the selected entry is inactive, deleted,
failed, or stale. Rotation skips unusable entries only within the explicit
selection. Imported health checks expire after one hour. Required routes also
refuse insecure TLS retries even if `STRICT_SSL=false` was set globally.

The routing policy follows the request through credential selection, token
refresh, chat executors, model imports, connection probes, and media cores.
Concurrent provider requests use separate async contexts. External Devin/ZCode
CLI subprocesses cannot enforce this transport policy and fail before launch when
a proxy is required.

API routes:

- `GET /api/proxy-pools/free-sync`: scheduler state and last result.
- `POST /api/proxy-pools/free-sync`: start one non-overlapping sync; returns 202.
- `PATCH /api/proxy-pools/free-sync`: `{ "enabled": true | false }`.
- `GET /api/settings/provider-proxy/:id`: provider policy, defaulting to disabled.
- `PATCH /api/settings/provider-proxy/:id`: `proxyEnabled`, `proxyPoolIds`, and
  `rotateStrategy` (`none`, `round-robin`, or `random`).

These management routes use the existing dashboard authentication guard. Public
proxies can fail or be blocked by the target provider even after validation.
Changing IP does not change account/API-key quotas. HTTPS probes do not prove
that a proxy can sustain long model streams or is accepted by every provider.

## Validation (2026-10-15)

- Production build and standalone asset assembly passed.
- 410 tests passed across 39 suites, including credential-to-chat transport, concurrent provider isolation, TLS, proxy discovery, scheduler and database persistence.
- Live discovery on an isolated local database checked 40 candidates and imported 2 that passed HTTPS/exit-IP validation. Neither provider policies nor global outbound settings were changed by discovery.
- Browser QA verified default-off provider routing, an explicit fixed-proxy save for OpenCode, and Codex remaining disabled.
- The compiled server preserved those policies. Its live-catalog probe with the selected proxy inactive was blocked by the transport and returned the existing static-catalog fallback; no direct provider request was attempted.
- ESLint has no new diagnostics in changed JavaScript files. Eight existing diagnostics remain on the provider/proxy-pool pages.
- A chat request against the compiled server with an inactive selected proxy returned 502 with `direct connection is disabled`, before upstream dispatch. No provider model inference or production deployment was performed.

## Production acceptance (2026-10-15)

- Source revision: `03370476e7294ff83146073ffad417781b82a5e8`. Deployed image: `sha256:0413ed1234a36696955ba21f11b836f9d57e026213ab99832eadb685f5ae762d`.
- The exact image passed offline checks on a production database copy. Cutover
  started with zero active/pending requests; health recovered in
  5.93 seconds. The previous container and a consistent SQLite backup
  are retained for rollback.
- The scheduler started automatically after deployment and fetched 20 candidates
  from each source. All 40 failed the first HTTPS validation pass. A subsequent
  refresh checked another 40 candidates and imported two working IPLocate
  endpoints. Exit-IP checks confirmed egress different from the server's direct IP.
- Live requests for `oc/big-pickle`, `oc/deepseek-v4.1-flash-free`, and
  `oc/mimo-v2.6-flash-free` reached OpenCode through the selected proxies but
  returned `403 FreeTierError`. Muse Spark returned a country restriction.
  An up-to-date client header and canonical session were also tested; successful
  model inference is **not** claimed. Similar current provider-side rejections are
  reported in [OpenCode issue 55483](https://github.com/anomalyco/opencode/issues/55483).
- Concurrent changes to the test provider's saved proxy selection were preserved.
  Source synchronization never assigned provider proxies or expanded a saved
  selection automatically.
- All other provider policies, non-transient account configuration, and their bound
  proxy pools matched their pre-deployment fingerprints after the live checks.
- With the same deployed image and no external network, both an unavailable fixed
  proxy and two unavailable selected round-robin proxies returned 502 before
  upstream dispatch. Production proxy selection was preserved during this check.
- Final health: HTTP 200; SQLite `quick_check`: `ok`; container restart count: 0.

A fixed proxy **address** does not guarantee a fixed exit IP: one public endpoint
observed during verification changed its upstream egress address between probes.
Public proxy availability and provider acceptance remain time-dependent.

## OpenCode Free inference migration (2026-10-15)

OpenCode moved anonymous inference to `/inference/openai/v1/*` and
`/inference/anthropic/v1/messages`. Its legacy Zen console proxy removes the
`public` credential before forwarding; the new anonymous endpoint requires it.
The model listing remains on `/zen/v1/models`.

The free executor now sends the v2 client User-Agent and both session headers,
omits the rejected legacy request header, and encodes accepted descending session
counter bits without losing deterministic conversation affinity. Required `shell`
and `read` declarations use the OpenCode 2.0.29 wire schemas. Caller tools with
recognized names retain their schemas under aliases; tool choices, history and
returned names follow those aliases. Paid OpenCode Go/Zen executors are unchanged.

References:

- [OpenCode console forwarding source](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/lib/inference-proxy.ts)
- [OpenCode request headers](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/model-request.ts)
- [Current interoperability findings and live checks](https://github.com/jasonxu114514/opencode2api/pull/84)
- Tool schema provenance: OpenCode's [shell](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/shell.ts)
  and [read](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/read.ts)
  definitions, wire snapshot cross-checked against opencode2api's captured CLI
  definitions. Original MIT notice is retained in `open-sse/config/opencodeTools.LICENSE`.

A controlled upstream request through a public proxy returned HTTP 200 with the
requested `PROXY_OC_OK` model response. Another selected public proxy reached the
same endpoint but returned HTTP 429. No direct fallback or paid account was used.

### Deployed verification

- Code: `9bb6c3ce61fcdfa93687c9119047338cff12b675`; image:
  `sha256:0f783cfeb4bf615c6bd2514fa637568bab228c4de89424bd74646958bb5d8912`.
- 269 tests passed in 22 suites (one existing TODO). ESLint reported no errors;
  the registry retains its existing anonymous-default-export warning.
- The exact image returned 502 with an unavailable required proxy on an isolated
  production database copy with no external network. Live QA on that copy
  verified a different proxy exit IP, HTTP 200 with `PROXY_OC_OK`, and two
  successful tool-call/history turns preserving the caller's `read(file_path)`
  schema. No tool was actually executed by the diagnostic client.
- Production cutover began with no active/pending requests; health recovered in
  4.75 seconds. The prior container and consistent SQLite backup are retained.
- A production request for `oc/mimo-v2.6-flash-free` through the existing selected
  proxy returned HTTP 200, `finish_reason=stop`, and exactly `PROXY_OC_OK`
  in 21.525 seconds. Routing logs confirm the selected proxy and new inference
  endpoint. The next request through the other selected proxy returned 429.
- The saved OpenCode rotation selection was preserved. All other provider
  policies, stable account configuration and their bound pools matched the
  pre-change fingerprints. No paid provider inference was requested.
- Final health: HTTP 200; SQLite `quick_check`: `ok`; restart count: 0.

The current OpenCode tool-schema fingerprint can change again. Public proxy
rate limits and uptime remain independent of protocol compatibility; a successful
request through one selected endpoint does not establish that every selected
endpoint or every free model will succeed.
