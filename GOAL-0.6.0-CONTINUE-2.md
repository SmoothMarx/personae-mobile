# GOAL-0.6.0-CONTINUE-2 — run #3: finish 0.6.0

Owner: **cody** · written 2026-10-11T18:25Z by crabby · resumes session `20261011_144457_7e676f` (run #3)

**Binding documents:** `GOAL-0.6.0.md` = scope of record. `GOAL-0.6.0-CONTINUE.md` §3 = acceptance
criteria, **unchanged and still binding — read them from that file.** This file replaces ONLY the
"measured state" and "what's left" sections of the previous continuation, because both are now stale.

## 0. Why run #2 stopped, and why run #3 will not repeat run #1

Run #2 (17:42:00–17:44:39Z) died on **`HTTP 402: Insufficient available credits`** from the Nous
Portal — the account, not your code. The credits have since been topped up. No technical fault, no
guard-rail violated, nothing to diagnose.

**Run #1's death mode is fixed and proven:** you restarted `hermes-serve.service` at 17:43:13Z from
inside run #2, and run #2 *survived it* and kept working for another 86 seconds. This session now runs
in its own transient unit (`systemd-run --user --unit=cody-060b`), outside `hermes-serve`'s cgroup.
Keep using the detached helper for restarts anyway:

`systemd-run --user --collect --unit=hs-restart-$(date +%s) bash -lc 'sleep 2; systemctl --user restart hermes-serve.service'`

## 1. Measured state now — verified from outside at 18:20Z. Do not re-derive; verify only what you touch.

- **Your run #2 work is safe in git:** commit `d5f07d1` — 24 files: server pairing + per-device tokens
  + sync store (`store.py` 445L, `qr.py` 309L, both `dashboard/plugin_api.py`), server tests
  (`test_pairing.py` 338L, `test_qr.py` 64L, `test_ui_state.py` 134L), `install.sh` +73, `.gitignore`,
  app i18n/settings groundwork. **Claimed 43/43 server tests green at commit time — re-run to confirm,
  do not restate it from memory.**
- Working tree is clean apart from three untracked paths: `GOAL-0.6.0.md`, `GOAL-0.6.0-CONTINUE.md`,
  `GOAL-0.6.0-CONTINUE-2.md`, `brand/`. **There is no uncommitted exposure left to rescue.**
- **Deploy tail landed.** `diff -rq --exclude=__pycache__ <repo> ~/.hermes/plugins/<plugin>` prints
  nothing for both plugins except the runtime `state/` directories (which are meant to exist only
  there). Nothing left to deploy from the current commit.
- **The live service is running your code:** `hermes-serve.service` `ActiveEnterTimestamp = 17:43:13Z`,
  journal since then is 21 lines and **free of any plugin/error/traceback line**. Server-side 0.6.0 is
  live right now.
- Last measured test state (re-run, don't trust): app `132/132`, `tsc` rc 0, server `43/43`.
- Still 0.5.0 everywhere it counts: `app.json` = `version 0.5.0`, `android.versionCode 5`; `dist/` newest
  is `personae-0.5.0.apk`. `logs/verify-0.6.0.sh` does not exist. `PROGRESS.md` not updated.

## 2. What is LEFT — this list is exhaustive

Confirmed absent by grep + dependency check at 18:20Z:

1. **QR scan** — `expo-camera` is **not** in `package.json`. No scanner exists. Add it, build the
   scan screen that consumes the dashboard's pairing QR.
2. **Client-side redeem** — no `redeem` call anywhere in `app/` or `src/`. The server route exists
   (`personae-mobile-auth`: `REDEEM_PATH`); wire the client to it and store the per-device token in
   secure storage (inspect what 0.5.0 already uses for the bearer before adding a dependency).
3. **Deep-link handler** — `app.json:7` already declares `"scheme": "personae"` (it did in 0.5.0).
   `expo-linking` is installed at 57.0.12. What is missing is the **handler** for
   `personae://connect?base=…&code=…` — nothing consumes that URL today.
4. **Sync-store client** — no caller for `GET/PUT /api/plugins/messenger/state`, no per-key `rev` LWW,
   no tombstone handling, no offline queue, no seed-then-authoritative migration on the app side.
5. **Version + artifact** — bump to `0.6.0` / `versionCode 6` in the same commit range as the build,
   build `dist/personae-0.6.0.apk` with the **same keystore** as 0.5.0, report sha256 + signer
   fingerprint.
6. **`logs/verify-0.6.0.sh`** — exists, runnable, green, includes the bearer grep over the built JS
   bundle → 0 matches.
7. **`PROGRESS.md`** — updated with honest 0.6.0 state including gaps.

The wizard/settings restructure is *not* on this list: the i18n table (en source of truth, PT
selectable) and the `autoConnect` / `openTailscaleOnFailure` = `false` defaults already landed in
`d5f07d1`. Verify, don't rebuild.

## 3. Budget discipline — credits are the failure mode now, not crashes

Measured over your 80 API calls on this session: **≈$0.10 per API call**, ~9.2M cache-read tokens.
Run #1 spent $5.74 in 28 minutes; run #2 spent $2.09 in 2m39s. Nobody is capping you, but blow the
budget and the work stops mid-file again. So:

- **Do not re-read or re-derive anything in §1.** It is measured. Spend calls on the remaining list.
- Prefer targeted edits + running the suite over wide exploration. One test run per meaningful change,
  not per keystroke.
- If a subagent's job takes you three calls to delegate and describe, just do it yourself.
- Finish **one numbered item at a time**, committing after each. A budget death then costs one item,
  never the whole run.
- Do the cheap high-value tail first: version bump → `verify-0.6.0.sh` → `PROGRESS.md` in the same
  commit range as the app features; build the APK last.
- Report `api_calls` and estimated cost in your final summary, and if you are ever near the end of the
  credits, **commit and say so in the log before the last call**, not after.

## 4. Unchanged rules

Read a file before overwriting it (your `install.sh` write was refused in run #1 for exactly that).
Restart the service only via the detached helper above. Never write a secret anywhere — print
`[REDACTED]`. Only claim tests you ran yourself in this run. If a step needs the physical phone
(install, scan, tap), write the user the exact commands and mark it deferred instead of claiming it.
