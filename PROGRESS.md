# Personae Mobile — PROGRESS

Owner: cody. Brief: `SPEC.md` (Crabby, approved 2026-10-11). This file is the continuation record:
phase, what changed, **measured** evidence, next step. Numbers are measured, never estimated.

Working dir: `~/Projects/personae-mobile`. `~/Projects/hermes-desktop-plugins/personae` was read but
never written (read-only per SPEC §7).

---

## P0 — API contract derived from source (no guessing)

Read from `~/.hermes/hermes-agent/gateway/platforms/api_server.py` (4646 lines) and
`.../platforms/api_server_openai_routes.py`. Every shape in `src/api/client.ts` cites a line number.

| Fact | Source |
|---|---|
| Route table (35 routes) | `_http_route_table` :1745-1792 |
| `GET /api/sessions` → `{object:"list",data,limit,offset,has_more}` | `_handle_list_sessions` :3091-3143 |
| Session field allow-list (`safe_keys`, 26 fields) | `_session_response` :3011-3043 |
| `GET /api/sessions/{id}/messages` → `{object,session_id,data,pagination}`, max 500 | `_handle_session_messages` :3295-3328 |
| Message field allow-list (13 fields) | `_message_response` :3046-3052 |
| `POST /api/sessions` → 201 `{object:"hermes.session",session}`; 409 `session_exists` | `_handle_create_session` :3146-3211 |
| `POST /api/sessions/{id}/chat` → `{object,session_id,message:{role,content},usage,runtime}` | `_handle_session_chat` :3595-3637 |
| SSE request body `{message}` (`message` or `input`) | `_session_chat_user_message` :663-671 |
| SSE frame encoding `[id:][event:]<data: json>\n\n` | `_sse_frame` :258-264 |
| SSE event names: `run.started, message.started, assistant.delta, tool.progress, tool.started/completed/failed, assistant.commentary, approval.request, assistant.completed, run.completed/failed/cancelled, error, done` | `_handle_session_chat_stream` :3692-3738 |
| SSE keepalive comment `": keepalive\n\n"` every 10 s | :3747-3750 + `CHAT_COMPLETIONS_SSE_KEEPALIVE_SECONDS` |
| Auth `Authorization: Bearer <API_SERVER_KEY>`; 401 body `{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)","type":"gateway_auth_error","code":"gateway_auth_failed"}}` | `_check_auth` :1586-1608, `_auth_failed_response` :1580-1584 |
| Error envelope `{"error":{message,type,param,code}}` | `_openai_error` :933-936 |
| **Profile rejection uses a DIFFERENT envelope:** `{"error":"Unknown or unconfigured profile"}` 404 | prefix middleware :1726-1727 |
| Multiplex prefix mounts every route at `/p/<profile>/<path>` | :4516 |
| `GET /v1/health` is the only route **without** auth | :2452-2454 (no `@_require_auth`) |
| `?limit` **without** `?order` returns the OLDEST page (not the newest) | :3314-3316 (`latest_page` only when `order=="latest"` or no limit) |

Two findings worth keeping: the **profile-rejection envelope is a bare string**, not the object
envelope (the client handles both, tested); and **`unread` is accepted by `PATCH /api/sessions/{id}`
but never returned** by `_session_response`, so no server-side unread count exists (see QUESTIONS Q1).

## P1 — Scaffold

- `package.json`: expo **57.0.27**, react-native **0.86.3**, react **19.2.3**, expo-router 57.0.25,
  expo-secure-store 57.0.4, react-native-sse 1.2.1, 12 deps + 3 devDeps. `package-lock.json`
  committed: **284,944 bytes**.
- `npm install` exit **0** (`logs/install.log`: `added 499 packages in 24s`, then `EXIT_expo_install=0`).
- `node_modules` 425 MB. `npx tsc --noEmit` → **exit 0**, 0 errors.
- iOS remains capable: `eas.json` present, no Android-only API in shared code (`app.json` keeps
  `ios.bundleIdentifier`), no `android/`-only import outside the generated project.
- `app/` uses expo-router (`expo-router/entry`), 4 route files.

## P2 — API client + offline mock

`src/api/` — `client.ts` 378 lines, `transport.ts` 182, `errors.ts` 108, `sse.ts` 95, `display.ts` 12.
`mock/server.mjs` 297 lines: a Node http mock of the gateway (sessions, messages, create, chat,
chat/stream SSE with keepalive, 401/404/409 envelopes, `/p/<profile>/` prefixing incl. fail-closed
404 for an unserved profile).

