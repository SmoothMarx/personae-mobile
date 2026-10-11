# DECISIONS — Personae Mobile

the user's calls, recorded so no agent has to re-ask them. Newest last.

## D1 — 2026-10-11 02:1x UTC — Android is FROZEN at v0.1.0

**Decision:** The Android line is frozen at `dist/personae-0.1.0.apk`
(85,610,829 bytes, sha256 `afd2943ad0499dae7c1725fb76a34ada275e3aed72512944e1d34c6edd56ae45`).
It is release-signed, v2-verified, launchable, 4 ABIs, 40/40 tests, tsc clean, expo-doctor 21/21.

**Android gets a v0.2 ONLY if the frontier plan or the Opus audit proves something is
actually broken.** Not for polish. Not for "it would be nicer if". A concrete defect, or nothing.

**Wave 1 therefore = the iOS lane + closing the unproven gaps**, not more Android work.
"(Re)build Android from scratch to get the same APK again" was explicitly rejected.

**Why this matters:** the obvious-looking instruction ("kill the build and restart") was written
against a build believed to be mid-compile. It had actually finished and exited 0. The orchestrator
did NOT kill it. If a later agent reads a stale note about restarting the Android build, this
decision overrides it.

## D2 — 2026-10-11 02:1x UTC — Frontier models: hybrid, and the Opus audit is CAPPED

Frontier models are used for **planning and gates only**. The mechanical build stays on
`deepseek-flash` (cost of the entire Android build: **$0.1492**, measured).

- **Planning** → `stepfun/step-5-preview:free` (Nous Portal). $0.00 measured over 4 calls.
- **Gate of record** → `anthropic/claude-opus-5.5` (Nous Portal), pinned in
  `~/.hermes/config.yaml` at `auxiliary.goal_judge.{provider,model,timeout}`.

**Hard cap: the Opus audit runs to at most $1.50 total, then hard-stops** and reports whatever
verdict it reached. Watchdog: `~/.hermes/cache/scratch/opus_cap_watchdog.py`,
log `audit-cap.log`.

**Measured cost reality — read this before choosing Opus for bulk work:**

| Work | Model | Cost |
|---|---|---:|
| Entire Android build (400-turn budget) | deepseek-flash | $0.1492 |
| Opus audit, **3 API calls** | claude-opus-5.5 | $0.4807 |

The gate costs multiples of the build it audits. The driver is **cache *writes*** (85,476 on the
audit), billed at ~1.25x input rate on Anthropic. **On deepseek cache is nearly free
($0.003/M); on Opus the write side is the expensive end — the caching economics invert between
the two providers.** Do not carry "cache makes it cheap" reasoning across.

**Provenance caveat:** `cost_status: estimated`, `actual_cost_usd: 0.0` — the figure is Hermes'
estimate, not a Nous invoice. Rate source differs between paths (`openrouter_catalog` on a raw
probe vs `provider_models_api` in-session); implied input rate ~$3.77/M. Directionally right,
not confirmed to the cent.

## D3 — 2026-10-11 — `goal_judge` was NOT in run 1's loop

Run 1 was `hermes chat --oneshot`, **not** a kanban `goal_mode` card. `auxiliary.goal_judge` only
fires on goal-loop cards (`tools/kanban_tools.py::_goal_judge_available`). Pinning it is correct
for *future* work; it is **not** a gate on the already-shipped APK. The Opus audit is what applies
Opus to this deliverable. Also note: an unresolvable judge **fails open silently** — so
"the config is set" is never evidence. Probe it with a real call.

## D4 — 2026-10-11 — Remote access: route candidates, and what is NOT taken from Relay

**Decision:** one logical server, an ordered list of route candidates. `{role, priority, url,
insecure}` per candidate; `role` is an **open string** (styled labels for `lan` / `tailscale` /
`public`, anything else renders as `Personalizado (<role>)` and is never enumerated or rewritten).

**Priority is the DNS SRV contract, and the semantics are literal:** lower number wins; candidate
groups are consumed in ascending priority order; **reachability only breaks ties inside one group**
and never promotes a lower priority over a higher one. A lower group is consulted only once every
higher group has failed — which is failover, not promotion. Implemented in
`src/routes.ts::pickByPriority`, pinned by tests 46 and 55.

**Role inference is from the address, never asked of the user.** `*.ts.net` or `100.64.0.0/10` →
`tailscale`; RFC1918 → `lan`; else `public`.

*Documented refinement:* loopback (`127.0.0.0/8`) is inferred as `lan`, not `public`. The brief's
three-way rule sends it to `public`, which would both print a false label and wrongly force it
through the https-only rule for public origins. Loopback is by definition not publicly routable.

