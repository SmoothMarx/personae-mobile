# Personae Mobile — build brief (owner: cody)

Author: Crabby. Status: APPROVED TO BUILD (the user, 2026-10-11). This file is the contract.
the user's words: "get cody to do everything as he has the skills to pull it off. develop the app
completely until you have a working version I can install and test on my android device"

## 0. Load before writing code
- `pedro-app-defaults` (your own skill) — the user's product rules. Follow them.
- `android-apk-builds` (Crabby copied it into your skills dir) — the build lane.

## 1. Deliverable
A signed, sideloadable **Android APK** at:
`~/Projects/personae-mobile/dist/personae-<version>.apk`

That is the definition of done. Not a scaffold, not a plan, not "it should build".
Also required: the Expo project stays **iOS-capable** (no iOS build now — no Mac).

## 2. What the app is
A native client (React Native, **not** a WebView) of the Hermes Agent API served by the
gateway on this box. Personae's desktop model maps 1:1 onto the API:

| Personae | API |
|---|---|
| profile (contact) | a Hermes profile |
| session (thread) | `session_id` |
| message (bubble) | history entry |

Screens (3, minimum):
1. **Roster** — every profile as a contact row: name, avatar/initial, live status dot,
   unread count. Tap → thread. Long-press/overflow → new session.
2. **Thread** — message history (user/assistant bubbles, tool calls collapsed), composer,
   streaming reply rendered token-by-token, send button, stop button while streaming.
3. **Settings** — base URL, API key, optional profile-multiplex prefix, model override.
   Single-field settings save themselves (pedro-app-defaults).

## 3. API contract — DERIVE FROM SOURCE, DO NOT GUESS
Authoritative file: `~/.hermes/hermes-agent/gateway/platforms/api_server.py`
Route table: **lines 81–102**. Handlers: grep `_handle_`.

Verified routes (exist as of 2026-10-11):
```
GET    /v1/health                    (no auth)
GET    /v1/models
GET    /v1/capabilities
GET    /api/model/options
GET    /api/sessions                 → session list
POST   /api/sessions                 → create
GET    /api/sessions/{id}
PATCH  /api/sessions/{id}
DELETE /api/sessions/{id}
GET    /api/sessions/{id}/messages   → thread history
POST   /api/sessions/{id}/chat       → non-streaming send
POST   /api/sessions/{id}/chat/stream→ SSE streaming send  ← use this
POST   /api/sessions/{id}/fork
POST   /api/sessions/{id}/model      → lock model per session
POST   /v1/chat/completions          (OpenAI-compatible)
```
- **Auth**: `Authorization: Bearer <API_SERVER_KEY>`. The key lives in Bitwarden Secrets
  Manager and is **locked** — you cannot read it. The user types it into Settings; store it
  with `expo-secure-store`. **Never embed, log or commit a key.**
- **Request/response bodies**: read the handlers and derive them from code. Where a shape is
  genuinely ambiguous, write it into `QUESTIONS.md` rather than inventing one.
- **SSE**: `Content-Type: text/event-stream`, keepalive every 10s, frames are `id:` / `event:` /
  `data: <json>`. Handle reconnects and partial frames.
- Headers the server accepts (from its CORS allow-list): `X-Hermes-Session-Id`,
  `Idempotency-Key`.
- If the gateway runs with `multiplex_profiles`, the same routes sit under `/p/<profile>/`.

## 4. Stack
React Native + Expo, TypeScript, `expo-router`, `expo-secure-store`, `react-native-sse`
(or fetch + ReadableStream). `npx create-expo-app` is fine as the seed; pin versions and
commit the lockfile.

## 5. Build lane — measured facts about this host (verified 2026-10-11)
- Node 22 + npm: **yes**. Docker: **yes**. Java: **no**. Android SDK: **no**.
- Disk free: 79 GB. RAM available: ~7 GB. win-desktop has no JDK/SDK either.
- Lane: `npx expo prebuild -p android` → gradle build **inside Docker** with a JDK17 +
  Android SDK image (e.g. `ghcr.io/cirruslabs/android-sdk`, `mingc/android-build-box`),
  project mounted. Generate a keystore with `keytool` and **release-sign** so future builds
  upgrade in place instead of "app not installed".
- Then **prove** the artifact: package name, versionCode, minSdk, exact byte size, sha256.
  Do not report a build you have not measured.
- Fallback lane if Docker cannot provision: a GitHub Actions workflow building the APK and
  uploading it as an artifact. Private repo preferred.

## 6. Testing
- Write a small local mock of the gateway (Node http) to exercise the client end-to-end
  offline, so the roster/thread/stream paths are actually rendered and asserted.
- **You cannot verify against the live gateway** (no key). Say so plainly in PROGRESS.md.
  Never present mock output as live-gateway evidence.
- Optional fast loop for the user **after** the APK exists: `npx expo start --tunnel` + Expo Go.

## 7. Hard rules
- No secrets, tokens, keys or credentials in the repo, the APK, or any log.
- No real people's names in code, seed data or assets.
- **Read-only** on `~/Projects/hermes-desktop-plugins/personae` — do not modify, commit or
  push there. Your project is `~/Projects/personae-mobile` (own git repo, do not push it
  anywhere unless asked).
- Do not touch `~/.hermes` config, the gateway, `state.db`, or any running service.
- Don't attach screenshots to reports; text plus measured numbers is the user's preference.

## 8. Acceptance criteria
1. `~/Projects/personae-mobile/dist/personae-*.apk` exists, release-signed, minSdk ≤ 30,
   with measured size + sha256 reported.
2. Roster renders the session list from `GET /api/sessions` and survives empty/error states.
3. Thread renders `GET /api/sessions/{id}/messages` and sends via
   `POST /api/sessions/{id}/chat/stream`, rendering streamed tokens live.
4. Settings persists base URL + key across app restarts (secure store), and a wrong
   URL/key produces a visible, specific error — never a silent failure.
5. Expo project still supports iOS (`eas.json` present, no Android-only hacks in shared code).

## 9. Progress + questions
- Append each phase to `~/Projects/personae-mobile/PROGRESS.md` (phase, what changed,
  measured evidence, next step).
- Anything you cannot decide from this brief: `~/Projects/personae-mobile/QUESTIONS.md`.
  Do not guess and do not stop the whole build over one unknown — choose the safest
  reversible default, note it, and keep going.