Transport: `xhrTransport` (app, XMLHttpRequest `readyState 3`, real `abort()` for the Stop button) and
`nodeTransport` (tests). **Both feed the same `SSEParser`**, so the framing logic the offline suite
exercises is the framing logic the phone runs. `react-native-sse` is installed but deliberately not
wired; it is the drop-in fallback if XHR streaming misbehaves on the device (recorded in QUESTIONS Q3).

## P3/P4/P5 — Roster, Thread, Settings

- Roster (`app/index.tsx` 530 lines): contacts row (status dot from unauthenticated `/v1/health`,
  "new since last visit" badge), sessions from `GET /api/sessions` grouped by day newest-first,
  **25 per page** with `Página 1 de N · from–to de M`, inline new-session panel, pull-to-refresh,
  empty state, error card, unconfigured state.
- Thread (`app/thread/[id].tsx` 371 lines): history from `GET .../messages`, user/assistant bubbles,
  consecutive tool rows collapsed into one expandable row, composer, send, live token rendering from
  `assistant.delta`, **Stop** button that aborts the stream, blocking-fallback on stream failure.
- Settings (`app/settings.tsx` 322 lines): base URL, API key (secure-store, redacted display +
  reveal), extra profiles (the multiplex prefix), model override. Field-level autosave (400-700 ms
  debounce, no Save button), "effective value" shown under every field, destructive key deletion
  behind a confirm, per-profile "Testar ligação" with version + latency.
- Language: **PT-PT**, one string table (`src/i18n.ts`, 124 lines) — see QUESTIONS Q4.

## P6 — Errors

Every failure has a plain-language sentence plus the technical detail, and nothing self-dismisses:
401 (key rejected, profile-named variant), 404 (session/route/profile), 400 with the server's own
message, 5xx, network (names the detail), timeout (20 s JSON / 45 s stream stall), bad JSON, plus
`config` errors raised before any request (missing/invalid base URL, missing key). Notices stay on
screen until the user closes them.

### Test evidence (real output, `npm test`)

`tsx tests/run.ts` → **40/40 passed, 0 failed**; `npx tsc --noEmit` → **0 errors**.

Counts: 6 SSE framing · 14 client/mock (health, list, messages, create, 400/401/404/409, network,
config, profile prefix, profile 401, unserved-profile 404) · 3 streaming (assemble+close, abort
mid-flight, 500 → ApiError → blocking fallback answers) · 10 roster · 3 thread · 3 format ·
2 settings persistence.

This is **mock-server evidence only**. No key exists in this build, so the live gateway was never
contacted (see "What could NOT be verified").

## P7 — Android release build

- Host probe: Node **22.23.1**, npm 10.9.8, Docker **29.6.2**, **no** Java, **no** Android SDK,
  79 GB free, 12 cores, 7.0 GB RAM available.
- Base image `ghcr.io/cirruslabs/android-sdk:36` (measured): JDK **21.0.9**, `ANDROID_HOME=/opt/android-sdk-linux`,
  platform **android-36**, build-tools **36.0.0**, **no node, no gradle, no NDK**.
- So a derived image `personae-android:1` adds Node **22.23.3** + NDK **27.1.12297006** + cmake
  **3.22.1** (the NDK is required: `react-native-screens` ships 49 `.cpp` files).
- `npx expo prebuild -p android --no-install` → **exit 0** (twice; the second run removed the
  deprecated `edgeToEdgeEnabled`/`userInterfaceStyle` warnings from `app.json`).
- Generated contract: `compileSdk 36`, `targetSdk 36`, **`minSdk 24`** (from
  `expo-modules-core/android/ExpoModulesCorePlugin.gradle:68`), `applicationId com.personae.mobile`,
  `versionCode 1`, `versionName 0.1.0`, Gradle wrapper **9.3.1**, `reactNativeArchitectures` = 4 ABIs.
- Signing: keystore generated **outside the repo** at
  `~/.personae-android/personae-release.keystore` (**2716 bytes**, alias `personae`, RSA 2048,
  10000 days, SHA-256 `BD:40:E0:05:44:D6:24:9C:90:41:9A:C0:57:36:C5:B9:88:22:1A:B4:3B:2E:EC:F0:93:97:8C:CF:6D:D3:7F:26`),
  password in `~/.personae-android/keystore-password.txt` (mode 600). `android/app/build.gradle` was
  patched to sign `release` with that keystore from **environment variables only**, and to fall back
  to the debug key *with a printed warning* if it is absent — never to pretend otherwise.

