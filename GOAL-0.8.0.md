# GOAL 0.8.0 — Personae Mobile: eight refinements on 0.7.0

**You are cody, building Personae Mobile 0.8.0.** Project root: `~/Projects/personae-mobile`
(repo, TypeScript / React Native / Expo, expo-router). This file is the binding contract for this run.
There is no separate `PLAN-0.8.0.md` — the design reasoning is inline, so there is no second document
to contradict. `PLAN-0.7.0.md` and `GOAL-0.7.0*.md` stay in the repo as prior art: read them for the
method, not for the tasks.

## Deliverable

`dist/personae-0.8.0.apk` — an installable release APK with `versionName 0.8.0`, `versionCode 9`, signed
with the **unchanged** release key, containing phases A-G (and H if it can be made to build green).
Plus the tests that prove each item, and `logs/verify-0.8.0.sh` (with its saved run `logs/verify-0.8.0.txt`)
that anyone can re-run. **You do not stop until that APK exists and its verifier prints `RESULT: PASS`.**

Work the phases in order, **committing after each one**, so a killed run costs only the phase in flight.
If the budget closes in on you, an APK built from whatever landed — with `PROGRESS.md` naming exactly
which phases landed and which did not — is a pass. A rebuild that hides a missing phase is not.

## 0 · The operator's list, verbatim — this is what "done" means

> 1. Give a litte bit more space between profile rows.
> 2. Make the profile pictures 15% bigger.
> 2. When showing session list, make it less indented. In terms of vertical alignment and positioning, the status dot should under the profile picture, offset a bit to the left
> 3. Make the default view only actual sessions show up in the session list, no cron jobs, etc. Make an option in settings where users can check/uncheck the type of sessions they want to see
> 4. Allow the user to slide a session row to the left, unveiling a button trash can icon with red background, where the user can confirm delete, and a button with an archive icon with blue background
> 5. When clicking the + button on top, it opens the drawer at the bottom, the items are cut off at the bottom.
> 6. Make the top buttons (+ | Expand | Settings) 10% bigger
> 7. Set up push notifications to warn the user when a session has reached a checkpoint (either done, or waiting on user iteraction)

| operator item | phase | primary touchpoints |
|---|---|---|
| row spacing | **A** | `src/roster/geometry.ts`, `src/roster/components.tsx` |
| avatars +15% | **B** | `src/logic/avatars.ts`, `src/roster/geometry.ts`, `src/roster/components.tsx` |
| session list indent + dot position | **C** | `src/roster/geometry.ts`, `src/roster/components.tsx` |
| session-type filter + settings | **D** | `src/logic/rosterFeed.ts`, `src/roster/useRoster.ts`, `src/settings.ts`, `app/settings.tsx` |
| swipe to archive / delete | **E** | new `src/logic/swipe.ts`, `src/roster/components.tsx`, `app/index.tsx` |
| "+" sheet clipped at the bottom | **F** | `src/roster/components.tsx` (`ActionSheet`, `PromptSheet`) |
| top buttons +10% | **G** | `app/index.tsx` (header) |
| checkpoint notifications | **H** | new `src/logic/checkpoints.ts`, `src/logic/watcher.ts`, `app/_layout.tsx`, `app/settings.tsx` |

## 1 · Ground truth, read off the repo by the operator (2026-10-12T11:35Z)

**Re-measure these in your first minutes. Do not trust this table over the code, and do not trust any
older doc (the 0.7.0 numbers are history, not current).**

