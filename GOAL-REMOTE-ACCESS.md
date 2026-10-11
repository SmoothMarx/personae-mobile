# GOAL — Personae Mobile: reach the gateway from anywhere, including 5G

Owner: cody · Repo: `~/Projects/personae-mobile` (React Native + Expo, TypeScript)
Supersedes `GOAL-TAILSCALE.md` (same intent, narrowed after reading the reference app).

**Reference, not template.** `Hermes-Relay` (a mature 825-file Kotlin Android client, upstream
`Codename-11/hermes-relay`, cloned read-only to `~/.hermes/cache/scratch/relay-ref`) already solved
this problem and documented its reasoning. Read it for *what the problem actually is* — then
implement Personae's own, smaller version. **Do not port its code, its QR pairing, or its
multi-connection machinery.** §"What we deliberately do not copy" is binding.

## Ground truth (verified by command on 2026-10-11, not assumed)

| Fact | Value | How verified |
|---|---|---|
| Gateway host tailnet name / IP | `personae-sk` / **100.64.0.11** — **this is the host the gateway runs on** | `hostname`; `tailscale ip -4` |
| Public exposure today | **`:443` is Funnel**, publicly serving `https://personae-sk.tail0000demo.ts.net` → `http://127.0.0.1:8100` (the Pharmacy app). The gateway is **not** exposed. | `tailscale serve status` / `funnel status` |
| Exact tailnet DNS name | `personae-sk.tail0000demo.ts.net` | `tailscale status --json` → `Self.DNSName` |
| Tailscale version | `1.102.4` — `serve` is available | `tailscale version` |
| the user's phone is already on the tailnet | `pixel-8` = **100.64.0.12** (android) | `tailscale status` |
| Gateway listens | **`0.0.0.0:9119`** (pid 1202957) — all interfaces | `ss -ltnp` |
| Consequence | **Tailscale is the only path to the gateway.** There is no internet-facing URL to fall back on. | derived from the two rows above |
| No kanban dispatcher is running on this host | — | `ps -ef`, `systemctl --user` |

## The two problems

**P1 — the middle step.** Today: open the stock Tailscale app → connect → then open Personae.
The app must bring the tunnel up itself.

**P2 — a 5G connection is not a LAN connection.** Cellular means CGNAT, IP changes, radio sleep,
doze, and a tunnel that is only sometimes up. "Unreachable" has several different causes that need
different fixes and different words on screen.

## Design — three parts

### A. Server side: the remote route is the **API server**, not the Dashboard

**Verified service map on this host (2026-10-11, by `ss -ltnp` + `curl` — this corrects the first
draft of this goal):**

| Port | Service | Auth shape | For Personae? |
|---|---|---|---|
| `:9119` | `hermes-serve.service` — Dashboard (browser UI + desktop-app remote gateway) | **cookie**: `401 {"reason":"no_cookie","login_url":"/login"}` | **no** |
| `:9222` | `platforms.api_server` (`api_server.py`) | **bearer**: `401 {"code":"gateway_auth_failed"}` keyed on `API_SERVER_KEY` | **yes — this is what the app calls** |
| `:8644` | `platforms.webhook` | — | no (404 on `/api/sessions`) |

Personae's `apiKey` + `/api/sessions…` bearer calls mean it speaks the **API server on `:9222`**.
Pointing it at `:9119` yields a cookie-auth 401 — which is very likely the unexplained
`GET /api/sessions/{id}` 401 already on the open list. Confirm that and record it.

**`10443` is already taken.** `tailscale serve status --json` shows both:
`…:10443 → http://127.0.0.1:9119` (dashboard) and `…:443 → http://127.0.0.1:8100` (Funnel,
Pharmacy). So `10443` belongs to the **dashboard**, not to the app. Add the app's route on a **free
dedicated port** (e.g. `:10444`) → `http://127.0.0.1:9222`, and leave both existing handlers exactly
as they are. Capture the before/after `tailscale serve status --json` to prove that.

```bash
tailscale serve --bg --https=10444 http://127.0.0.1:9222
```

`tailscale serve` proxies to **loopback**, so the desktop app's local `127.0.0.1:9119` dial and the
existing `:10443` handler both keep working. The `*.ts.net` name carries a publicly-trusted cert, so
the phone gets **real application-layer TLS** with no pinning to maintain.

- Deliver the exact command, the `serve status --json` before/after, and a `curl` proving
  `https://personae-sk.tail0000demo.ts.net:10444/api/health` answers (or the honest failure).
- The app's key must match the API server's `API_SERVER_KEY`. If they differ (check the app's stored
  key — **do not print it**), the 401 is the whole explanation; say so and stop there.
- Only after the route is proven, propose (do not silently apply) binding `9222` to loopback: once
  Serve fronts it, nothing off-host needs the raw port. Same logic as `9119`.

### B. App side: one server, several routes — the part that makes 5G work

Personae's current settings hold a single `baseUrl`. That is wrong half the time: the same gateway is
`http://10.0.0.15:9119` at home and `https://personae-sk.tail0000demo.ts.net:10443` on cellular, and
a single stored URL is wrong in one of those two places. Replace the single URL with:

