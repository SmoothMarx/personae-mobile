# GOAL 0.7.0 — Personae Mobile: five fixes on 0.6.1

**You are cody, building Personae Mobile 0.7.0.** Project root: `~/Projects/personae-mobile`
(repo, TypeScript/React Native/Expo, expo-router). This file is the binding contract for this run.
`PLAN-0.7.0.md` in the same directory is the reference and explains *why* each item is shaped this
way; **on conflict, this file wins**.

## Deliverable

`dist/personae-0.7.0.apk` — an installable release APK with `versionName 0.7.0`, `versionCode 8`,
signed with the **unchanged** release key, containing phases A-C of §3 below (and phase D if the
budget allows). Plus: the tests that prove each item, and `logs/verify-0.7.0.sh` that anyone can
re-run to check the artifact.

If the run budget runs out mid-way, the deliverable is the APK anyway — built from whatever phases
did land — with `PROGRESS.md` naming exactly which phases landed and which did not. A partial
release that says what it is, is a pass. A rebuild that hides a missing phase is not.

## 1 · Ground truth, measured today (2026-10-11) — do not re-derive, do not trust older docs

| Fact | Command | Value |
|---|---|---|
| app tests baseline | `npm test` | **145/145 passed, 0 failed** — this is the floor |
| typecheck | `npx tsc --noEmit` | rc 0 — must stay 0 |
| server tests | `~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q` | 43 passed (floor 43) |
| current version | `app.json` | `0.6.1`, `android.versionCode 7` — bump both |
| release keystore | `~/.personae-android/` via `-v …/personae-android:/signing:ro` | signer SHA-256 must stay `bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26` |
| Android toolchain image | `docker images` | `personae-android:1` (has `apksigner`, `apkanalyzer`, `aapt2` at `$ANDROID_HOME/build-tools/36.0.0`) |
| dashboard backend | `systemctl --user cat hermes-serve.service` | `hermes dashboard --host 0.0.0.0 --port 9119`, v0.21.5 |
| host addresses | `hostname -I` · `tailscale ip -4` | `10.0.0.15` · `100.64.0.11` |
| tailnet peers (for the picker) | `tailscale status --json` | 33 peers, each with hostname/IPv4/OS/online; self = `personae-sk` `100.64.0.11` |
| profile creation exists | grep the **installed** tree | `~/.hermes/hermes-agent/hermes_cli/web_routers/profiles.py:803` → `POST /api/profiles` |
| the phone | `adb`, both hosts | **absent.** No device test is possible from here |

The build recipe is already proven and written down in `PROGRESS.md` (~:146, ~:612):
`npx expo prebuild -p android --no-install` → `bash scripts/patch-android-signing.sh` →
`bash scripts/patch-android-branding.sh` → dockerised Gradle from `personae-android:1`. Reuse it.
Do not invent a new toolchain, and do not add a dependency for anything that can be done with the
packages already in `package.json`.

## 2 · Secrets

Never print, echo, or commit a credential. The live bearer is read from `$HERMES_HOME/.env` by
**variable name only** — `HERMES_PERSONAE_BEARER` — exactly as `logs/verify-0.6.1.sh` does. If a
command would print a token, redact it as `[REDACTED]`. `server/state/credentials.json` holds device
tokens: read it only to count, never to display.

## 3 · The four phases, in order

Work them in this order. **Commit after each phase** — a killed run must cost only the phase in
flight. Never `git add -A`; stage explicit paths. `dist/`, `logs/`, `android/`, `brand/` are
gitignored unless force-added, and force-adding a binary is not wanted.

### Phase A — avatars, at Telegram's size

Reference measured from the file the user linked (Figma fileKey `bbuc1DU76urt0JmakirYAd`, page `0:1`;
that canvas is 360 wide so 1 px = 1 dp):