| Fact | Where | Value right now |
|---|---|---|
| current version | `app.json` | `0.7.0`, `android.versionCode 8` — bump both to `0.8.0` / `9` |
| 0.7.0 shipped | `dist/`, `logs/verify-0.7.0.txt` | `personae-0.7.0.apk` present; verifier `RESULT: PASS` |
| avatar size | `src/logic/avatars.ts:29` | `AVATAR_SIZE = 54` |
| row height | `src/roster/geometry.ts` | derived: 2 × 27 dp line pitch + 2 × 8 dp padding = **70** |
| row text x | `src/roster/geometry.ts:74` | `textX = inset(16) + AVATAR_SIZE(54) + avatarGap(16) = 86` |
| session row indent | `src/roster/components.tsx` (`sessionRow`, `sessionDot`) | `paddingLeft: ROW_METRICS.textX` (**86**), dot inside a 14 dp `sessionDot` column, left of the text |
| automatic (cron) rows | `src/router/useRoster.ts:351-355` | `automatic: false` for conversations, `automatic: true` for `row.automatic` runs — **this is why cron shows up today** |
| feed classification | `src/logic/rosterFeed.ts:40,46,52` | `NON_CONVERSATION_SOURCES = {cron, cron_output, webhook}`, `conversationsOnly()`, `automaticRuns()` |
| live source census | comment at `src/logic/rosterFeed.ts:15-16` | `{desktop 22, cli 6, cron 6, api_server 1, tui 1}` — `source` is the field that decides a type |
| bottom sheet | `src/roster/components.tsx` (`styles.sheet`, ~:397) | `paddingVertical: space.md`, `maxHeight: '80%'`, **no safe-area bottom inset**, entries not scrollable |
| header icons | `app/index.tsx:232,248,254` | add **20**, expand **16**, settings **16** |
| settings store | `src/settings.ts:80-105` | key `personae.settings.v1`, `DEFAULT_SETTINGS` merge |
| notification deps | `package.json` | **absent**: no `expo-notifications`, no `react-native-gesture-handler`, no `react-native-reanimated`. Present: `react-native-safe-area-context ~5.7.0`, `react-native-sse ^1.2.1` |
| live-state hints | `src/api/client.ts` (`HermesSession`) | `is_active`, `waiting`, `needs_input`, `last_read_at`, `last_active` — all optional, "tolerated when absent" |
| signer | release keystore via `scripts/patch-android-signing.sh` | SHA-256 must stay `bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26` |
| application id | `app.json` | `com.personae.mobile` — unchanged, so it installs over 0.7.0 |
| the phone | `adb`, both hosts | **absent again.** No device test is possible. Say so; never imply otherwise. |

Build recipe (proven — reuse, do not invent): `npx expo prebuild -p android --no-install` →
`bash scripts/patch-android-signing.sh` → `bash scripts/patch-android-branding.sh` → dockerised Gradle from
the `personae-android:1` image, `-v ~/.personae-android:/signing:ro`. **Before every prebuild**, clear the
root-owned tree: `docker run --rm -v $PWD:/work alpine:latest sh -c "rm -rf /work/android"`.

## 2 · Secrets and house rules

