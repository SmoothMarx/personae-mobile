# CONTINUE — Personae Mobile 0.7.0 (run 2)

`GOAL-0.7.0.md` is still the contract — read it. This file only records what already
happened and where you pick up. Both files sit in the repo root.

## What happened to your last run

You were terminated by your own `--run-budget` (5400 s) at ~21:23Z, mid-deploy, while
composing an `execute_code` cell. Not an error, not a crash, not your fault. Nothing was
reverted, and the live service was not left broken. The session `personae-070` is the one
you are reading now: it is your own history, not a stranger's.

## State, measured by the operator just now — verified, not remembered

| item | state |
|---|---|
| Phase A | **DONE, committed** `c23aa00` (20:57:07+01:00) — `src/logic/avatars.ts`, `src/roster/components.tsx`, `src/roster/geometry.ts`, `tests/run.ts`, +204/−12. Do not redo. |
| Phase B, server half | **WRITTEN, GREEN, UNCOMMITTED.** `git diff` = +127 in `server/personae-mobile-auth/dashboard/plugin_api.py` (`GET /tailscale/peers`), `plugin.yaml` + `manifest.json` 1.1.0 → 1.2.0, plus new `server/tests/test_tailscale.py`. |
| Phase B, server half — proof | `17 passed` (`server/tests/test_tailscale.py`), **`60 passed`** (`server/tests`, was 43), `npx tsc --noEmit` rc 0. |
| Phase B, app half | **NOT STARTED** — no file under `app/` or `src/` is modified. |
| Phase C / D | **NOT STARTED.** |
| Artifact | `dist/` still ends at `personae-0.6.1.apk`. There is no 0.7.0 APK. |

## Your first three moves, in this order

1. `git diff` and **read your own Phase B server diff**. Confirm it is yours and that you
   still agree with it. If something in it is wrong, fix it — do **not** delete it and
   start over to "be clean". That diff is the most expensive thing you produced.
2. Re-run the proof on this machine: `python -m pytest server/tests -q` and
   `npx tsc --noEmit`. Only if both are green, **commit the Phase B server half as its own
   commit** — stage the exact paths, never `git add -A`.
3. Then resume `GOAL-0.7.0.md` at **the app half of Phase B** (the settings reorganisation:
   wizard *is* Connection, the old list moves under Advanced, Tailscale becomes
   Log in / Choose device / automatically start with app, default OFF, app language English).

## The live service is not a sandbox

`hermes-serve` is **active and serving the user's phone right now** (verified: active,
`GET /login` → 200, plugin mounted and answering). If you redeploy the plugin or restart
the dashboard:

- restart deliberately, then wait,
- confirm `GET /api/plugins/personae-mobile-auth/health` answers **and** `/pair` still
  renders, **before** you do anything else,
- never leave it down, and never leave a half-copied plugin on disk.

The env bearer must keep working unchanged (`plugin.yaml` → `requires_env:
HERMES_PERSONAE_BEARER`). Existing paired devices must not be invalidated by the version bump.

## What the operator did *not* verify for you

The Phase B diff was not reviewed line by line, and no one has seen the app-side Phase B.
"Done" means measured on this machine with the output pasted — a claim without a run
behind it is not done.

## Budget and shape

Fresh wall clock. Commit per item, each commit backed by a test that actually ran. Partial
progress is acceptable and should be named as such — **Phase D is deferrable by name**.
Deliverable stays: `dist/personae-0.7.0.apk`, versionName `0.7.0` / versionCode `8`, same
signing key. If you hit a wall you cannot pass, write the blocker at the end of
`PROGRESS.md` and stop — never fake a green.
