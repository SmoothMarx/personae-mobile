# RESUME 0.9.0 — the box rebooted mid-run

Read this first, then `git log --oneline -6` and `git status`. Do **not** redo finished work.

## What happened

At **15:03 UTC** the host rebooted. Your process was killed with it. Nothing was lost that was
committed; you were killed while waiting on a Gradle build that was starving you.

- Your session survived: `20261012_133516_cd084a`, 433 messages, 216 tool calls, `deepseek-flash`.
- The Gradle build **did not** survive: `logs/gradle-v090.log` has no `GRADLE_EXIT`, no `BUILD
  SUCCESS`, no `BUILD FAILED`. `dist/` has no `personae-0.9.0.apk`. The build you were waiting on is
  gone, not merely slow. You will have to start it again near the end, once the code is final.
- The stale turn-lease row in `state.db` has already expired and its pid is dead, so it is not
  holding you back.

## Already done — do not redo

Committed and green before the reboot:

| commit | phase |
|---|---|
| `f6785ad` | 0.9.0 RECON (Phase 0) |
| `1ad6b6d` | A — archive/delete at the dashboard's own verbs (pinned refused), portable-prefs document |
| `9fdf1be` | B — Settings promoted to a page of section rows; Notifications a sibling |
| `a89cffa` | C — session groups (create/file/remove/collapse/rename/delete; deleting never deletes a session) |
| `952e3ff` | F — search bar pill +25%, connection strip, "51 automatic" line, expand-all glyph, +/settings, landscape |

**Uncommitted, in flight** — this is where you were: `src/logic/selection.ts` (new, multiselect),
plus dirty `src/roster/menus.ts`, `src/roster/components.tsx`, `src/roster/useRoster.ts`,
`app/index.tsx`, `src/i18n.ts`, `src/api/backend.ts`, `package.json`, `app.json`, `README.md`.
That looks like **Phase D and E part-done**. Recover that work; it is not lost, it is uncommitted.

`app.json` already reads `0.9.0` / `versionCode 10` in the dirty tree. Keep it.

## Change to the brief: push is PARKED

the user, 2026-10-12, verbatim: *"If push is an issue, you can park that for the next update."*

So the Firebase prerequisite is now **out of 0.9.0**:

- Do **not** implement the push sender. Do **not** wait on, ask for, or scaffold around
  `google-services.json` / `GoogleService-Info.plist` / any service-account key.
- If client-side registration, a permission prompt or an off-by-default flag already exists in your
  uncommitted work, **leave it inert** and do not let it block the build.
- Record it in `PROGRESS.md` under a `## 0.9.0` section as **deferred to the next update, reason:
  Firebase project is the user's to create**, and move on.
- **The finish line is unchanged and never required push:** `dist/personae-0.9.0.apk` plus
  `logs/verify-0.9.0.txt` ending `RESULT: PASS — 0.9.0 verified`.

## Fix the build that killed your throughput

Your own reasoning notes it: **load average 319** with `npx tsc` timing out at the 300s tool cap.
Measured facts from the host: 12 cores, 15 GB RAM, **3758 threads** already live (every container's
JVM, plus the app). Gradle's default worker pool on top of that starves everything, including you.

Constrain it explicitly this time:

- Cap the build's workers — `--max-workers=4`, and `org.gradle.workers.max=4` in
  `android/gradle.properties` if the docker invocation does not pass it.
- `org.gradle.daemon=false` for the one-shot build.
- Poll the build with light commands only (`tail`, `grep GRADLE_EXIT`). Do not run `tsc`, the test
  suite, or `npm install` while Gradle is running — that is what timed out on you.
- Sequence it: **finish the code → typecheck + tests on a quiet machine → then start the one build.**

## Everything else from `GOAL-0.9.0.md` still stands

Including: phases in dependency order (the server surface was Phase A and is already committed), a
naming test per §4 item, the app suite at or above the 0.8.0 floor of **196/196**, no secrets or host
literals in the shipped bundle, and the honest **not-verified** list — there is still no `adb` on
either host, so landscape remains a static claim and must be reported as one.

Keep logging to `logs/cody-090-resume.log`, keep committing per phase, keep `PROGRESS.md` current.

**Do not stop before `dist/personae-0.9.0.apk` and `RESULT: PASS — 0.9.0 verified` both exist.**
