# GOAL-0.9.1 — Personae Mobile: the Settings page, four corrections

Binding brief. This file, not your memory of any other brief, is the contract. Where this file is silent,
the existing repo conventions win. Where this file and the repo disagree, this file wins and you say so in
`PROGRESS.md`.

This is the user's review of the **shipped 0.9.0** settings page. It is a corrections batch, not a new feature
batch. Nothing else in the app changes.

## 0. What "done" means

The finish line, and the only finish line:

- `dist/personae-0.9.1.apk` exists, `versionName 0.9.1`, `versionCode 11`, signed with the **same release key**
  as 0.1.0–0.9.0 (so it installs straight over 0.9.0).
- `logs/verify-0.9.1.sh` + `logs/verify-0.9.1.txt`, and the last line of the `.txt` reads
  `RESULT: PASS — 0.9.1 verified`.
- Every item in §2 has a test that **names it** (`"0.9.1 S<n>: <what it asserts>"`), and the app suite is
  **≥ the 0.9.0 floor with no regressions**.
- `server/install.sh --check` reports **no drift** — S0's five files are really deployed this time. (0.9.0 said it
  had done this. It had not. See S0.)
- `PROGRESS.md` has a `## 0.9.1` section: what landed per item, every test count, the APK's path/bytes/sha256/
  signer, the decisions from §3 one line each, and what could not be verified with the reason.

**Do not stop before that.** A failing item is a fix-and-retry, not a stopping point.

Baseline to beat, measured 2026-10-12T15:27Z (this is 0.9.0, the state you are starting from):

```
app tests   241/241 passed, 0 failed          (floor 196 before 0.9.0)
typecheck   tsc --noEmit rc 0
server      server/run-tests.sh tests  ->  75 passed
            (the bare `venv/bin/python -m pytest server/tests -q` form fails on this host
             by design; server/run-tests.sh is the runner of record)
verifier    47 named tests, RESULT: PASS
apk         dist/personae-0.9.0.apk  117547098 bytes
            sha256 047da9e25092510bebbc606330586de528190b8ca07ad0d2a18cd75a51f5a131
            com.personae.mobile / 10 / 0.9.0 / min-sdk 24 / target-sdk 36
signer      CN=Personae Mobile, OU=Mobile, O=Personae, L=Lisboa, C=PT
            SHA-256 bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26
```

## 1. Standing rules

1. **One commit per item**, message prefixed `0.9.1 S<n>:` and naming the item it closes.
2. **Never print, echo or paste a credential.** Secrets live in `~/.hermes/.env` and are loaded
   into your environment. The verifier asserts *zero* live bearer occurrences and zero host literals in the
   shipped bundle — keep it that way. Any value you ever see is `[REDACTED]` in anything you write.
3. **Do not restart `hermes-serve`.** It serves the live dashboard on `:9119`. Read from it, never bounce it.
4. **English only, from now on.** 0.9.0's rule was "both languages must be filled in for every new string".
   the user's §2.4 supersedes it: `language` stops being a setting and English is the default. New strings need an
   EN entry only. **Do not delete the PT string table** — leave it in place, unreachable, and say so in
   `PROGRESS.md`. Deleting it is a separate decision the user has not made.
5. **Tests are the argument.** Every item's test must fail before the change and pass after. Follow the
   convention exactly: `"0.9.1 S<n>: <what it asserts>"`.
6. **No new dependency, native or JS, without saying so out loud** in `PROGRESS.md` with the reason.
7. **Nothing is verified visually.** There is still no `adb` on this host and no renderer for `app/*.tsx`.
   Every item below is therefore specified as a claim the suite can prove — plan-as-data, style-array
   inspection, source-inspection — and anything that is genuinely only visible on a phone goes in
   `PROGRESS.md` under **Not verified**, with that reason. Do not write "now aligns" as if you had seen it.
8. **The push work stays parked.** No `google-services.json`, no sender, no Firebase scaffolding, nothing
   device-side called "push". It is deferred to the next update; `PROGRESS.md` keeps that line.
