# GOAL-0.10.0 — Personae Mobile: Gateway Settings and the Connection Wizard

Binding brief. This file, not your memory of any other brief, is the contract. Where this file is silent,
the existing repo conventions win. Where this file and the repo disagree, this file wins and you say so in
`PROGRESS.md`.

0.9.1 is shipped and signed (`logs/verify-0.9.1.txt` ends `RESULT: PASS — 0.9.1 verified`,
`dist/personae-0.9.1.apk`). This batch is the user's spec for **Gateway Settings** and the **connection
wizard**, on top of the page 0.9.1 S3 already built (Advanced now lives inside Gateway Settings).

## 0. What "done" means

- `dist/personae-0.10.0.apk` exists, `versionName 0.10.0`, `versionCode 12`, signed with the **same release
  key** as 0.1.0–0.9.1 (so it installs straight over 0.9.1).
- `logs/verify-0.10.0.sh` + `logs/verify-0.10.0.txt`, and the last line of the `.txt` reads
  `RESULT: PASS — 0.10.0 verified`.
- Every item in §2 has a test that **names it** (`"0.10.0 S<n>: <what it asserts>"`), and the app suite is
  **≥ the 0.9.1 floor with no regressions**.
- `server/install.sh --check` still reports **no drift** (this batch should not need to touch it).
- `PROGRESS.md` has a `## 0.10.0` section: what landed per item, every test count, the APK's
  path/bytes/sha256/signer, §3's decisions one line each, and what could not be verified with the reason.

**Do not stop before that.** A failing item is a fix-and-retry, not a stopping point.

Baseline to beat, read from `logs/verify-0.9.1.txt` and `PROGRESS.md`'s `## 0.9.1` (do **not** re-derive it
from memory — if these numbers disagree with the files, the files win and say so):

```
app tests   250/250 passed, 0 failed          (floor 241 before 0.9.1)
server      server/run-tests.sh tests  ->  77 passed
verifier    88 PASS / 0 FAIL, RESULT: PASS — 0.9.1 verified
apk         dist/personae-0.9.1.apk  116926234 bytes
            sha256 757c536e648210fac589c5a00dae008d57d0e6463218ba95acef97f3b9c77cc6
            com.personae.mobile / 11 / 0.9.1
signer      SHA-256 bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26
```

## 1. Standing rules

1. **One commit per item**, message prefixed `0.10.0 S<n>:` and naming the item it closes.
2. **Never print, echo or paste a credential.** Secrets live in `~/.hermes/.env`. The
   verifier asserts *zero* live bearer occurrences and zero host literals in the shipped bundle — keep it
   that way. Any value you ever see is `[REDACTED]` in anything you write.
3. **Do not restart `hermes-serve`.** It serves the live dashboard on `:9119`. Read from it, never bounce it.
4. **English only.** New strings need an EN entry. Leave the PT table in place, unreachable.
5. **Tests are the argument.** Every item's test must fail before the change and pass after. Follow the
   convention exactly: `"0.10.0 S<n>: <what it asserts>"`.
6. **No new dependency, native or JS, without saying so out loud** in `PROGRESS.md` with the reason. A
   native *config* key (iOS `infoPlist`, an Android manifest entry) counts as a native change and is
   declared the same way.
7. **Nothing is verified visually.** No `adb`, no renderer for `app/*.tsx`. Specify every item as a claim
   the suite can prove — plan-as-data, style-array inspection, source-inspection — and put anything that is
   genuinely only visible on a phone in `PROGRESS.md` under **Not verified**, with that reason.
8. **The push work stays parked.** No `google-services.json`, no sender, no Firebase, nothing named "push".
9. **`~/Projects/hermes-desktop-plugins/personae` stays untouched.**
10. **Build with a leash.** `--max-workers=4`, `org.gradle.daemon=false`, long output to `logs/`, sequence
    it: code, then typecheck, then tests, then **one** build at the end.
