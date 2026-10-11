# GOAL — Personae Mobile: ship the app, all the way to an installable APK

## Completion condition (the judge's test — all six must be true)

1. `~/Projects/personae-mobile/dist/personae-*.apk` exists on disk, is **release-signed**, and cody
   has reported its **measured** package id, versionCode, minSdk, exact byte size and sha256 —
   all obtained by running a command against the artifact, not asserted from memory.
2. The Expo project contains real implementations of all three screens (Roster, Thread, Settings),
   each wired to the live API module — not stubs, not placeholders, not TODO bodies.
3. `PROGRESS.md` exists and its final entry names the APK path, the measured facts, and the exact
   commands that produced the build, with their exit codes.
4. `QUESTIONS.md` exists (may be empty of open items) and every unresolved unknown cody hit is
   written there rather than silently guessed.
5. `npx expo-doctor` has been run and the project still passes as iOS-capable
   (`eas.json` present, no Android-only constructs in shared code).
6. The APK installs on a real Android device — unverified only if cody states plainly that he has
   no device and cannot; a claim of "verified on device" without a device is a FAIL.

## NOT DONE IF (any of these → keep working)

- The build output is a scaffold, a plan, a screenshot-free "it should work", or an Expo Go
  session in place of an APK.
- Cody reports numbers he did not measure (no command, no exit code) — that is a fail, not a pass.
- The app requires the live gateway to launch. It must start, render the roster, and show a
  **specific, visible error** when the base URL or key is wrong. Silent failure = not done.
- Mock-gateway output is presented as live-gateway evidence. Say "unverified against the live
  gateway (no API key)" — that is an acceptable answer; a fake one is not.
- Any secret, key, token or real person's name appears in the repo, the APK, or a log.
- Anything in `~/Projects/hermes-desktop-plugins/personae` was modified, committed or pushed.
  That tree is read-only.
- The build is "nearly working" and cody stopped to ask the user instead of choosing the safest
  reversible default and continuing.

## Work definition

`~/Projects/personae-mobile/SPEC.md` is the contract — read it first, in full. It holds the route
table, the SSE frame shape, the three screens, the build lane and the host's measured limits
(Node 22 + Docker yes; Java and Android SDK no — hence Docker or a GitHub Actions lane).

Phases P1–P8 in `~/Projects/personae-mobile/BRIEF.txt` are the plan. P8 exists because a build
that is not measured is not a build.

## Resume rule

If `PROGRESS.md` shows completed phases, **continue from the last one** — never re-scaffold, never
re-create the project, never overwrite finished files with fresh ones. If phase state is ambiguous,
`git status` and `git log` in the project decide it.

## Autonomy

Do not stop to ask a human. Choose the safest reversible default, record the choice in
`PROGRESS.md`, and keep going. Two exceptions, both of which go in `QUESTIONS.md` and are then
built around: a decision that would require the user's API key, and a decision that cannot be
reversed (deleting data, publishing, spending money).

## Final report — short

APK absolute path · bytes · sha256 · package · versionCode · minSdk · build exit codes · what
remains unverified (state the live-gateway gap explicitly) · the single most likely reason an
install would fail on the user's phone.