9. **`~/Projects/hermes-desktop-plugins/personae` stays untouched.** Nothing in this batch requires it.
10. **Build with a leash.** The previous run sat on load average 319: this box has 12 cores and 3,758 live
    threads, and Gradle's default worker pool pushed `npx tsc` past the tool timeout. So: `--max-workers=4`,
    `org.gradle.daemon=false`, redirect long-running output to `logs/` and poll with light commands. Sequence
    it — code, then typecheck, then tests, then **one** build at the end.

## 2. The four items

the user's words for each item are quoted verbatim in §6. These are the specs.

### S0 — deploy what 0.9.0 documented but never deployed

**Measured 2026-10-13, before you start.** `server/install.sh --check` says:

```
missing: personae-mobile-state/__init__.py
missing: personae-mobile-state/plugin.yaml
missing: personae-mobile-state/dashboard/manifest.json
missing: personae-mobile-state/dashboard/plugin_api.py
missing: personae-mobile-state/dashboard/preferences.py
```

`~/.hermes/plugins/` contains `personae-mobile-auth` and **no** `personae-mobile-state`, and
`~/.hermes/config.yaml` enables only `personae-mobile-auth`. So 0.9.0's Phase A surface — the
archive/delete verbs at the dashboard's own endpoints, and the portable-preference document — is not
merely dormant awaiting a restart: **it was never installed.** `PROGRESS.md`'s 0.9.0 Phase A section says
it was deployed. That sentence is wrong today, and the app has been quietly running 0.8.0's fallback the
whole time. Do not assume it is running; do not trust the 0.9.0 prose.

**The change:**