11. **READ BEFORE YOU BUILD — this batch is mostly wiring, not invention.** These already exist and must be
    **extended, never re-implemented**:
    - `src/routes.ts` — ONE server, SEVERAL routes. Roles (`lan`/`tailscale`/`public`, open string),
      strict `priority`, `inferRole` from the address, `checkRoute`'s per-route security policy,
      `pickByPriority`/`selectRoute` (DNS-SRV: lower priority strictly first, reachability only breaks ties
      *within* a group, an unreachable pin is **bypassed and reported**), `transportSecurityNote`.
    - `src/logic/peers.ts` + `GET /api/plugins/personae-mobile-auth/tailscale/peers` — the host enumerates
      the tailnet; **a phone cannot**. `peerRoute()` already writes a route and refuses a duplicate.
    - `src/native/tailscale.ts` + `modules/tailscale-trigger/**` — the Android-only bridge
      (`isPackageInstalled`/`triggerTailscaleConnect`/`triggerTailscaleDisconnect`/`openApp`/
      `vpnTransportActive`/`probeTcp`). It broadcasts `com.tailscale.ipn.CONNECT_VPN`. It is loaded
      OPTIONALLY and is **absent on iOS, in Expo Go and under Node** — every call must degrade, never crash.
    - `src/connect/wizard.ts` + `src/connect/Wizard.tsx` — the wizard already exists as three inline steps
      (`service` → `sign-in` → `check`) hosted by both `app/connect.tsx` and Settings.
    - `app/settings.tsx` — the gateway page and the Advanced page (0.9.1 S3) already render
      `autoConnect`, `tailscalePackage`, `connectDeadlineMs`, `probeTimeoutMs`, `openTailscaleOnFailure`,
      `insecureRouteAck`, `preferredRouteRole` and the route list.
    - Android cleartext is **already** enabled (`expo-build-properties` → `usesCleartextTraffic: true`).
      Do **not** add a second mechanism.
12. **No live probes against the user's real servers from the test suite.** Tests are plan-as-data or
    source-inspection. Nothing in `tests/` opens a socket to `10.0.0.15`, `100.x` or `:9119`.

## 2. The items

### S0 — the reading, written down

the user's spec says "a dropdown that lists all created connections (both local and remote)". This batch
reads **each route as a connection** (§3.1): the dropdown lists `effectiveRoutes(settings)` ordered by
`orderRoutes`, labelled through `roleLabel`, with `lan` shown as **Local** and `tailscale` as **Remote**.
No new "server" entity, no second storage shape, no credential-per-row.

Asserted by `0.10.0 S0`: the rows the dropdown would draw for a two-route settings object are exactly
`orderRoutes(effectiveRoutes(settings))`; `lan` renders as Local and `tailscale` as Remote; a settings
object with a legacy `baseUrl` and no `routes` yields exactly one row.

### S1 — the Gateway Settings layout (his §3 and §4)

Order inside the gateway page, top to bottom, as data:

1. **Connections dropdown** — one row per route: role label, the address, and a status dot (S2).
2. **Connection status** — KEPT and pinned to the top (§3 of his spec — it stays, it moves up). Populated
   from the **selected** row: origin, role, transport security (`transportSecurityNote`), surface, server
   version + gateway state from `/api/status`, paired-device name and last-seen when known.
3. **The type pills** — Local / Remote. This **is** `preferredRouteRole`, relabelled; the pin and its
   `pin-bypassed` notice already work (`selectRoute`). Hide the pills when the list holds only one role.
4. **"Connection Wizard" button** — the first action below the pills; opens S3.
5. **Advanced** — the 0.9.1 S3 page, last. Its six knobs already cover the user's "granular settings" list;
   the only addition is an optional **dot probe interval** (S2) if it proves necessary — say so if you add
   it.

Asserted by `0.10.0 S1`: the page plan orders dropdown → status → pills → wizard button → advanced; the
status fields resolve from the selected route and not from the active one; a single-role list renders no
pills; the wizard button's handler is the wizard opener and not a navigation away.

### S2 — the status dots

On gateway-page open, probe **each** route once, in parallel: `GET /api/health` (public by design) with
`settings.probeTimeoutMs`, results cached for the life of the screen. States: checking / up / down. No
continuous polling; a re-open re-probes.

Asserted by `0.10.0 S2`: the fan-out issues one probe per row and no more; the per-probe timeout is
`probeTimeoutMs`; an in-flight row reports "checking" rather than "down"; nothing schedules a repeating
timer.

### S3 — the connection wizard

**Entry.** (a) On first launch with no configured connection, open the wizard automatically; (b) a
`personae.wizard.v1` `{ dismissedAt }` flag means a Skip sticks and it never auto-opens again; (c) the
wizard is resumable — its step is stored, so leaving and returning resumes; (d) the S1 button always
reaches it.

**Step 1 — LAN or Remote.** Two cards, his §1.1. Keep the existing three steps of `wizard.ts` reachable
inside either branch; the branch is *which setup path*, not a new route model.