| Element | Node | Size |
|---|---|---|
| chat row | `8:4771` | 360 × 70 (content 62, 4 top inset) |
| avatar slot → circle | `8:4775` → `8:4776` | 58 × 58 → **54 × 54** |
| text column x | `8:4778` | 70 = 16 inset + 54 avatar + 16 gap |
| title / preview | `8:4780` / `8:4786` | 19 dp / 18 dp, 27 dp pitch |
| divider inset | `8:4806` | 78 |
| unread counter | `8:4804` | 24 × 24 |

Change: `AVATAR_SIZE` `28 → 54` (`src/logic/avatars.ts`), `Face` default `32 → 54`
(`src/roster/components.tsx`), roster rows ≈70 dp with a 16 dp avatar→text gap and dividers that
clear the avatar. `avatarKey()` already includes the size, so cached art refreshes itself.
Assert the row geometry in a test — a title that truncates at 54 dp is a fail.

### Phase B — Settings: the wizard is Connection; the list goes under Advanced

1. Extract the three wizard steps (Service → Sign in → Check, documented at `app/connect.tsx:8-12`)
   into shared components. **Both** `app/connect.tsx` (the `personae://connect` deep-link landing
   route — it must keep working) and `app/settings.tsx` render those components. One
   implementation, two hosts. No copy-paste of step logic.
2. `app/settings.tsx` opens on that Connection section. Every other field (surface, address, bearer,
   deadlines, package name, diagnostics, log) collapses under an **Advanced** disclosure, closed by
   default. Nothing is deleted and nothing changes behaviour.
3. The Tailscale section (`app/settings.tsx` ~`:621`) reduces to exactly three affordances:
   - **Log in** — opens the Tailscale app (`openPackage`) with copy saying sign in there and return.
     Show only what can be known: installed (`isPackageInstalled`), tunnel answering (`probeTcp`).
     Do not claim to log in for the user — Android has no cross-app login API.
   - **Choose device** — a picker fed by a **new owner-gated endpoint** on
     `server/personae-mobile-auth/` that runs `tailscale status --json` on the host and returns
     `{available, self, peers:[{name, ip, os, online}]}` over IPv4. The phone cannot enumerate a
     tailnet (`src/native/tailscale.ts` has no such call) — the host can. Picking a device writes a
     route of role `tailscale` through the existing `src/routes.ts` model and probes it before
     trusting it. If the CLI is missing or its output unparseable, return
     `{available:false, reason}` — manual entry stays under Advanced as the fallback, and that path
     is a pass, not a failure.
   - **Automatically start Tailscale with the app** — the existing `autoConnect` switch, promoted.

   The package name and both timeout fields move under Advanced, intact.

### Phase C — one "+" at the top of the roster

A single "+" in the roster header opens a small dropdown: **New group** · **New profile** ·
**New session**.

- New group → the existing group-name prompt (`app/index.tsx:571` machinery).
- New profile → `POST /api/profiles` (exists: installed dashboard `web_routers/profiles.py:803`,
  body `ProfileCreate`: `name`, `clone_from_default`, `description`, …; returns
  `{ok, name, path, model_set, model_error}`). Then refresh the roster. If the device token is
  refused, render the entry disabled **with the reason visible** and report it — never a silent
  no-op.
- New session → a **modal listing existing profiles**, then the existing title prompt, creating the
  session under the chosen profile.

Note for context, not an instruction: Telegram puts this action in a bottom-right FAB (`59:1953`,
53 × 53). the user asked for the top — that departure is deliberate.

### Phase D — multiselect and session groups (defer by name if the budget runs out)

Port the desktop pane's semantics from `~/.hermes/desktop-plugins/messenger/plugin.js` (read it;
do not reinvent):

- groups are **per profile** (`profileSessionGroups` ~`:944`);
- a group **holds** members and is never a parent — children keep **no** `parent_session_id`
  (`:747`, `:786`), so a released session cannot fall back in;
- the group renders as a box (diamond + name) with members inside (`sessionGroupShell` `:845`);
- membership changes go through one target resolver (`sessionGroupMoveTargets` `:1110`).

