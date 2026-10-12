<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Personae Mobile">
</p>

# Personae Mobile

A native Android/iOS client (React Native + Expo, TypeScript, expo-router) for the Hermes Agent API
served by the gateway. Three screens:

- **Roster** — profiles as contacts (live status dot, "new since last visit" count) and that
  profile's sessions from `GET /api/sessions`, grouped by day, 25 per page.
- **Thread** — history from `GET /api/sessions/{id}/messages`, a composer, and a reply streamed token
  by token from `POST /api/sessions/{id}/chat/stream`, with a working **Stop** button.
- **Settings** — gateway URL, API key (secure store), extra profiles (`/p/<profile>/` multiplexing)
  and a model override. Each field saves itself; the value actually in use is always shown.

Interface language is PT-PT; every user-visible string is in `src/i18n.ts` (see `QUESTIONS.md` Q4).

## Where the numbers come from

Every request and response shape is derived from the gateway source
(`~/.hermes/hermes-agent/gateway/platforms/api_server.py`), with the line numbers cited in
`src/api/client.ts` and tabulated in `PROGRESS.md`. Nothing is guessed.

## Install on a phone

```
adb install -r dist/personae-0.1.0.apk
```

or copy the APK to the phone and open it (allow "install unknown apps" for the file manager). Then
open the app → **Definições** → fill in the gateway address (e.g. `http://100.64.0.5:8642`) and the
`API_SERVER_KEY` → the roster loads. The app talks to the gateway directly; put it on the same LAN
or Tailscale network.

## Development

```
npm install
npm test                 # 40 offline tests against the mock gateway (no key needed)
npm run typecheck        # tsc --noEmit
npm run mock             # local mock gateway on http://127.0.0.1:8791, key "test-key-123"
npx expo start --tunnel  # fast loop on a phone via Expo Go (after the APK exists)
```

Point the app at the mock (`http://<your-lan-ip>:8791`, key `test-key-123`) to exercise roster,
thread, streaming, Stop and every error path without touching the real gateway.

## Rebuilding the APK

`android/` is generated and git-ignored, so the release-signing patch is re-applied by script:

```
npx expo prebuild -p android --no-install
bash scripts/patch-android-signing.sh
docker run --rm --env-file ~/.personae-android/build.env \
  -v "$PWD":/work -v ~/.personae-android/gradle:/root/.gradle \
  -v ~/.personae-android:/signing:ro -w /work/android personae-android:1 \
  bash -lc './gradlew :app:assembleRelease --no-daemon --console=plain'
```

The keystore lives at `~/.personae-android/personae-release.keystore` (password beside it, mode 600),
outside this repository. **Keep it**: a build signed with a different key cannot upgrade an installed
copy of the app — Android will refuse and the app must be uninstalled first.

## Layout

```
app/            expo-router routes: _layout, index (roster), thread/[id], settings
src/api/        client (shapes cited from the server source), transport (XHR + node), sse parser, errors
src/logic/      pure roster + thread derivations (unit-tested, no React)
src/            settings model + secure storage, i18n table, formatting, theme
mock/           local Node mock of the gateway API (also runnable standalone)
tests/run.ts    the offline suite (`npm test`)
```

## Not verified

There is no API key in this build, so the app has never been run against the **live** gateway and no
device was available here: the render layer was not exercised on real hardware. What *is* verified is
in `PROGRESS.md` (mock-gateway tests, typecheck, and the measured APK).