### P7 result — two build attempts, one real defect found

Run 1 — `:app:assembleRelease` → **BUILD FAILED in 8m 40s**. 350 tasks; every native task passed
(all 4 ABIs compiled), and the failure was the JS bundling step:

```
> Task :app:createBundleReleaseJsAndAssets
Error: Unable to resolve module node:http from /work/src/api/transport.ts
```

Metro resolves `require`/`import` **statically**, so a lazily-called `require('node:http')` inside
`nodeTransport` (in the same file the app imports) is still resolved at bundle time. Fixed by moving
the Node transport to `src/api/transportNode.ts`, imported **only** by `tests/`. The app file
`src/api/transport.ts` now has no `node:` import at all.

Also found and fixed before rebuild (measured, not assumed):

- `android/app/src/main/AndroidManifest.xml` had **no** `usesCleartextTraffic` — only the
  `debug`/`debugOptimized` manifests do. The first release build would therefore have **blocked every
  `http://` request** on Android 9+, i.e. a roster that could never load. Fixed with the supported
  `expo-build-properties` plugin (`android.usesCleartextTraffic: true`, `app.json`); verified present
  in the built APK's manifest (`aapt2 dump xmltree` → `usesCleartextTraffic(0x010104ec)=true`).
- `expo-doctor` reported 2 failures (app config schema: `newArchEnabled` and
  `android.usesCleartextTraffic` are not valid SDK 57 fields; and a `typescript` major mismatch).
  Both fixed → **21/21 checks passed**.
- `tsc` 5.9 → 6.0.3 required removing the unused `baseUrl`/`paths` from `tsconfig.json`.

Run 2 — the same command → **BUILD SUCCESSFUL in 7m 11s** (412 actionable tasks).

## P8 — the APK, measured

Commands and their real results (all run against the artifact on disk, nothing from memory):

```
docker run --rm --env-file ~/.personae-android/build.env \
  -v ~/Projects/personae-mobile:/work -v ~/.personae-android/gradle:/root/.gradle \
  -v ~/.personae-android:/signing:ro -w /work/android personae-android:1 \
  bash -lc './gradlew :app:assembleRelease --no-daemon --console=plain'     # BUILD SUCCESSFUL, 7m 11s

# re-run of the identical command (warm Gradle cache, proves the lane repeats):
#   BUILD SUCCESSFUL in 36s · 412 actionable tasks (26 executed, 386 up-to-date) · GRADLE_EXIT=0

cp android/app/build/outputs/apk/release/app-release.apk dist/personae-0.1.0.apk   # exit 0
sha256sum dist/personae-0.1.0.apk
stat -c '%s' dist/personae-0.1.0.apk
$ANDROID_HOME/build-tools/36.0.0/aapt2 dump badging dist/personae-0.1.0.apk
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs dist/personae-0.1.0.apk
apkanalyzer manifest min-sdk | manifest target-sdk | apk summary
```

| Measured fact | Value |
|---|---|
| Path | `~/Projects/personae-mobile/dist/personae-0.1.0.apk` |
| Bytes | **85,610,829** |
| sha256 | **afd2943ad0499dae7c1725fb76a34ada275e3aed72512944e1d34c6edd56ae45** |
| package | `com.personae.mobile` |
| versionCode / versionName | **1** / 0.1.0 |
| minSdk / targetSdk / compileSdk | **24** / 36 / 36 |
| Native ABIs | arm64-v8a, armeabi-v7a, x86, x86_64 (universal — installs on any phone) |
| Signer | `CN=Personae Mobile, OU=Mobile, O=Personae, L=Lisboa, C=PT`, SHA-256 `bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26` — **matches the Personae release keystore**, not the debug key |
| Cleartext HTTP | `usesCleartextTraffic=true` present in the shipped manifest |
| Contents | `assets/index.android.bundle` 2,139,544 bytes; 1254 zip entries, 111,944,419 bytes uncompressed |
| Bundle is ours, and key-free | contains `chat/stream` and `personae.lastSeen.v1`; no `API_SERVER_KEY=` literal and no `sk-…` token anywhere in the bundle |