#### S3.1 — LAN
- **Manual entry**: an IPv4 field and a **separate** port field (§2 of his spec). IPv4 accepts digits and
  periods only — reuse `routes.ts`'s `octets()` (4 parts, each ≤255), which is stricter than "numbers and
  periods" and is already tested. Port 1–65535, default 9119. `http://` is appended by the app; a pasted
  `1.2.3.4:9119` splits into the two fields.
- **OR** the existing `personae://` link / QR flow, unchanged.
- **Log in** button: opens the dashboard's `…/login?next=/pair` in the **in-app browser**
  (`expo-web-browser` is already a dependency) and, when the browser returns, **polls `/pair/status?id=`
  and redeems via `POST /pair/redeem`** — so the same-device case completes itself instead of asking the
  user to scan something already on their screen. The QR path stays for cross-device.
- Then the existing sign-in/check steps, then **Test connection**.

#### S3.2 — Remote
- **The install check is Android-only**, same rule as the toggle: `isPackageInstalled` reads Android's
  package manager, the native module has no iOS half, and iOS gives no cross-app visibility at all. On iOS
  the branch goes straight to the peer list / manual entry and lets S3.3 diagnose a phone that is not on
  the tailnet — the only honest signal available there.
- **Peer picker first**: read `GET /api/plugins/personae-mobile-auth/tailscale/peers` through
  `src/logic/peers.ts`, render `{name, ip, os, online}` as the row set, and write the pick through
  `peerRoute()` (duplicate refused). This route needs a paired connection or an owner cookie — so when it
  answers `{available: false, reason}`, fall through to manual entry **and say the reason** (`peers.ts`'s
  vocabulary: `cli_missing`/`timeout`/`cli_error`/`unparseable_output`), never an empty picker.
- **Manual MagicDNS entry**: a hostname field (hostnames are legal here — this is the one field that is not
  IPv4-strict) + the same port field.