In the app: long-press a session → selection mode; extend by tapping; a selection bar offers the
batch verbs (group, archive, delete with the existing confirm). **The grouping must ride the
existing sync store** `src/sync/uiSync.ts` — the phone's groups already sync with the desktop
(seed / monotonic `rev` / tombstones, tests 140-145). A second source of truth for group membership
is the failure mode; there must be exactly one.

## 4 · Acceptance — all of these, checked, not asserted

1. `npm test` → **≥145 passed, 0 failed**, and every new behaviour above has at least one test that
   fails before the change and passes after.
2. `npx tsc --noEmit` → rc 0.
3. `~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q` → ≥43 passed (plus new tests
   for the tailscale endpoint's available/unavailable shapes).
4. Phase A: a test asserts the roster row geometry — avatar 54, avatar→text gap 16, row ≈70 — and
   that a long profile name does not truncate.
5. Phase B: a test asserts the Advanced disclosure is closed by default and that Connection renders
   the three wizard steps without navigation. A test asserts `app/connect.tsx` still resolves
   `personae://connect?base=…&code=…` and redeems (the existing pairing tests must stay green).
6. Phase B: the tailscale endpoint has tests for both shapes — peers present, and
   `{available:false, reason}` when the CLI is unavailable.
7. Phase C: tests cover the "+" dropdown's three entries, the profile-picker modal listing every
   profile from `/api/profiles`, and the disabled-with-reason path when `POST /api/profiles` is
   refused.
8. Phase D (if landed): a test proves a group survives a `uiSync` round trip under the desktop's
   rules, and that an emptied group does not linger.
9. `dist/personae-0.7.0.apk` exists and, inside the APK: `versionName 0.7.0`, `versionCode 8`, signer
   SHA-256 `bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26`, the `personae://connect`
   deep link present, the `CAMERA` permission present, and **zero** occurrences of the live bearer
   value (with a positive control proving the grep fires).
10. `logs/verify-0.7.0.sh` exists, is re-runnable, derives the expected version from `app.json`
    rather than hardcoding it, and prints an explicit PASS/FAIL line per check plus a final RESULT.
    `logs/verify-0.7.0.txt` is its saved run.
11. Commits: one per phase, each naming the phase, staged by explicit path.
12. `PROGRESS.md` gains a `0.7.0` section in the existing style, listing what landed, what was
    deferred, and the next run's first step.

## 5 · NOT DONE IF

- Any of the five items is claimed as finished while its test does not exist or does not pass.
- Any test is claimed that you did not run in this run. Name it as not-run instead.
- The version, `versionCode`, or signer fingerprint differs from §4.9 — the APK would not install
  over 0.6.1.
- A phase is reported as landed without a commit, or `git add -A` is used.
- A credential, token, or key appears in any file, commit, log, or output. Use `[REDACTED]`.
- `app/connect.tsx`'s deep-link path is broken, or a second copy of the wizard's step logic is
  introduced to make Settings work.
- Item 4 ships with a second source of truth for group membership beside `uiSync`.
- The phone is implied to have been tested. It cannot be: no `adb` on either host and the Pixel 8 is
  offline.

## 6 · When you cannot complete a step

Stop and write the exact commands for the human instead of guessing. Specifically:

- If `tailscale status --json` is unusable on this host, still ship the endpoint's
  `{available:false, reason}` shape plus the manual-entry fallback, and say so.
- If `POST /api/profiles` refuses the device token, ship item 5 with that entry disabled and the
  reason surfaced; state plainly in `PROGRESS.md` that profile creation is unproven from the phone.
- If phase D cannot be made to ride `uiSync` cleanly, **defer it by name** and say why. Shipping A-C
  with an honest note beats shipping a working-looking D that can lose a group on the next sync.

Emitting "I could not do X, here is the command you run" is a pass. Emitting a plausible-looking
success you did not verify is the one failure that costs the whole run.