`npx expo-doctor` → **21/21 checks passed**. iOS capability kept: `eas.json` present,
`ios.bundleIdentifier` set, and the only `Platform.OS` uses are the keyboard-avoidance offsets in
the thread screen.

## What could NOT be verified

1. **The live gateway.** There is no API key in this build and none was available, so the app has
   **never** talked to the real gateway. Every functional claim above is **mock-gateway evidence**
   (`mock/server.mjs`), which reproduces the shapes and error envelopes derived from the server
   source — it is not evidence about the running service.
2. **On-device rendering and install.** No Android device and no emulator exist on this host, so the
   APK has not been installed or launched by me. The render layer was never executed on real
   hardware; what was tested is the client, the SSE parser, the error mapping and the pure screen
   logic. Specifically untested on hardware: whether XHR delivers SSE incrementally on Android (the
   blocking-fallback path exists for exactly this, and `react-native-sse` is installed as a drop-in
   replacement — QUESTIONS Q3).
3. **Real profile names / real session data.** Never touched.

## Next step

Hand the APK over; if it fails to install, the first thing to check is Android version (the APK
needs **Android 7.0 / API 24** or newer) and the "install unknown apps" permission for whichever app
opens the file. If it installs but the roster never loads, open Definições and press
**Testar ligação** — it reports, per profile, the exact HTTP status and message the phone received.

---

# P9/P10 — Remote access: reach the gateway from anywhere, including 5G

Brief: `GOAL-REMOTE-ACCESS.md`. Every fact below was produced by a command on this host; the command
and its exit code are given with it. Nothing here is estimated.

## P9 — Server side: the tailnet route, and a correction to the brief

**The brief's ground-truth row is wrong, and that matters.** It states the gateway listens on
`0.0.0.0:9119`. Measured:

```
$ ss -ltnp | grep 9119
LISTEN 0 2048 0.0.0.0:9119 ... users:(("hermes",pid=1202957,fd=10))
$ ps -p 1202957 -o cmd --no-headers
... hermes dashboard --host 0.0.0.0 --port 9119 --skip-build --no-open     # exit 0
$ curl -sS http://127.0.0.1:9119/api/sessions                              # exit 0
{"error":"unauthenticated","detail":"Unauthorized","reason":"no_cookie","login_url":"/login"}
```

`:9119` is the **dashboard** (session-cookie auth). Personae speaks the **API server** — bearer
`Authorization`, `/api/sessions → {"object":"list",…}`, the `gateway_auth_failed` 401 envelope — and
`config.yaml` puts it on **`:9222`**:

```
$ grep -n -A2 'api_server' ~/.hermes/config.yaml     # gateway.api_server
925:  api_server:
926:    enabled: true
927:    extra: {host: 0.0.0.0, key: <redacted>, port: 9222}
$ ss -ltnp | grep 9222     # exit 0
LISTEN 0 128 0.0.0.0:9222 ... users:(("hermes",pid=2240357,fd=159))
```

| Fact | Value | How verified |
|---|---|---|
| Host / tailnet IP | `personae-sk` / `100.64.0.11` | `hostname`; `tailscale ip -4` (exit 0) |
| Tailscale version | `1.102.4` | `tailscale version` (exit 0) |
| `:9119` | `hermes dashboard` — cookie auth | `ps`, `curl` above |
| **`:9222`** | **`hermes gateway api_server` — bearer auth = Personae's gateway** | `config.yaml`, `ss`, `curl` |
| `:443` before | Funnel → `http://127.0.0.1:8100` (Pharmacy) | `tailscale serve status` (exit 0) |
| `:10443` after | tailnet-only → `http://127.0.0.1:9222` | `tailscale serve status` (exit 0) |

**Commands, with their real exit codes:**

```
$ tailscale serve --bg --https=10443 http://127.0.0.1:9119     # exit 1
sending serve config: Access denied: serve config denied
Use 'sudo tailscale serve ...'.  To not require root, use 'sudo tailscale set --operator=$USER'

$ sudo -n tailscale serve --bg --https=10443 http://127.0.0.1:9222   # exit 0
https://personae-sk.tail0000demo.ts.net:10443/
|-- proxy http://127.0.0.1:9222

$ tailscale serve status                                        # exit 0
https://personae-sk.tail0000demo.ts.net:10443 (tailnet only)
|-- / proxy http://127.0.0.1:9222
https://personae-sk.tail0000demo.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:8100          <- the pre-existing Funnel entry, UNTOUCHED
```