Never print, echo, or commit a credential. Read the live bearer from `$HERMES_HOME/.env` **by name only**
(`HERMES_PERSONAE_BEARER`) and use `curl --oauth2-bearer "$LIVE_BEARER"`; a file written by tooling cannot
contain the literal `Authorization: Bearer *** (it is redacted to `***` at write time and silently breaks
verifiers). `server/state/credentials.json` is read to count, never to display. Redact as `[REDACTED]`.

**This release needs no server-side change at all.** The `source` field Phase D needs is already served on
the recents slice; Phase H is device-side. If you conclude a server change *is* required, write it down in
`PROGRESS.md` and say what it needs — do not restart `hermes-serve.service` from inside a tool call. Your own
run lives in a cgroup that the dashboard serves: the 0.7.0 runs twice killed themselves exactly that way.

## 3 · The phases

### Phase A — more air between profile rows

The row is a two-line cell (title + preview at a 27 dp pitch) with padding above and below; the divider sits
at the bottom of the cell, so "space between rows" *is* the cell's height. Raise the vertical padding by
**3 dp per side** so the cell renders **76 dp** (was 70, +8.6%) — a bigger jump starts reading as a layout
bug, a smaller one is invisible on a phone.

Change: `src/roster/geometry.ts` (the `8` in the padding constant → `11`) and whatever in
`src/roster/components.tsx` derives from it. The line pitch (27), the divider inset, and the horizontal
inset all stay. **Update the existing geometry test deliberately** — it currently expects ≈70; the new
expectation is 76, and the test's comment must say it moved for "more air between profile rows". Do not
delete the old assertion's history from the log notes; supersede it.

Test: row height is 76, and title + preview still get their 27 dp pitch inside it.

### Phase B — avatars 15% bigger

`AVATAR_SIZE 54 → 62` (`54 × 1.15 = 62.1`, taken down to 62 — a whole number, so no half-pixel faces).
`Face`'s default already follows `AVATAR_SIZE`. `avatarKey()` already includes the size, so cached art
refreshes itself — verify that in a test rather than assuming it.

Knock-ons that must follow, not be re-hardcoded: `textX` becomes `16 + 62 + 16 = 94`, and the divider inset
must clear 62. Both are derived in `src/roster/geometry.ts` — keep them derived. This is a deliberate
departure from the Telegram reference you measured in 0.7.0 (54 dp): say so in a comment, so the next reader
does not "fix" it back.

Test: avatar 62, `textX` 94, divider inset ≥ 78; and **the longest real profile label on this box still renders
without ellipsis** at 62 dp. If it *does* ellipsize, keep 62 (that is the operator's explicit ask), and report
the exact label and the width in `PROGRESS.md` — do not silently ship a truncated name, and do not quietly
shrink the face back to make the test pass.

### Phase C — session rows: less indent, dot under the face

Today a session row is indented to the *text* column of its profile row (86 dp) with the dot at that same x.
The operator wants the list less indented, and the status dot **under the profile picture, offset a bit to
the left**.

Design, as numbers (put them in `src/roster/geometry.ts` next to the profile geometry, and keep them derived
from `AVATAR_SIZE` where it is cheap to do so):

- the row's left padding becomes the **dot column**, not the text column: `paddingLeft: 30` (was 86);
- the dot keeps its 14 dp column there, so the dot spans x ∈ [30, 44] and its centre is **37**;
- the profile face spans [16, 78] at 62 dp, centre **43** — so the dot sits under the picture, **6 dp left of
  its centre**. That is the "offset a bit to the left";
- the existing `gap` (keep `space.sm`) then puts the title text at ~52 dp — **34 dp less indented than today**.

Keep the `automatic` run rows using the same column (they swap the dot for the clock glyph) so both row
species stay aligned. Assert in a test: dot column x = 30, dot centre = 37, resulting text x ∈ [48, 56].

### Phase D — the default list shows conversations only, with checkboxes in Settings

Two switches, and one filter function that both the list and Phase H's notifications call:

- `sessionTypes.sessions` — conversations (`source` NOT in `NON_CONVERSATION_SOURCES`). **Default true.**
- `sessionTypes.automatic` — job runs (`cron`, `cron_output`, `webhook`). **Default false** — this is the
  operator's "no cron jobs" ask, and it is a one-line change at the site that currently always shows them
  (`src/roster/useRoster.ts:353-355`).

Rules:

1. The filter is **one exported function** (`src/logic/rosterFeed.ts`), used by the feed and by Phase H. A
   second copy of the classification is a fail (§5).
2. `source` decides the bucket. An **unknown** source counts as a conversation (fail-open: an unrecognised
   new source must not make a real session vanish) and that rule gets its own test.
3. Settings gains a **Session types** section with those two checkboxes, labelled in plain language
   ("Sessions", "Automatic runs (cron, webhooks)"), plus a one-line explanation of what each hides.
   `src/settings.ts` gains the field with defaults; a **stored v1 blob without the new key must load with
   defaults** — test that migration explicitly.
4. Both switches off is a legal state: the list shows an empty state that *says why* ("No session types are
   selected — turn one on in Settings"), never a silently blank screen.
5. Search results keep working: filtering hides rows from the default view, it does not make them
   unreachable by search. If that is not what the code wants to do, state the decision in `PROGRESS.md`.

### Phase E — swipe a session row to archive or delete

Reveal two actions on the row's right edge by sliding left: **archive** (blue background) and **delete**
(red trash, **with a confirm step**, per the operator's wording).

Implementation constraints:

1. **No new native dependency.** Use React Native core `Animated` + `PanResponder`. Do **not** add
   `react-native-gesture-handler` / `react-native-reanimated` for this — a new native module is the single
   biggest risk to a green build, and `PanResponder` is enough for one horizontal reveal. (If you can prove
   `PanResponder` cannot work here, say so in `PROGRESS.md` with the failing case instead of reaching for a
   dep.)
2. The gesture logic lives in a **pure module** `src/logic/swipe.ts`: which row is open (exactly one at a
   time), the open/close thresholds, the confirm state, and the claim predicate — claim only when
   `|dx| > 8 && |dx| > 1.2 × |dy|`, so a vertical scroll is never eaten and a tap never opens a row.
   The component is a thin shell over it; that is how this repo tests UI without a phone.
3. Colours from the theme, not literals: reuse the red already used for destructive verbs, and add a blue
   token for archive (`src/theme.ts`) if none exists — pin both in a test so a palette change is visible.
4. **Delete is two-step** (first tap arms, second confirms; arming must not dismiss the swipe, and the armed
   state must be escapable) and it goes through the **existing delete verb** — one delete path in the app.
   Archive is one tap, through the existing archive verb. Reusing them is the requirement; a second
   implementation that happens to call the same endpoint is a fail.
5. **Surface honesty:** on the gateway surface, archive/delete answer `501 archiveUnsupported` /
   `deleteUnsupported` (`src/api/backend.ts`). The revealed buttons must therefore render **disabled with the
   visible reason** on that surface, exactly like 0.7.0's "+" menu — never a tap that does nothing.
   Test the pure module's `{enabled, reason}` for both surfaces.
6. The verbs must stay reachable **without** a gesture: the row already has a long-press menu; keep it, and
   expose the same two verbs as `accessibilityActions` on the row.
7. Opening one row closes any other; scrolling the list closes the open row.

### Phase F — the "+" sheet is clipped at the bottom

Cause, from the code: `styles.sheet` (`src/roster/components.tsx`) pads with `space.md` and never accounts
for the device's bottom inset, so on a gesture-nav phone the last entry sits under the navigation bar, and a
longer list has nothing to scroll.

Fix, in the shared sheet style so **both** `ActionSheet` and `PromptSheet` get it:

- `paddingBottom: space.md + insets.bottom` from `react-native-safe-area-context` (already a dependency);
- wrap the entries (not the title, not the prompt actions) in a `ScrollView` inside the existing
  `maxHeight: '80%'`, so a long list scrolls instead of clipping;
- extract the arithmetic into a pure `sheetPadding(insets)` and test it at insets 0 / 24 / 48.

### Phase G — the top buttons, 10% bigger

The header's three glyphs scale by **1.1** from a single constant: add **20 → 22**, expand **16 → 18**,
settings **16 → 18** (`17.6` rounded to a legible 18). Scale the pressable's own box by the same factor and
keep the real hit target **≥ 44 × 44 dp** (the glyphs are small; the touch area is not). Test pins the three
numbers and the hit-target floor.

### Phase H — notifications when a session reaches a checkpoint

The operator wants: *"push notifications to warn the user when a session has reached a checkpoint (either
done, or waiting on user interaction)"*.

**Do this phase last, and scope it honestly.**

1. **Probe before you build.** One authorised request against the live dashboard
   (`curl --oauth2-bearer "$LIVE_BEARER" …` on the recents slice) and look at the real rows: is `is_active`
   present? Is `waiting`/`needs_input`? Write the answer into `PROGRESS.md` with the redacted field list.
   Everything below adapts to what actually exists.
2. **Checkpoint detection is a pure function** in `src/logic/checkpoints.ts`: previous snapshot + current
   snapshot → events. Two kinds:
   - **waiting** — `isWaiting()` (already in `src/logic/lights.ts`) becomes true;
   - **finished** — the session was `is_active` in the previous poll and is not now, with `last_active`
     advanced. **If `is_active` is not served on this surface, you cannot know a turn finished** — then the
     honest fallback is to notify on *new activity since the last poll*, and to say in `PROGRESS.md` that
     "done" could not be distinguished. Never claim a state you cannot see.
3. **The watcher** (`src/logic/watcher.ts`): a foreground-only poll (~30 s) built on the feed refresh that
   already exists, single-flight, stopped when `AppState` is not active, plus one immediate refresh on resume.
   No polling while backgrounded — that is what drains a battery and gets an app killed.
4. **Local notifications, not a fake push.** Add `expo-notifications` with `npx expo install` so the version
   matches SDK 57; declare `POST_NOTIFICATIONS` in `app.json`; create an Android channel (`checkpoints`,
   high importance); request the permission **only when the user turns the master switch on** — never at cold
   start. Read the installed module's own types for the handler shape (SDK 57 renamed the presentation keys;
   do not copy an API sketch from this file).
   **Say what this is:** device-side. It fires while the app is running (foreground, or shortly after
   backgrounding). True closed-app push needs an FCM project + credentials + a sender on the gateway — that is
   **out of scope for 0.8.0**; write it in `PROGRESS.md` as the candidate for 0.9.0. Never describe local
   notifications as "push" in the app's copy, `PROGRESS.md`, or a commit message.
5. **No spam, one source of truth:** dedupe on `(sessionId, kind, last_active)` in a persisted watermarked map
   (AsyncStorage, `personae.notify.v1`, capped, pruned by age); suppress the thread the user is currently
   looking at; and **respect Phase D's filter** — a hidden type never notifies.
6. **Tapping a notification opens that session** (`router.push('/thread/<id>')` via the notification-response
   listener).
7. **Settings:** a Notifications section — master switch + per-kind switches (waiting / finished) —
   with the permission state shown truthfully (granted / denied / not asked) and the disabled-with-reason
   pattern when denied.
8. **The escape hatch:** if `expo-notifications` cannot be installed or cannot build green, **revert Phase H by
   explicit path**, ship 0.8.0 without it, and name it in `PROGRESS.md`. Phases A-G are the release; H is a
   passenger that must never block it.

## 4 · Acceptance — all of these, checked, not asserted

1. `npm test` → the floor you measured in your first minutes, **0 failed**; every new behaviour above has a
   test that fails before the change and passes after. Name each new test.
2. `npx tsc --noEmit` → rc 0.
3. `~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q` → ≥ 60 (0.7.0's floor). No server change
   is expected; if you make one, it only goes up, and it lands in the same commit as its test.
4. Geometry: A (76 dp row), B (62 avatar, 94 textX), C (dot x 30 / centre 37 / text 48-56) each asserted.
5. Settings: the two Session types switches, the v1-store migration, the unknown-source fail-open rule, and
   the both-off empty state each asserted.
6. Swipe: pure-module tests for threshold, one-row-open, tap-vs-drag, the two-step confirm, and the
   gateway-surface `{enabled:false, reason}`.
7. Sheet padding: `sheetPadding()` at insets 0 / 24 / 48.
8. Header: the three scaled glyph sizes and the ≥ 44 dp hit target.
9. Notifications (if H lands): checkpoint transitions (waiting / finished / nothing / dedupe), the
   currently-open-thread suppression, and the filter respect.
10. `dist/personae-0.8.0.apk` exists and, inside the APK: `versionName 0.8.0`, `versionCode 9`, signer SHA-256
    `bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26`, application id
    `com.personae.mobile`, the `personae://connect` deep link, the `CAMERA` permission, `POST_NOTIFICATIONS`
    **iff** Phase H landed, and **zero** occurrences of the live bearer value (with a positive control proving
    the grep fires).