**An ordered list of route candidates for one logical server**, each with:
- `role` — an **open string**. `lan` / `tailscale` / `public` get styled labels; anything else
  (`wireguard`, `zerotunnel`, …) renders as `Custom (<role>)`. Do **not** enumerate or normalize it.
- `priority` — strict, `0` = highest. **Reachability never promotes a lower priority over a higher
  one**; it only breaks ties between equal priorities. (This is the DNS SRV priority contract.)
- `url` + `insecure` consent flag.

Behaviour: on connect and **whenever the network changes**, probe candidates in priority order and
use the highest-priority reachable one. That single mechanism is what makes walking out of the house
onto LTE hop LAN → Tailscale instead of dying. In Expo/RN the network-change signal is
`expo-network`'s listener (or `@react-native-community/netinfo`); either is acceptable — say which
you used and why.

Plus:
- **Role inference from the address** so the user is not asked to classify their own network:
  `*.ts.net` or a `100.64.0.0/10` address → `tailscale`; RFC1918 (`10/8`, `172.16/12`, `192.168/16`)
  → `lan`; else `public`. Show the inferred role next to each route.
- **Per-route security policy**: a `public` origin must be `https://`. Plain `http://` is permitted
  only for loopback/private-overlay routes, and the raw tailnet-IP route should be described
  accurately — it has no application TLS, but Tailscale's WireGuard data plane still encrypts it, so
  it is **not** "public plaintext". Never label it that way.
- Keep a plain `http://<tailnet-ip>:9119` route as a fallback candidate beneath the Serve HTTPS one.

### C. Bring the tunnel up ourselves (Android)

Port the mechanism from
`~/.hermes/plans/2026-10-11_011500-android-tailscale-broadcast-trigger.md` — **read it, but note it
is written for a native Kotlin app** (DataStore, `PreferenceFragmentCompat`, `./gradlew
:app:testDebugUnitTest`). Every task in it must be re-targeted to RN + Expo. Port the mechanism, not
the code.

- Send the stock client's exported control action — an explicit broadcast of
  `com.tailscale.ipn.CONNECT_VPN` with `setPackage("com.tailscale.ipn")` — from a small native
  module, on launch and on foreground resume. A JS-only implementation cannot do this.
- **`setPackage` is mandatory.** Without it Android 8+ drops the broadcast and *nothing logs an
  error*.
- The broadcast is **fire-and-forget**: `result=0` whether it connected or posted a "please open
  Tailscale" notification. So **readiness must be proven, not assumed**: poll a TCP connect to the
  chosen route until it answers or `connectDeadlineMs` expires. Do not treat `TRANSPORT_VPN` on the
  active network as proof — a competing VPN makes that true.
- Package visibility: sending an explicit broadcast needs no `<queries>`, but **detecting whether
  Tailscale is installed does** — the config plugin must declare `com.tailscale.ipn` in `<queries>`.
- One-time setup is **not removable**: `VpnService.prepare()` consent is per-package and one-time.
  Every launch *after* setup is clean; the first never is. Do not drift into "zero setup".
- Set `USE_EXIT_NODE` **after** the tunnel is up (it resolves the name against the netmap and fails
  `no_peers_found` otherwise). Not needed for a peer target.
- **iOS cannot do this.** There is no cross-app broadcast. The honest iOS path is Tailscale's own
  on-demand setting (enabled once by the user) plus the app detecting and explaining the state.
  State the asymmetry; do not paper over it.

### D. Failure taxonomy and retry discipline (the 5G half)

Distinguish and *show* the cause. These are different problems with different fixes, and today they
all look like "it didn't work":

| Condition | Classification | App behaviour |
|---|---|---|
| 401 / 403 | **permanent** — bad API key | Stop. Say the credential is wrong. **Never retry.** |
| 429 | backoff | Wait the server's period; do not hammer |
| 5xx | server | Retry with backoff; surface it as a server-side problem |
| 404 | wrong route/version | Say the URL does not point at the expected route — do not retry |
| connect timeout / DNS / unreachable | transient | Retry with capped exponential backoff + jitter |

- Never poll while backgrounded; re-probe on foreground.
- Every route probe is per-candidate and cached independently, so one dead route cannot poison a
  healthy one.
- A "status" endpoint answering is **not** proof the route is ready to serve chat.

## Settings to implement

Extend the existing `src/settings.ts` model and `app/settings.tsx`. Keep the app's own shape
(`baseUrl`/`apiKey`/`profiles`) and grow it — do not import a second settings framework.

| Key | Default | Why |
|---|---|---|
| `routes[]` | derived from `baseUrl` on migration | `{role, priority, url, insecure}` — the ordered candidate list |
| `preferredRouteRole` | `null` = Auto | Optional manual pin, e.g. `"tailscale"` |
| `autoConnect` | `true` | Master switch for the launch/foreground tunnel trigger |
| `tailscalePackage` | `com.tailscale.ipn` | Broadcast target; lets a fork swap in without a rebuild |
| `connectDeadlineMs` | `20000` | Wait budget before declaring "setup incomplete" |
| `probeTimeoutMs` | `1500` | Per-attempt timeout |
| `openTailscaleOnFailure` | `true` | Fallback when setup is incomplete |
| `insecureRouteAck` | `false` | Explicit opt-in before using a plain-`http` non-loopback route |
| `everReachedGateway` | `false` (persisted) | Diagnostics: has the whole chain ever worked? |
| `lastTriggerResult`, `lastErrorKind` | — | Diagnostics: what the last attempt actually did |