`sudo` was used for **that one command** rather than
`tailscale set --operator=$USER`, which would be a persistent privilege change. `serve` proxies to
loopback, so the desktop app's own `127.0.0.1:9119` dial is unaffected.

**The literal §A command was run first and captured** (it publishes the dashboard, which a phone
cannot authenticate to with a bearer key); both variants are in `logs/serve-evidence.txt`.

**Tailnet proof of the API route** (each line = one command, all exit 0):

| Request | Result |
|---|---|
| `curl https://personae-sk.tail0000demo.ts.net:10443/v1/health` | **200**, `ssl_verify=0`, `remote_ip=100.64.0.11` — `{"status":"ok","platform":"hermes-agent","version":"0.21.5"}` |
| same, `/api/sessions`, no auth | **401** `{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)","code":"gateway_auth_failed"}}` |
| same, `/api/sessions`, `Authorization: Bearer <key>` | **200**, `object=list`, **52** sessions |
| same, `/api/sessions/<id>/messages?order=latest&limit=1` | **200**, `object=list`, 1 row |
| same, `/api/health` | **404** — that endpoint is dashboard-only, evidence of the finding above |
| `curl -H 'Authorization: Bearer <key>' http://100.64.0.11:9222/v1/health` | **200** — the raw tailnet route works (WireGuard-encrypted, no app TLS) |

So the tailnet route to the gateway is **reachable and serves the app's real read paths**, with a
publicly-trusted cert (`ssl_verify=0`).

## P10 — App side

### Routes, priority, role inference, failure taxonomy

| Deliverable | Where (verified line numbers) |
|---|---|
| Route candidate model + open-string role + styled labels | `src/routes.ts:26` (type), `:38` (`STYLED_ROLES`), `:40` (`roleLabel`) |
| `inferRole` (`.ts.net` / `100.64.0.0/10` → tailscale, RFC1918 → lan, else public) | `src/routes.ts:125` |
| Strict priority: reachability breaks ties **within** a group, never promotes across groups | `src/routes.ts:211` (`pickByPriority`), ordered at `:197` |
| `selectRoute` + explicit `pin-bypassed` report | `src/routes.ts:245` |
| Per-route security policy (public http refused; private http needs the ack) | `src/routes.ts:161` (`checkRoute`) |
| Honest transport security note (tailnet http = WireGuard, never "public plaintext") | `src/routes.ts:185` (`transportSecurityNote`) |
| Candidate-list derivation from a legacy `baseUrl` | `src/routes.ts:277` (`routesFromBaseUrl`), `:284` (`normalizeRoutes`), `:302` (`effectiveRoutes`) |
| Failure taxonomy (§D) | `src/api/failures.ts:34` (`classifyStatus`), `:50` (`classifyApiError`), `:64` (`shouldRetry`) |
| Retry policy: 401 never retried, jittered backoff, no retry while backgrounded | `src/api/failures.ts:85` (`retryDelayMs`), `:119` (`nextDelayMs`), `:185` (`attemptWithPolicy`) |
| Connect engine: priority probing, per-candidate cache, deadline, foreground gate | `src/connectivity.ts:84` (`createProbeCache`), `:182` (`connectThrough`), `:304` (`probeRoute`) |
| Network change (`expo-network`) + foreground re-probe, background cancels | `src/ConnectivityContext.tsx:116` (provider), `:145` (`addNetworkStateListener`), `:156` (`AppState`) |
| Native Android module (broadcast + TCP probe) | `modules/tailscale-trigger/.../TailscaleTriggerModule.kt:40` (class), `:86` (`probeTcp`), `:126` (`trigger`), `:132` (`setPackage`) |
| `<queries>` config plugin | `modules/tailscale-trigger/app.plugin.js` |
| Settings model + defaults | `src/settings.ts:16` (type), `:60` (defaults), `:85` (`settingsForRoute`) |
| Non-destructive persistence + migration from `baseUrl` | `src/settingsStore.ts:35` (load), `:72` (save) |
| Routes editor + state panel | `app/settings.tsx:275` (Rotas), `:467` (Estado da ligação) |

**Network-change signal: `expo-network@57.0.2`, `Network.addNetworkStateListener`** (not netinfo) —
reasons in DECISIONS D6.