11. `logs/verify-0.8.0.sh` exists, is re-runnable, derives the expected version from `app.json` rather than
    hardcoding it, prints an explicit PASS/FAIL line per check plus a final RESULT, and
    `logs/verify-0.8.0.txt` is its saved run.
12. Commits: one per phase, each naming the phase, staged by explicit path. Never `git add -A`.
13. `PROGRESS.md` gains a `0.8.0` section in the existing style: what landed, what was deferred, the
    phase-D-of-0.7.0 note left intact, and the next run's first step.
14. The APK exists. You did not stop before it.

## 5 · NOT DONE IF

- Any operator item is claimed as finished while its test does not exist or does not pass.
- Any test is claimed that you did not run in this run — name it as not-run instead.
- The version, `versionCode`, application id, or signer fingerprint differs from §4.10 — the APK would not
  install over 0.7.0.
- A new native dependency is added for the swipe (`react-native-gesture-handler` / `react-native-reanimated`).
- Session-type classification exists in more than one place, or the list and the notifications disagree
  about what is hidden.
- A notification fires for a session type the user has hidden.
- Device-side notifications are called "push" anywhere.
- The phone is implied to have been tested. It cannot be: no `adb` on either host.
- A credential, token, or key appears in any file, commit, log, or output.
- `hermes-serve.service` is restarted from inside a tool call.
- Phase D of 0.7.0 (session groups, `session-groups-v1`) is started in this run. It stays deferred; leave its
  `PROGRESS.md` note alone.

## 6 · When you cannot complete a step

Stop and write the exact command for the human instead of guessing:

- `expo-notifications` will not install or will not build → revert H by path, ship A-G, name the blocker.
- The live rows carry no `is_active` → ship the "waiting" notifications plus the activity-change fallback, and
  state plainly that "finished" is not distinguishable on this surface.
- A long profile label truncates at 62 dp → keep 62, report the label and the width.
- `PanResponder` fights the FlatList's scroll in a way you cannot fix → ship the long-press verbs as the
  supported path, defer the swipe by name, and explain the failing case.

Emitting "I could not do X, here is what you run" is a pass. Emitting a plausible-looking success you did not
verify is the one failure that costs the whole run.
