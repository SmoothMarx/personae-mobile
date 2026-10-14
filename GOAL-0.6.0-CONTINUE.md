# GOAL-0.6.0-CONTINUE — finish what the restart killed

Owner: **cody** · written 2026-10-11T17:45Z by crabby · resumes session `20261011_144457_7e676f`
Scope of record: **`GOAL-0.6.0.md` still wins on scope.** This file only records (a) what already
exists, measured by an outside observer after your run died, and (b) what is left. Where the two
disagree, GOAL-0.6.0.md wins on *what to build*; this file wins on *what is already true on disk*.

## 0. Why your previous run stopped — read this before you touch systemd

At 15:12:48Z your run received a hard interrupt (`Turn ended: reason=interrupted_by_user`,
`api_calls=58/500`). It was not a crash, not OOM, and not the user. **You restarted the service that
was hosting your own process.** Your last plan line (`logs/cody-060.log:2069`) was:

> "then deploy and restart hermes-serve — noting this will briefly interrupt the user's desktop app
> connection, which the spec expects."

The interruption of the desktop app was expected. Your own death was not: this session's parent chain
is `bash -> hermes (pid <MainPID of hermes-serve.service>) -> systemd --user`, so every process you
launch lives in `hermes-serve.service`'s cgroup. `systemctl --user restart hermes-serve.service`
kills that whole cgroup — you included. `logs/cody-060.log` ends mid-`execute_code`; the kernel was
killed before its output could be written.

**This run is launched under `systemd-run --user --unit=cody-060b`, in its own transient unit — you
are now immune to that restart.** Do not waste the immunity:

- **NEVER run `systemctl --user restart hermes-serve.service` directly.** Use a detached helper so the
  restart happens outside your cgroup:
  `systemd-run --user --collect --unit=hs-restart-$(date +%s) bash -lc 'sleep 2; systemctl --user restart hermes-serve.service'`
- **Read a file before overwriting it.** Your `write_file` on `server/install.sh` was refused
  (`Refusing to overwrite ... this task has not seen its full current contents`). That refusal is why
  the deploy tail never landed. `read_file` it, then write.
- **Commit before every deploy attempt.** All of 0.6.0 is currently uncommitted. A dead run with
  uncommitted work is one `git checkout` from vapor.

## 1. Measured state — these are facts, verified at 17:39Z from outside, not your self-reports

| check | command | result |
|---|---|---|
| app typecheck | `npx tsc --noEmit` | rc **0** |
| app tests | `npm test` (`tsx tests/run.ts`) | **132/132 passed, 0 failed** (0.5.0 baseline was 125) |
| server tests | `bash server/run-tests.sh tests` | **43 passed in 1.54s** (run against the repo copy) |
| git | `git log --oneline -1` | `d76eddc P5 (F5/F6/F7): build 0.5.0 ...` — **no 0.6.0 commit exists** |
| working tree | `git status --porcelain` | **21 modified + 9 untracked, +1046 / −139** |
| APK | `ls dist/` | newest is `personae-0.5.0.apk` — **no 0.6.0 build** |
| version | `app.json` | `version 0.5.0`, `android.versionCode 5` — **not bumped** |

Untracked, i.e. brand new and **not yet in git**: `GOAL-0.6.0.md`, `brand/`, `server/messenger/`,
`server/personae-mobile-auth/{qr.py,store.py,dashboard/,__pycache__/}`, `server/run-tests.sh`,
`server/tests/`.

Deployed vs repo (`diff -rq --exclude=__pycache__ <repo> ~/.hermes/plugins/<plugin>`): exactly **two
files differ, repo newer** — `server/personae-mobile-auth/dashboard/plugin_api.py` and
`server/messenger/dashboard/ui_state.py`. No file is missing on either side; the deploy was ~95%
complete and your last two edits were the 5% that missed the copy. `server/install.sh` is untouched
(mtime 12:33, i.e. yours from the 0.5.0 era).

Going concern check: `hermes-serve.service` came back up at 15:12:52 and has been running since; no
plugin load errors in its journal; the deployed pair loads clean. Nothing is broken for the user right
now — the live box is simply repo-minus-two-files.

## 2. What is actually LEFT (the app half is barely started — do not assume otherwise)

Verified absent in `app/` + `src/` by grep, and `app.json` is unmodified:

- no `personae://` scheme registered, **no deep-link handler**
- **no QR scanning** (`expo-camera`), no `/pair` screen consuming the dashboard's QR
- **no one-time-code redeem call on the client** (`redeem` appears only server-side, in
  `server/personae-mobile-auth/__init__.py: REDEEM_PATH`)
- **no sync-store client** — no `GET/PUT /api/plugins/messenger/state` caller, no per-key `rev` LWW,
  no tombstone handling, no offline queue on the app side
- the wizard / settings restructure: only what GOAL-0.6.0.md requires; the i18n table (`en` source of
  truth, PT selectable), `autoConnect` and `openTailscaleOnFailure` defaults (`false`) **did** land

Server side, what **is** built and green: pairing + one-time-code redeem, per-device hashed tokens,
the sync store (`GET/PUT /state`, per-key `rev`, tombstones, key allow-list), both with tests (43/43).

## 3. Acceptance — passes only if EVERY line is true

1. **Commits exist.** One per finished phase on top of `d76eddc`; `PROGRESS.md` updated with the 0.6.0
   state including honest gaps; nothing important left uncommitted at the end.
2. **Deploy tail landed.** Both `diff -rq --exclude=__pycache__ <repo> ~/.hermes/plugins/<plugin>`
   invocations print **nothing** (identical trees).
3. **`server/install.sh` updated, idempotent, secret-free** — running it twice changes nothing
   (`git status --porcelain` before/after identical, deployment mtimes excepted).
4. **Service restarted only via the detached helper**; afterwards
   `systemctl --user is-active hermes-serve.service` → `active`, and its journal shows no new plugin
   errors. Say in your report exactly which command performed the restart.
5. **App half of GOAL-0.6.0.md Phase 1 is real** — scheme registered in `app.json`, QR scan, deep-link
   handler, sync-store client with `rev` LWW + tombstones + offline queue, redeem → per-device token in
   secure storage. Each backed by at least one test in `tests/run.ts`.
6. **Tests and types:** `npm test` ≥ **132** passing, `npx tsc --noEmit` rc 0,
   `bash server/run-tests.sh tests` ≥ **43** passing.
7. **Artifact:** `dist/personae-0.6.0.apk` exists, v2-signed with the **same keystore** as 0.5.0;
   report sha256, signer fingerprint, and `versionCode 6`. The version bump and the build must both be
   in the same commit range.
8. **`logs/verify-0.6.0.sh`** exists, is runnable, runs green, and includes the bearer grep over the
   built JS bundle → **0 matches**.
9. **No secrets** in any file, log, commit or report. Print tokens as `[REDACTED]`, always.
10. **Report in one screen:** done / not done / commands run / cost.

**NOT DONE IF:** you claim any test you did not run yourself; you restart `hermes-serve` from inside
the run without the detached helper; you write a secret; you bump the version without building the
APK; you leave the tree uncommitted; or you re-derive section 1 instead of verifying it.

## 4. Budget and style

~2h of work left; `--max-turns 600 --run-budget 3600` are set. Prefer finishing the deploy tail and
committing early, then the app half — so a second death still leaves the live box coherent and the work
in git. If a step needs the phone itself (install, scan, tap), do not claim it: write the exact
commands for the user and mark it deferred.