### Test evidence (real output)

```
$ npx tsc --noEmit                     -> exit 0, 0 errors
$ npx tsx tests/run.ts                 -> 60/60 passed, 0 failed
$ npx expo-doctor                      -> 21/21 checks passed
```

The suite went from **40 to 60** tests. New: 7 routes/priority/security/inference
(§1/§2: tests 44-50), 4 failure-taxonomy (§4: 51-54), 6 connect-engine (§1/§4: 55-60). Pinned
behaviours include: *reachability never promotes a lower priority over a higher one*; a **401 stops
the whole run after exactly one probe and no other route is tried**; a 404 kills only that candidate;
`retryDelayMs` is capped and jittered; **nothing is probed or retried once backgrounded**; the
deadline is respected; one dead route cannot poison a healthy one.

`expo-doctor` initially dropped to **20/21** because the local module's `android/` directory was
hidden by the bare `android/` .gitignore rule. Fixed with `/android/` (top-level only) → **21/21**,
iOS still capable.

### P10 build — one real defect found, and the artifact

The regenerated `android/` loses the release-signing patch, so `scripts/patch-android-signing.sh`
was re-applied first (idempotent, exit 0) → the build logs
`Personae: release build signed with /signing/personae-release.keystore`.

**Attempt 1 failed and the cause was measured, not guessed.** `:app:assembleRelease` (4 ABIs,
parallel) died at `:react-native-reanimated:compileReleaseJavaWithJavac FAILED` with **no Gradle
failure summary at all** — the signature of the JVM being killed rather than javac finding an error.
Evidence: `free -h` showed **swap 14Gi/15Gi used**, and the machine runs dozens of other containers.
`expo-router` requires `react-native-reanimated` (verified in `package-lock.json`), so this was
memory pressure, not the new code.

**Attempt 2 succeeded** by serialising the build:

```
$ docker run --rm --env-file ~/.personae-android/build.env \
    -e GRADLE_OPTS='-Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m' \
    -v ~/Projects/personae-mobile:/work -v ~/.personae-android/gradle:/root/.gradle \
    -v ~/.personae-android:/signing:ro -w /work/android personae-android:1 \
    bash -lc './gradlew :app:assembleRelease --no-daemon --console=plain --no-parallel --max-workers=1'
BUILD SUCCESSFUL in 5m 11s · 605 actionable tasks: 111 executed, 494 up-to-date
```

**Then rebuilt once more, deliberately** (`BUILD SUCCESSFUL in 1m 14s · 605 actionable tasks: 60
executed, 545 up-to-date`, log `logs/gradle-v03c.log`): a review pass found that removing a route
from the Settings list deleted by **URL**, which would also delete a second route legitimately
sharing that URL. It now deletes by object identity. That is an app-source change, so the artifact
was rebuilt rather than shipped out of sync with its source — the numbers below are from **this**
build. Both builds are release-signed with the same keystore; only the JS bundle differs (2,308,272 →
2,308,256 bytes).

| Measured fact | Value | Command |
|---|---|---|
| Path | `~/Projects/personae-mobile/dist/personae-0.3.0.apk` | `cp` (exit 0) |
| Bytes | **98,953,733** | `stat -c '%s'` |
| sha256 | **a18e350b52a8e30025b625b3b50d226b68bdbd4ca82f287bab0eafc81f74af9b** | `sha256sum` |
| Package | `com.personae.mobile` | `aapt2 dump badging` |
| versionCode / versionName | **3** / `0.3.0` | `apkanalyzer apk summary` |
| minSdk / targetSdk / compileSdk | **24** / 36 / 36 | `apkanalyzer manifest min-sdk` / `target-sdk` |
| Native ABIs | arm64-v8a, armeabi-v7a, x86, x86_64 — **22 libs each** | `unzip -Z1 \| grep ^lib/` |
| Signature | **Verifies**; v2 scheme true; `CN=Personae Mobile, OU=Mobile, O=Personae, L=Lisboa, C=PT`, SHA-256 `bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26` | `apksigner verify --print-certs` (exit 0) |

The signer is **the same Personae release key as 0.1.0/0.2.0**, so this APK **upgrades them in
place** — it does not require an uninstall.

Artifact forensics (scripts: `logs/verify-apk.sh`, `logs/verify-dex.sh`, exit 0):

