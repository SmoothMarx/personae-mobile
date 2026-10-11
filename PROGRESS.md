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

Next step: run `:app:assembleRelease` in the container, then P8 measurement.