`app/settings.tsx` must show, separately and visibly: **Tailscale installed / tunnel up / which route
was chosen / gateway answering / setup ever completed / last error kind**. Without that panel,
"wrong port" and "never logged in" are indistinguishable, which is the current situation.

## What we deliberately do not copy from Relay

Relay is a 825-file product with its own pairing protocol. Personae is a small client. Do **not**
implement: the v3 QR pairing payload or its HMAC signature, `EndpointCandidate`'s relay/dashboard/
proxy/broker sub-surfaces, Secure Link (`:9443`, SPKI pins), Hermes Reach (outbound rendezvous
broker), the multi-connection store with per-connection `EncryptedSharedPreferences` + migration, or
any `hermes-relay-*` CLI helper. We take the *route-candidate idea*, the *priority semantics*, and
the *diagnostic honesty* — nothing else.

## Completion condition (all seven must be true)

1. `GOAL`-relevant routes exist in the app as an ordered candidate list with role + strict priority,
   and the chosen route is re-evaluated on a network change. Cite the code by file and line.
2. Role inference (tailscale / lan / public) is implemented and unit-tested against representative
   addresses, including a `100.64.0.0/10` tailnet address.
3. The Tailscale trigger is a real native-module path for Android (broadcast, `setPackage`), with
   readiness proven by TCP probe rather than by a VPN-transport flag. Cite file and line.
4. The failure taxonomy in §D is implemented and tested: **401 is permanent and never retried**,
   timeouts back off with jitter, no polling while backgrounded.
5. The Tailscale Serve command from §A is run, its `tailscale serve status` output is captured, and a
   tailnet `curl` against `:10443/api/health` is recorded with its exit code. If you cannot make the
   route reachable, say so and show what you tried — do not claim a working route you did not probe.
6. `npx tsc --noEmit` exits 0, the existing harness (`npx tsx tests/run.ts`) passes with new tests
   for §1/§2/§4, and a release APK still builds via the existing container workflow (docker image
   `personae-android`) and passes `apksigner verify`.
7. `PROGRESS.md` and `QUESTIONS.md` are updated: PROGRESS states each measured fact with the exact
   command and exit code that produced it; QUESTIONS holds every unresolved unknown instead of a
   guess. `DECISIONS.md` records the route-candidate choice and what was rejected from Relay.

## NOT DONE IF (any one → keep working)

- **It claims iOS auto-connects.** It cannot. `expo-doctor` must still pass as iOS-capable.
- **The tailnet IP is hardcoded.** `100.64.0.11` is an environment fact, not a constant. Nothing in
  `src/` or `app/` may contain it — it lives in the user's route list.
- **The user must still open Tailscale manually** for a normal post-setup launch to work.
- **Retry logic hammers**, or retries after a 401.
- **A number is reported that was not measured** (no command, no exit code).
- **The app requires the live gateway to render.** It must still start and show a specific, visible
  error when the tunnel or the gateway is down.
- **A raw tailnet `http://` route is described as "public plaintext"** — it is WireGuard-encrypted.
- **No hardware and it says so anyway.** A release APK has never been installed or launched on this
  host, and the app has never talked to the real gateway. A device test is the only thing that
  converts "ships" into "works" — if there is no device, state that plainly rather than implying a
  verified end-to-end run.
- It edits the read-only Personae plugin tree (`~/Projects/hermes-desktop-plugins/personae/`).

## Reference provenance (cite these when you use them; do not copy the code)

| What | Where |
|---|---|
| Remote-access modes + decision matrix + setup | `~/.hermes/cache/scratch/relay-ref/docs/remote-access.md` (503 lines) |
| Multi-endpoint pairing, priority semantics (ADR 24, 2026-04-19) | `~/.hermes/cache/scratch/relay-ref/docs/decisions.md` §24 |
| First-class Tailscale helper (ADR 25) | `…/docs/decisions.md` §25 (line 1280) |
| Route-candidate wire model | `…/app/src/main/kotlin/com/hermesandroid/relay/data/Endpoint.kt` |
| Connection model + `:9119` default + role inference | `…/data/ConnectionData.kt` |
| HTTP-status guidance strings | `…/diagnostics/NetworkDiagnosticGuidance.kt` |
| Tailscale broadcast plan (Kotlin — re-target to RN) | `~/.hermes/plans/2026-10-11_011500-android-tailscale-broadcast-trigger.md` |
| Desktop-side prior art: "browse Tailscale devices, connect to remote Hermes instances" | `~/Projects/hermes-r2b/plugin-catalog/hermes-tailscale.yaml` (community plugin, v0.0.6) |