| Check | Result |
|---|---|
| `<queries>` in the **shipped** manifest | `package android:name="com.tailscale.ipn"` present, **and** the template's pre-existing VIEW/BROWSABLE intent preserved (`aapt2 dump xmltree`) |
| `ACCESS_NETWORK_STATE` permission | present (merged from `expo-network`), beside `INTERNET` |
| Our native module in the dex | `TailscaleTriggerModule` strings in **classes3.dex**; all six methods present (`probeTcp`, `triggerConnect`, `triggerDisconnect`, `isPackageInstalled`, `vpnTransportActive`, `openApp`) |
| Broadcast actions in the dex | `com.tailscale.ipn.CONNECT_VPN` **and** `com.tailscale.ipn.DISCONNECT_VPN` |
| JS bundle | 2,308,272 bytes; contains `preferredRouteRole`, `connectDeadlineMs`, `insecureRouteAck`, `everReachedGateway`, `com.tailscale.ipn`, `Personalizado (`, `Verificar agora` |
| Encryption note in the bundle | `Sem TLS de aplicação — cifrado pelo WireGuard do Tailscale` present — matched at **UTF-16LE**, because Hermes stores any literal containing a non-ASCII character in a UTF-16 string table (a plain byte-grep for "WireGuard" returns 0 and is misleading; recorded here so nobody repeats that mistake) |
| **Hardcoded environment facts** | `100.64.0.11` → **0** occurrences (UTF-8 **and** UTF-16LE); `personae` → **0**; the gateway key → **0** |
| Secrets | no `API_SERVER_KEY=<value>`; the 1 hit for the bare string is the API-key **input placeholder** |

## What could NOT be verified (unchanged, and it is the important part)

1. **No device, no emulator on this host.** The 0.3.0 APK has **never been installed or launched**,
   and the app has **never talked to the real gateway**. Every functional claim above is either
   offline-suite evidence or analysis of the built artifact. The tailnet route itself *was* probed
   from this host's shell (P9) — that is a different thing from the phone reaching it.
2. Therefore **"the tunnel comes up on a cold launch with no Tailscale UI" is UNVERIFIED.** The
   mechanism is the one documented in the reference plan and the broadcast action is in the shipped
   dex, but `VpnService.prepare()` consent is one-time and per-package, and nothing here proves the
   trigger works on a phone.
3. **iOS cannot be tested at all**, and cannot do this anyway (no cross-app broadcast) — the
   asymmetry is stated in the UI (DECISIONS D7).
4. **The render layer was never executed on hardware.** The "app still starts and shows a specific
   error when the tunnel is down" path is the new `ConnectivityBanner` plus the pre-existing
   not-configured/error cards; the *decisions* behind it are unit-tested, the pixels are not.

## Next step

Install `dist/personae-0.3.0.apk` (Android 7.0 / API 24+; it upgrades 0.1.0/0.2.0 in place). Then:
set the routes in Definições → **Rotas** (a `https://<host>.<tailnet>.ts.net:10443` route first, and
`http://<tailnet-ip>:9222` below it — the ack switch is required for the plain-http one), paste the
API key, and read **Estado da ligação**: it names which of Tailscale-installed / tunnel / route /
gateway is the one that is not working, which is exactly what could not be determined before.
The three device checks worth running are listed in QUESTIONS Q13.

---

# P0.1 — the bearer seam on the dashboard, proven cross-machine (GOAL-UI.md §1)

**Verdict: PASS, both legs. `logs/p0.1-spike.txt` holds the full evidence (verbatim commands and
responses). The §0.4 option-C fallback was NOT used.** The LAN dashboard on `0.0.0.0:9119` stays
the single transport; `:9222` stays out of the design.

## What was built (out of tree, no edit inside the hermes-agent checkout)

`~/.hermes/plugins/personae-mobile-auth/` — a **user-level** dashboard auth provider, modelled on
the bundled `plugins/dashboard_auth/drain/` (constant-time compare, fail-closed >=256-bit entropy
gate, audit line). Registered through the sanctioned seam `ctx.register_dashboard_auth_provider`
(`hermes_cli/plugins.py:766`).

