# GOAL-0.6.0-CONTINUE-3 — run #4: finish the artifact (cheap model on purpose)

Owner: **cody** · written 2026-10-11T18:45Z by crabby · resumes session `20261011_144457_7e676f`
Model for this run: **deepseek/deepseek-flash** — your own configured default. Opus 5.5 is deliberately
withdrawn: it measured **$0.164 per API call** on the last run and the user called the cost. Do not ask for
it back; if you need a stronger model, stop and say so in the log.

**Binding:** `GOAL-0.6.0.md` = scope. `GOAL-0.6.0-CONTINUE.md` §3 = acceptance criteria. `GOAL-0.6.0-CONTINUE-2.md` §3 (budget discipline) and §4 (rules) still apply. This file supersedes the *state* and *remaining* sections of both.

## 1. State now — verified from outside by crabby at 18:40Z. Do not re-derive any of it.

You were stopped mid-build on purpose (cost). Everything you had written was already committed, so nothing
was lost except the build in flight.

| | |
|---|---|
| HEAD | `6e3f291` P1 (screens): connect wizard + deep-link/QR/browser pairing; 0.6.0 / versionCode 6 |
| previous | `fb0eae0` P1 (pure): pairing client, wizard probe, surface heal, options-sync client · `d5f07d1` P0.6 (server) |
| `npx tsc --noEmit` | **rc 0** (re-run by crabby, not your claim) |
| app tests | **145/145 passed, 0 failed** (you claimed 144; the real number is 145) |
| server tests | **43/43 in 1.59s** |
| on disk | `src/pairing.ts` 224L · `src/sync/uiSync.ts` 234L · `src/sync/useUiSync.ts` 66L · `app/connect.tsx` 362L · `src/i18n.ts` +110L |
| version | `app.json` = **0.6.0 / versionCode 6** ✔ |
| deployed | server code = repo; `hermes-serve.service` live on it since 17:43:13Z, journal clean |
| dirty | only untracked: `GOAL-0.6.0*.md`, `brand/`, `scripts/pair-harness.ts`. Nothing uncommitted to lose. |

**The one unproven thing, and the risk to retire first:** `fb0eae0` rewrote `package-lock.json`
(422 lines changed, 333 deletions) while pruning `@react-native/babel-preset` / gesture-handler /
reanimated. You flagged at the time that it is only safe if nothing depends on them transitively.
**No successful build has happened since that rewrite.** Either the build proves it or the lockfile fix
is wrong.

## 2. Remaining — exhaustive, in this order

1. **Build `dist/personae-0.6.0.apk`** with the **same keystore** as `personae-0.5.0.apk`. Same build path
   you used for 0.5.0. If the pruned lockfile breaks install/bundling: fix it with a real resolution
   (`npx expo install <pkg>` / `npm ci`) and commit the lockfile fix **on its own**, with a message saying
   which packages came back and why. Do not guess at the dep graph — prove it with the build.
2. **`logs/verify-0.6.0.sh`** — runnable, exits non-zero on failure, includes: app tests, `tsc`, server
   tests, install validation, service status, **bearer grep over the built bundle → must be 0**, and the
   APK signer fingerprint compared against 0.5.0's known value. Base it on `verify-0.5.0.sh`. If a check
   can only run in the container, shell out to the container rather than skipping it.
3. **`PROGRESS.md`** — honest 0.6.0 state including anything still missing. It currently still ends at 0.5.0.
4. **Final summary must state `api_calls` and estimated cost**, plus sha256 and signer fingerprint of the APK.

Not on this list (already done, do not touch): the wizard/settings restructure, i18n defaults, server
pairing/tokens/sync store, options-sync client, deep-link handler, QR screen.

## 3. Cost discipline for a cheap model

- The tail is mostly **not** LLM work: a gradle/Metro build, a shell script, a docs update. Zero tokens
  are spent on compiling — spend yours on the two files and on reading build errors.
- Do not re-read or re-derive §1. Do not re-run the full suite after every edit; run it once before each
  commit.
- **If the same build error defeats you twice, stop.** Commit whatever state is coherent, write exactly
  what you tried and the error text into `logs/cody-060d.log`, and end the run. Grinding on a cheap model
  burns the user's credits to no purpose — crabby will escalate the *build* to a stronger model instead.
- Commit after each of items 1, 2, 3.

## 4. Unchanged rules

Read a file before overwriting it. Restart the service only via the detached helper
(`systemd-run --user ... systemctl --user restart hermes-serve.service`). Never print a secret — `[REDACTED]`.
Only claim tests you ran in this run. Anything needing the physical phone (install the APK, scan the QR,
tap through pairing): write the user the exact commands and mark it **deferred** — do not claim it.
