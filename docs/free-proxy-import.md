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