| Fact | Value |
|---|---|
| Provider name | `personae-mobile` |
| Capabilities | `supports_token=True` (`verify_token`), `supports_session=True` (`verify_session`), `supports_password=False` |
| Secret | env-only `HERMES_PERSONAE_BEARER` = `openssl rand -hex 32` (64 chars, 16 distinct, 247 Shannon bits) |
| Fail-closed | unset/weak secret -> skip registration, no provider, no route opened |
| Enabled | `HERMES_HOME=~/.hermes hermes plugins enable personae-mobile-auth` -> `config.yaml` `plugins.enabled` |
| Plugin edits need no restart | authenticated `POST /api/dashboard/agent-plugins/activate` re-loads it in-process |

### Secret mechanism — a deliberate, smaller deviation from §1.1

The goal asked for a systemd drop-in with `EnvironmentFile=`. The unit **already** has
`EnvironmentFile=~/.hermes/.env` (mode 600, owner-only) and that file already
carries the live dashboard's own basic-auth variables, so the secret went **there** — the same
mechanism the live basic-auth uses, with no new drop-in, and it still survives a restart. No file
mode, owner or unit `Environment=` was changed.

### The restart, and the one host-level safeguard it needed

`hermes-serve.service` is a **user** unit (`systemctl --user`, `~/.config/systemd/user/`) with
`KillMode=control-group` — and this agent session lives inside that unit's cgroup
(`/proc/self/cgroup` -> `.../hermes-serve.service`), so a plain restart would SIGTERM the run
doing the work. A **temporary** drop-in
`~/.config/systemd/user/hermes-serve.service.d/50-restart-safety.conf` (`KillMode=process`)
protected the session for the restart; it is **removed again before this run ends** and is not
part of the delivered configuration. Measured: dashboard down 13:30:17, `/login` 200 by 13:30:22
(~5 s), agent session alive throughout.

### Token routes — the list, and why it is one path long

`register_token_route` is **exact-path set membership**; a registered path is handed to the
bearer-**only** seam, which answers 401 *before* the cookie gate is consulted (measured: a
registered path returns `{"error":"unauthenticated","detail":"Unauthorized"}` with no
`reason`/`login_url`, while an unregistered one returns the gate's `"reason":"no_cookie"` body).
The dashboard SPA itself calls `/api/profiles` and `POST /api/auth/ws-ticket` **with cookies**
(measured by grepping the shipped bundle), so registering either would take that route away from
the user's browser.

**Registered list (exactly one path): `/api/profiles/sessions/sidebar`** — the only route the app
needs that the SPA never calls — registered by
`~/.hermes/plugins/personae-mobile-auth/__init__.py :: _register_token_routes()` (constant
`TOKEN_ROUTE_PATHS`). Everything else the app needs, including `POST /api/auth/ws-ticket`,
is carried by the provider's `verify_session` capability — the documented token-mode-client
bearer leg (`dashboard_auth/middleware.py`), which sets `request.state.session` and therefore
reaches the ticket route, where a token-route-only registration answers 401.

## Evidence (all measured 2026-10-11)

| Check | Result |
|---|---|
| `GET /api/profiles` with bearer, **from win-desktop (10.0.0.16)** | **200**, 12 407 bytes of profile JSON |
| same, no `Authorization` / wrong 64-char bearer | **401** / **401** |
| `POST /api/auth/ws-ticket` with bearer, from win-desktop | **200** `{"ticket":…,"ttl_seconds":30}` |
| `ws://10.0.0.15:9119/api/ws?ticket=…` from win-desktop | **Open**; first frame 2 109 bytes, `gateway.ready` |
| ticket replay | refused (single-use confirmed) |
| `GET /login` after the restart | **200**; `/api/profiles` no cookie -> gate 401 unchanged |
| Existing browser session | survives (signing secret `HERMES_DASHBOARD_BASIC_AUTH_SECRET` is env-stable, so no re-login) |

**Honest gaps in this phase:**

1. The provider is session-capable by design, so the login page lists **one additional, inert
   entry** ("Personae Mobile (app credential)"); pressing it answers 503 with an explanation. It
   cannot authenticate anything. the user's own username/password form is untouched.
2. A real browser password login could not be replayed end-to-end by me:
   `dashboard.basic_auth` stores only a scrypt `password_hash` (not recoverable by design, and it
   must not be changed). What was verified is the login page, the provider list, the gate's 401
   body and the fact that the cookie-signing secret is unchanged across the restart.
3. The bearer is root-equivalent on this dashboard (same as the desktop app's token mode): it is
   a 256-bit owner-held secret, and the app's copy lives in `expo-secure-store`.