**Rejected from Relay (binding, per the brief):** the v3 QR pairing payload and its HMAC,
`EndpointCandidate`'s relay/dashboard/proxy/broker sub-surfaces, Secure Link (`:9443`, SPKI pins),
Hermes Reach (outbound rendezvous broker), the multi-connection store with per-connection
`EncryptedSharedPreferences` + migration, and any `hermes-relay-*` CLI helper. What was taken is
only the route-candidate idea, the priority semantics, and the diagnostic honesty.

## D5 — 2026-10-11 — Settings migration is additive, never destructive

`routes[]` and the connection keys are **added** to the existing secure-store JSON blob, and
`baseUrl` is still written on every save — as a mirror of the highest-priority route. Consequences:

- an older build that knows only `baseUrl`/`profiles`/`model` still reads the blob correctly;
- a newer build derives the route list from `baseUrl` when `routes` is absent or empty;
- so there is no destructive migration step and no moment at which old code reads a format it
  cannot understand (pedro-app-defaults: "never write a new data format while old code can still
  read it").

Unknown or malformed rows are **dropped, not guessed at** (`normalizeRoutes`), and every numeric
field is clamped on read (`connectDeadlineMs` 1–120 s, `probeTimeoutMs` 0,1–10 s).

## D6 — 2026-10-11 — The network-change signal is `expo-network`

`Network.addNetworkStateListener` (`expo-network@~57.0.2`), not
`@react-native-community/netinfo`. Reasons: it is Expo-maintained and autolinked by
`expo prebuild` with no extra native wiring; it is already aligned with this SDK major (a second
native dependency would need hand-keeping); and `expo-network` reports the transport *type*
(wifi vs cellular vs vpn), which is exactly the transition that matters here.

Any transition resets the per-candidate probe cache and re-runs the whole connect policy — the
addresses that answered a moment ago may not be reachable now. Returning to the **foreground** does
the same, and nothing polls while backgrounded (`AppState` is checked before every probe).

## D7 — 2026-10-11 — iOS: the asymmetry is stated, not papered over

There is no cross-app broadcast on iOS, so **no iOS app can raise Tailscale's tunnel**. The honest
iOS path is Tailscale's own On-Demand setting, enabled once by the user, plus this app detecting
and explaining the state. `Platform.OS !== 'android'` shows that note in Settings, and
`expo-doctor` still reports the project iOS-capable.

## D8 — 2026-10-11 — The gateway API is on `:9222`; `:9119` is the dashboard

The brief's ground-truth table states "the gateway listens on `0.0.0.0:9119`". **Measured, that is
not the service Personae talks to.** `:9119` (pid 1202957) is
`hermes dashboard --host 0.0.0.0 --port 9119`, which authenticates with a **session cookie**
(`401 {"error":"unauthenticated","reason":"no_cookie","login_url":"/login"}`). Personae speaks the
**API server**: bearer `Authorization`, `GET /api/sessions → {object:"list",data:[…]}` and the
`{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)",…}}` 401 envelope — that is
`config.yaml → gateway.api_server` on **port 9222**, pid 2240357.

So `tailscale serve --https=10443` was pointed at **`http://127.0.0.1:9222`**, not 9119. The literal
§A command was run first and its output captured; it publishes the dashboard, which the phone cannot
authenticate to with a bearer key. Both variants and their curl evidence are in
`logs/serve-evidence.txt`. This is recorded as measured fact, not as a silent correction — the
brief's own row is what is wrong. Raised in QUESTIONS Q8.

## D9 — 2026-10-11 — The tunnel trigger is a local Expo module, and readiness is a TCP probe

`modules/tailscale-trigger/` is a **local Expo module** (autolinked via
`package.json → expo.autolinking.nativeModulesDir = "./modules"`) exposing five functions:
`isPackageInstalled`, `triggerConnect`, `triggerDisconnect`, `openApp`, `vpnTransportActive`,
`probeTcp`. A JS-only implementation is impossible — the broadcast is a native primitive.

Three things encoded deliberately:

1. **`setPackage(pkg)` on the broadcast is mandatory.** Without it Android 8+ drops the intent and
   nothing logs an error.
2. **The broadcast is not gated on `isPackageInstalled`.** An explicit broadcast needs no package
   visibility; the *detection* lookup does, and `<queries>` is compile-time. Gating the send on the
   lookup would break the documented "point `tailscalePackage` at a fork" case, since the fork is
   invisible to `getPackageInfo`. The two are reported separately.
3. **Readiness is proven by a TCP connect, never by the broadcast result or by `TRANSPORT_VPN`.**
   `sendBroadcast` is fire-and-forget — `result=0` whether it connected or posted a "please open
   Tailscale" notification — and a *competing* VPN makes `TRANSPORT_VPN` true while Tailscale is
   disconnected. `vpnTransportActive()` exists for the diagnostics panel only and is labelled a
   hint.

`USE_EXIT_NODE` was **not** implemented: the target here is a tailnet *peer*, not an exit node, so
it buys nothing and the brief says it is not needed.