- **"Connect the tunnel automatically on Personae open" — ANDROID ONLY** (the user: "apply it to Android,
  hide it from iOS"). The row maps onto the existing `autoConnect` and is **not rendered at all** on iOS —
  no disabled switch, no dead row, no help text apologising for a platform limit. On Android it
  broadcasts `com.tailscale.ipn.CONNECT_VPN` (fire-and-forget — readiness is proven by probing, per
  `triggerTailscaleConnect`'s docstring), so the row's help text says "asks Tailscale to connect", never
  "connects". `openTailscaleOnFailure` — a deep link that starts nothing — stays on both platforms.
- **Test connection**, and map the failure honestly: a timeout against a `100.64/10` or `*.ts.net` target
  reports "Tailscale may be off on this phone", not "wrong address".

#### S3.3 — Test connection (both branches)
Staged, so a failure means something: (1) reachable — the existing `probeTcp`; (2) is-this-Hermes —
`GET /api/status` (public; `auth_required` in `/api/health` and the version/`gateway_state` in
`/api/status` are what the success panel shows); (3) authenticated — one real call with the stored token,
where a **401 means "sign in"**, not "bad address".

#### S3.4 — Support log share (his §1.1.4)
A Share button on the final step: build a redacted bundle and hand it to the **OS share sheet**
(`expo-sharing` is already a dependency). Included: app version, platform + OS version, device model, the
connection timeline with HTTP status codes and durations, server version from `/api/status`, the plugin
list. **Never** included: bearer tokens, cookies, pair codes, message or session content, and full
addresses — IPv4 last octet masked, IPv6 middle hextets masked. The timeline is a capped ring buffer so
the bundle is bounded.

Asserted by `0.10.0 S3`: the wizard's steps are data and step 1 offers LAN and Remote; the IPv4 field
rejects a 3-part and a >255 address and accepts a valid one; the port field is separate and clamps to
1–65535; a pasted `1.2.3.4:9119` splits; the LAN login calls the in-app browser with a `next=/pair` URL
and then polls pair status before redeeming; a manual remote entry accepts a `.ts.net` hostname; the
tunnel row renders on Android and is absent on iOS (not merely disabled); the Tailscale install check is
likewise Android-only; a `100.x` timeout maps to the Tailscale message and
not to the address message; the test is three staged calls with 401 mapped to "sign in"; the share bundle
contains no token/cookie/pair-code and masks the last octet; the dismissed flag stops the auto-open; a
part-completed wizard resumes at its stored step.

### S4 — the iOS platform gap

Android cleartext is already on (§1.11). iOS is not: add to `app.json`'s iOS `infoPlist`
`NSAppTransportSecurity` with `NSAllowsLocalNetworking: true` (**not** `NSAllowsArbitraryLoads`) and an
`NSLocalNetworkUsageDescription` string — without the latter, a LAN request fires the Local Network prompt
and dies, which the test button would otherwise report as a bad address. Declare both in `PROGRESS.md`
(§1.6). Do **not** add an Android network-security config: one mechanism is enough and it already exists.

Asserted by `0.10.0 S4`: `app.json` declares the ATS key with local-networking and no arbitrary-loads, the
usage-description string is present and non-empty, and Android's cleartext setting is unchanged.

### S5 — managing the routes

Rename a route's label, edit its address, delete it, and refuse a duplicate on the manual path exactly as
`peerRoute()` already refuses one. Deleting the route the app is currently on must leave the app in a
defined state (fall back to the next reachable route, or the empty state that offers the wizard). Where a
credential exists it is per-server, not per-route, so **deleting a route must not revoke the token** — say
this in `PROGRESS.md` so it is not mistaken for an oversight. A separate, explicit
"Forget this device on the server" action, if you add one, uses the device's own self-revoke path.

Asserted by `0.10.0 S5`: rename changes the label only; delete removes the row and keeps the credential;
deleting the active route leaves a reachable route selected or the empty state; a duplicate manual add is
refused with the same reason `peers.ts` uses.

### S6 — version, verifier, record

Version pair → `0.10.0` / `versionCode 12` in `app.json`. Copy `logs/verify-0.9.1.sh` to
`logs/verify-0.10.0.sh` and bump: the version pair, the byte count, the sha256, the named-test list (the
new `0.10.0 S<n>` names join it) and the feature strings the bundle check greps for. The `.txt` must end
`RESULT: PASS — 0.10.0 verified`.

## 3. Decisions taken on the user's behalf (one line each in `PROGRESS.md`)

1. **A connection is a route** (S0) — confirmed by the user ("When I said connections, I was referring to
   Routes"). The dropdown shows this app's routes — local and remote — not several
   independent servers with separate credentials. If the user meant *several servers*, that is a later batch:
   it needs a new storage shape and per-server credentials, and only S0/S1/S5 grow.
2. **Failover is already correct and is not rebuilt.** `routes.ts` implements the SRV contract
   (priority group → reachability tie-break → lower group only when the higher is dead) and `selectRoute`
   reports `pin-bypassed` when a preference loses to a working connection. Confirmed with the user
   ("confirm fail-over"): keep it, and keep the bypass **visible**.
3. **The type pills are `preferredRouteRole`**, relabelled Local/Remote — not a second preference.
4. **LAN/Remote is a wizard branch; a route's `role` stays inferred.** `routes.ts:115` states the standing
   decision that the user is never asked to classify their own network, and nothing here reverses it.
5. **Advanced gains nothing mandatory.** The six knobs the user listed already exist; only a dot probe
   interval may be added, and it is called out if so.
6. **The tunnel toggle is Android-only and hidden on iOS** (the user's call). It is not rendered there at
   all — not disabled, not explained; iOS keeps only `openTailscaleOnFailure`, which starts nothing.
7. **The support log is a share sheet only** (the user's call) — no server route, no upload.
8. **Remote-first setup is manual MagicDNS entry** (the user's call); the peer picker is the fast path when a
   connection is already paired, which is the only case it can answer at all.
9. **Version 0.10.0 / versionCode 12** — a feature batch, unlike 0.9.1.
10. **`tailscalePackage` stays the existing knob** — the client's package / broadcast target, not a new
    setting.

## 4. Verification and the build

Run, in this order, and keep the output:

```bash
npx tsc --noEmit                                    # rc 0
npm test                                            # >= 250 + the new 0.10.0 tests, 0 failed
server/run-tests.sh tests                           # >= 77 passed
```

Then the verifier (§S6), then the one build, leashed:

```bash
cd android && ./gradlew assembleRelease --max-workers=4 -Dorg.gradle.daemon=false > ../logs/gradle-v0100.log 2>&1
```

Copy the artifact to `dist/personae-0.10.0.apk`, print its bytes / sha256 / signer SHA-256 beside the
0.9.1 values in `PROGRESS.md`, and confirm `app.json`'s version pair matches the APK's own summary.

## 5. Where everything is

| thing | file |
|---|---|
| the route model, roles, priority, security | `src/routes.ts` — `RouteCandidate` `:26`, `STYLED_ROLES` `:38`, `inferRole` `:125`, `checkRoute` `:161`, `transportSecurityNote` `:185`, `orderRoutes` `:197`, `pickByPriority` `:211`, `selectRoute` `:245`, `effectiveRoutes` `:302`, `nextRoute` `:309`, `moveRoute` `:320` |
| the peer picker | `src/logic/peers.ts` — `PEERS_PATH` `:18`, `PEERS_REASONS` `:21`, `normalizePeers` `:52`, `peerRoute` (used at `app/settings.tsx:440`) |
| the tailnet bridge | `src/native/tailscale.ts` — `triggerAvailable` `:56`, `isPackageInstalled` `:63`, `triggerTailscaleConnect` `:78`; native `modules/tailscale-trigger/android/src/main/java/com/personae/tailscale/TailscaleTriggerModule.kt` — `ACTION_CONNECT_VPN` `:25`, `trigger` `:126`; `<queries>` plugin `modules/tailscale-trigger/app.plugin.js` |
| the wizard, as data | `src/connect/wizard.ts` — `WIZARD_STEP_IDS` `:20`, `wizardSteps` `:30`; the implementation `src/connect/Wizard.tsx`; the other host `app/connect.tsx` |
| the settings screen | `app/settings.tsx` — peer probe path `:440-455`, `autoConnect` `:672`, gateway/advanced pages `:1040-1240` (`preferredRouteRole` chips `:1156`, `tailscalePackage` `:1182`, `connectDeadlineMs` `:1192`, `probeTimeoutMs` `:1205`, `openTailscaleOnFailure` `:1217`) |
| the settings index, as data | `src/settingsPages.ts`, `src/settingsLayout.ts` |
| the model | `src/settings.ts` — `Settings` `:72`, `routes` `:89`, `preferredRouteRole` `:91`, `autoConnect` `:98`, `tailscalePackage` `:100`, `connectDeadlineMs` `:102`, `probeTimeoutMs` `:104`, `openTailscaleOnFailure` `:106`, `insecureRouteAck` `:108`, `SETTINGS_STORE_KEY` `:138` |
| the server half of a peer route | `server/personae-mobile-auth/dashboard/plugin_api.py` (tailscale/peers), pairing `POST /pair/start`, `GET /pair/status`, `POST /pair/redeem`, `GET /devices`, `GET /devices/self` |
| the platform config | `app.json` — plugins `:31`, `expo-build-properties` cleartext `:42-48`, the tailscale-trigger plugin `:50` |
| package version | `app.json:5` version, `:20` versionCode |
| verifier | `logs/verify-0.9.1.sh` + `.txt` — copy the shape, bump the numbers |

## 6. Report

`PROGRESS.md` gets a `## 0.10.0` section in the shape of 0.9.1's: what landed per item, every test count,
the APK's path/bytes/sha256/signer, §3's decisions one line each, and what could not be verified with the
reason. Then stop — that is the finish line.

---

the user's own words for this batch, kept so nobody paraphrases them later:

> 1. The connection wizard should appear upon the user's first open of the app, and there should be a
>    button to initiate it as the first option of Gateway settings.
> 1.1. The workflow of connection wizard should be the following. Ask whether the user wants to set up a
>    local (LAN) or a remote connection.
> 1.1.1. If the user chooses LAN, show a new step to add IP and port numbers OR a Personae:// link or scan
>    the QR code. If they choose QR code or Personae link, use the current flow already in place. If the
>    user manually inserts IP and Port, show the "login" button that redirects to the hermes dashboard page,
>    where they can login to authenticate their Personae session. In the end, include a test connection
>    button so the user can test if their settings are correct
> 1.1.2 If the user chooses Remote, check for a Tailscale installation in the user's device. If they have
>    it, scan to get a list of devices available. If not, request the user to log into so you can scan it.
>    Step 2, show the list of devices for user to choose and include a Port number field for them to fill
>    in. Show the option to "Connect to tunnel automatically on Personae open"
> 1.1.3. In the end, include a test connection button so the user can test if their settings are correct
> 1.1.4 Include a support log share button, so the user may share their troubleshooting with their own
>    hermes instances.
> 2. All IP address fields should only allow numbers and periods. The "http://" prefix should be
>    automatically appended by the app. The port number field should be separated from the IP field
> 3. Keep the Connection status Section, put it on the top.
> 4. The layout of Gateway settings should be: A dropdown that lists all created connections (both local
>    and remote) along with a status dot indicating their connectivity status. Upon selection of one, the
>    Connection status section appears, populated with information regarding the selected connection.
>    Underneath the Connection status section will be the pills so the user can choose which type of
>    connection to prioritze (local or remote) and after that, the "Connection Wizard" button to trigger
>    the connection wizard, and the Advanced dropdown after that, which includes all granular settings,
>    such as Tailscale package, maximum wait, etc.