- Run `server/install.sh` from the repo root (idempotent; copies the five files into
  `~/.hermes/plugins/personae-mobile-state/`, enables the plugin in `config.yaml` if absent, never touches a
  plugin's `state/` directory, reads and prints no secret).
- Re-run `server/install.sh --check` and require it to report **no drift**.
- Run the plugin's own tests and the server suite (`server/run-tests.sh tests`).
- **Do not restart `hermes-serve`** (§1.3). The routes mount on the next start, whenever that is; that is
  deliberately not your call. Record in `PROGRESS.md` that the deployment is now real and the *effect* is
  still waiting on a restart.
- Correct the record: add one line to 0.9.0's Phase A section saying the deploy was found missing on
  2026-10-13 and is now done. Leave the rest of that section alone.

**Acceptance — this item's proof is not a test, and you should say so:** the evidence is
`server/install.sh --check` printing no drift, plus the deployed files existing under
`~/.hermes/plugins/personae-mobile-state/`. Paste the actual command output into `PROGRESS.md`. Add the same
check to `logs/verify-0.9.1.sh` so a future run cannot make this claim without it.

### S1 — "Notifications is offset from the rest of the rows. Fix it."

**Why it happens (verified, not guessed):** on the index, `SETTINGS_PAGE_ROWS`
(`src/settingsPages.ts:47-80`) marks the Notifications row `sibling: true`; `siblingBelow('notifications')`
(`:172-177`) then returns `'agent'`, and `app/settings.tsx:493` applies `styles.pageRowSibling` to that one
row. That style is `{ marginLeft: space.lg, marginTop: -space.sm + 2 }` (`app/settings.tsx:1336`). One row is
indented and pulled up; four are not. That is the offset.

**The change:**

- Every index row renders with **identical** layout. Drop `pageRowSibling` from the applied style array.
- **Keep** `sibling: true` and `siblingBelow()` in `src/settingsPages.ts` — the adjacency ("Notifications is
  the row directly under Agent Preferences") is still true and still asserted. It simply stops being a visual
  modifier. Say that in the docstring so the next reader does not reintroduce it.
- Remove the now-unused style if nothing else references it.

**Acceptance:** a test that walks `settingsRows()`, computes the style array each row would receive, and
asserts no row carries a horizontal offset modifier — i.e. the rows are geometrically identical and the
indent cannot come back. Keep the existing ordering/adjacency test green.

### S2 — "The back arrow should be the top, the UI should not introduce a new one."

**Why it happens:** the settings route already has the Stack header with a back arrow
(`app/_layout.tsx:67`). Each sub-page then draws a **second** back control in the body —
`backRow` (`app/settings.tsx:512-521`), styled by `styles.pageBack` (`:1346`): a `chevron-back`, the word
"Settings", and a scope chip, wired to `setPage('index')`. Two back affordances, and the body one can only
ever go to the index.

**The change — one back control, in the header, at the top:**

- Delete the in-body `backRow` (and `pageBack`/`pageBackText` if nothing else uses them).
- The header's back arrow walks **one level up**, and that is a fact about the plan, not a conditional:
  add `SETTINGS_PAGE_PARENT` + `parentPage(id)` to `src/settingsPages.ts` (same plan-as-data convention as
  the rest of that module) so `advanced → gateway`, and `agent | notifications | gateway → index`, and
  `index → the roster` (today's behaviour, unchanged).
- Drive it from a custom `headerLeft` on the settings screen so the header arrow and the plan cannot disagree.
- The header title becomes the current page's title (`t.settings.pagesTitle` on the index, the sub-page's own
  `pages[...Title]` on a sub-page), so the top bar says where you are.
- **Android hardware back must pop one level too**, so the two agree. If you find a reason it cannot, say so in
  `PROGRESS.md` rather than leaving them to disagree silently.

**Acceptance:** tests proving (a) a sub-page's body renders no back control, (b) `parentPage('advanced') ===
'gateway'`, (c) back from a sub-page lands on its parent and not on the index, (d) the index back still leaves
for the roster.

### S3 — "The 'advanced' page should be inside the 'Gateway Settings'."

**Today:** `advanced` is the fourth row of the index (`src/settingsPages.ts:72-79`), a sibling of Gateway
Settings.

**The change:**

- Remove the `advanced` row from `SETTINGS_PAGE_ROWS`, so it no longer appears on the index.
- Inside the `gateway` page (`app/settings.tsx:543`), add **one row** in the same `pageRow` shape as the index
  rows — title `t.settings.pages.advancedTitle`, help `t.settings.pages.advancedHelp`, chevron — that opens the
  advanced page (`setPage('advanced')`).
- `parentPage('advanced') === 'gateway'` (S2's map), so the one back arrow returns to Gateway Settings.
- **This is a move, not a rewrite.** The advanced page's contents stay byte-for-byte what 0.9.0 shipped
  (connection type, address, key, routes, tailnet internals, status, log). Its scope stays `device-local`
  (`scopeOfRow('advanced')`), which is already correct: it holds the address, the key and this device's routes.
- The `gateway` row's own help text may need one clause saying Advanced now lives inside it — if you touch it,
  EN only (§1.4).

**Acceptance:** tests proving the index has no advanced row; the gateway page has exactly one row that opens
advanced; `parentPage('advanced') === 'gateway'`; and every existing advanced-content test still passes
**unchanged** (that is the proof it was a move).

### S4 — Agent Preferences

#### S4.1 — "remove language and English is default"

The language control is `app/settings.tsx:671-694` (an EN/PT segment control over `settings.language`, saving on
tap). the user wants it gone and English to be what the app speaks.

**The change:**

- Delete the language field, the segment control and its two labels from the Agent Preferences page.
- `language` stops being a user-facing setting: remove it from `DEVICE_LOCAL_SETTING_IDS`
  (`src/settingsPages.ts:123`) and from `src/settingsLayout.ts`'s field list if it is there. A device-local
  setting that can no longer be set is a lie on a page whose whole job is saying which settings exist.
- The app's effective language is **English, always** — including when a stored blob from an older build still
  carries `{language: 'pt'}`. Ignore the stored value rather than honouring it; the setting does not exist any
  more, so a stale one must not decide anything.
- Leave the i18n plumbing compiling and leave the PT table in place (§1.4).
- If a test currently asserts the language switch works, **supersede it in place and rename it** — do not leave
  a test pinned to behaviour you just deleted.

**Acceptance:** tests proving the Agent Preferences page offers no control that changes the language, and that
a stored `{language: 'pt'}` still renders English.

#### S4.2 — "Rename 'Session Types' to 'Display Session Types', and add more checkboxes for more granular control. One for sessions, another for Cron, another for webhook, another for one-shots."

Today the setting is a **two**-boolean model: `SessionTypes = { sessions, automatic }` (`src/settings.ts:36`),
default `{ sessions: true, automatic: false }` (`:43`), rendered as two checkboxes by
`sessionTypeChoices()` (`src/logic/rosterFeed.ts:105-110`) under the label `t.settings.sessionTypes`
(`src/i18n.ts:292` = `'Session types'`). `'automatic'` currently bundles cron **and** webhooks into one bucket
and says nothing about one-shots (`t.settings.typeAutomatic` = `'Automatic runs (cron, webhooks)'`, `:296`).

**The change:**

- **Label:** `sessionTypes` → `'Display session types'`, and the help text says plainly that this is what the
  list *shows* — a display filter, not a capability being enabled.
- **Model:** `SessionTypes` becomes `{ sessions, cron, webhook, oneshot }`;
  `DEFAULT_SESSION_TYPES = { sessions: true, cron: false, webhook: false, oneshot: false }`.
- **Migration — this is the part that is easy to get wrong.** `normalizeSessionTypes()` (`src/settings.ts:170`)
  must read a legacy blob's `automatic: true` as `cron: true, webhook: true, oneshot: true`, and a legacy
  `automatic: false` (or an absent key) as all three false. Without this, a desktop still writing the
  two-boolean shape silently switches the phone's runs **off** and the sync looks broken in one direction only.
  State the rule in the docstring; it is the only place the old shape may be read.
- **Classifier:** `sessionTypeOf()` (`src/logic/rosterFeed.ts:73`) returns one of the four ids, read off
  `source`: `cron` and `cron_output` → `'cron'`; `webhook` → `'webhook'`; `oneshot` → `'oneshot'`; anything else
  → `'sessions'`. **Keep it derived from `NON_CONVERSATION_SOURCES` / `isAutomatic()` (`:41-49`)** so a new
  job-run source is still added in exactly one line and the four-way split cannot drift from "is this a run".
  Keep the fail-open rule verbatim: an unknown source is a conversation, because a source the app has never
  heard of must not make a real session vanish. `NON_CONVERSATION_SOURCES` is today
  `{cron, cron_output, webhook}` — one-shots are a **fourth** bucket the user is asking for, so `oneshot` joins the
  run set and the classifier gives it its own id rather than folding it into cron.
- **Choices:** `sessionTypeChoices()` returns four, in the user's order — sessions, cron, webhook, one-shots;
  `anySessionType()` covers all four; the "nothing selected" warning and empty state keep working.
- **Strings** (his nouns, title-case to match the rest of the screen — flag it in `PROGRESS.md` if you disagree):
  `typeSessions: 'Sessions'`, `typeCron: 'Cron'`, `typeWebhook: 'Webhooks'`, `typeOneshot: 'One-shots'`, each
  with a one-line help.
- **The checkpoint notifications must agree.** `sessionTypeOf()` is deliberately the single classifier the roster
  list *and* `useCheckpoints` both consult, so the phone can never hide a run and then announce it. Whatever
  you do to the classifier, that property must survive — assert it.
- **Sync, and why no server change is needed:** the portable key stays `session-types` — no new key, so
  `PORTABLE_KEYS` (`src/sync/preferences.ts:32`) and the plugin's `PORTABLE_KEYS`
  (`server/personae-mobile-state/dashboard/preferences.py:43`) are unchanged. The document validates **key
  names** and a byte cap, not the value's shape (`preferences.py:99-158`), so a four-boolean object round-trips
  as-is. Assert that round-trip rather than trusting it.
- **Note for the record, in `PROGRESS.md`:** when the desktop pane becomes a reader of `session-types`, it must
  adopt the four-key shape and treat a legacy `automatic` as the three run types. The pane is not touched here.

**Acceptance:** four checkboxes; each one independently filters the list (four cases); all-off still shows the
empty state with the reason; a legacy two-boolean blob loads as the three run types it meant; the portable
round-trip carries four booleans; the checkpoint watcher and the list still consult one classifier.

## 3. Decisions taken on the user's behalf (one line each in `PROGRESS.md`)

1. **S2's reading of "the back arrow should be the top"**: exactly one back control, the header's, popping one
   level, with the header title naming the current page. If the user meant "keep the body row and hide the header
   arrow", that is a one-line swap inside S2 and nothing else moves.
2. **S4.2's labels** are his nouns in title case, matching the other rows.
3. **The PT string table stays** (§1.4) and the PT entries for the four new labels are *not* written.
4. **Version 0.9.1 / versionCode 11** — corrections to 0.9.0, not a feature release.
5. **The desktop pane plugin is out of scope** (§1.9) even though it renders session-type filtering of its own.

## 4. Verification and the build

Run, in this order, and keep the output:

```bash
npx tsc --noEmit                                    # rc 0
npm test                                            # >= 241 + the new 0.9.1 tests, 0 failed
server/run-tests.sh tests                           # >= 75 passed
```

Then copy `logs/verify-0.9.0.sh` to `logs/verify-0.9.1.sh` and bump: the version pair, the byte count, the
sha256, the named-test list (the four `0.9.1 S<n>` names join it), and the feature strings the bundle check
greps for. The `.txt` must end `RESULT: PASS — 0.9.1 verified`.

Then the one build, leashed (§1.10):

```bash
cd android && ./gradlew assembleRelease --max-workers=4 -Dorg.gradle.daemon=false > ../logs/gradle-v091.log 2>&1
```

Copy the artifact to `dist/personae-0.9.1.apk`, print its bytes / sha256 / signer SHA-256 beside the 0.9.0
values in `PROGRESS.md`, and confirm `app.json`'s version pair matches the APK's own summary.

## 5. Where everything is

| thing | file |
|---|---|
| the index, as data | `src/settingsPages.ts` — rows `:47-80`, `siblingBelow` `:172-177`, scopes `:102-124`, portable key names `:131-135` |
| the screen | `app/settings.tsx` — `page` state `:109`, index render `:476-509`, `backRow` `:512-521`, sub-page frame `:533-545`, gateway page `:543`, agent page `:668-731`, language field `:671-694`, session-type checkboxes `:702-728`, advanced page `:804-805`, styles `:1324-1350` |
| the header | `app/_layout.tsx:57-69` (Stack + `headerShown: false` on `index` only) |
| the model | `src/settings.ts` — `SessionTypes` `:36`, `DEFAULT_SESSION_TYPES` `:43`, `normalizeSessionTypes` `:170` |
| the classifier | `src/logic/rosterFeed.ts` — `NON_CONVERSATION_SOURCES` `:41`, `isAutomatic` `:43`, `SessionType` `:60`, `SESSION_TYPE_DEFAULT` `:66`, `sessionTypeOf` `:73`, `sessionTypeEnabled` `:83`, `sessionVisible` `:89`, `filterSessionTypes` `:94`, `anySessionType` `:100`, `sessionTypeChoices` `:105` |
| strings | `src/i18n.ts` — `sessionTypes` `:292`, `typeSessions`/`typeAutomatic` `:294-296`, `language*` `:341-344`, `pagesTitle` `:351`, `pages.*` `:354-361` |
| sync | `src/sync/preferences.ts` — `PORTABLE_KEYS` `:32`, `readPortable` `:41-51`, `applyPortable` `:64-75` |
| the document (server) | `server/personae-mobile-state/dashboard/preferences.py` — `PORTABLE_KEYS` `:43`, `_check_key` `:99`, `validate_patch` `:114` |
| package version | `app.json:5` version, `:20` versionCode |
| verifier | `logs/verify-0.9.0.sh` + `.txt` — copy the shape, bump the numbers |

## 6. Report

`PROGRESS.md` gets a `## 0.9.1` section in the shape of 0.9.0's: what landed per item, every test count, the
APK's path/bytes/sha256/signer, §3's decisions one line each, and what could not be verified with the reason.
Then stop — that is the finish line.

---

the user's own words for this batch, kept so nobody paraphrases them later:

> Let's focus on the settings page
> 1. Notifications is offset from the rest of the rows. Fix it.
> 2. when clicking into a sub-page (advanced, for example), the back arrow should be the top, the UI should not
>    introduce a new one.
> 3. The "advanced" page should be inside the "Gateway Settings".
> 4. In Agent preferences
> 4.1 remove language and English is default.
> 4.2 Rename "Session Types" to "Display Session Types", and add more checkboxes for more granular control. One
>     for sessions, another for Cron, another for webhook, another for one-shots.
