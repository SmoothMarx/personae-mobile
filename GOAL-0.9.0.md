# GOAL-0.9.0 — Personae Mobile

Binding brief. This file, not your memory of any other brief, is the contract. Where this file is silent, the
existing repo conventions win. Where this file and the repo disagree, this file wins and you say so in
`PROGRESS.md`.

## 0. What "done" means

The finish line, and the only finish line:

- `dist/personae-0.9.0.apk` exists, `versionName 0.9.0`, `versionCode 10`, signed with the **same release key**
  as 0.1.0–0.8.0 (so it installs straight over 0.8.0).
- `logs/verify-0.9.0.sh` + `logs/verify-0.9.0.txt`, and the last line of the `.txt` reads
  `RESULT: PASS — 0.9.0 verified`.
- Every item in §4 has a test that **names it**, and the app suite is **≥ the 0.8.0 floor with no regressions**.
- `PROGRESS.md` has a `## 0.9.0` section: what landed, what could not be verified, the exact next step.

**Do not stop before that.** A failing phase is not a stopping point — it is a fix-and-retry. A blocked item is
not a stopping point — see §6 for the two items that are genuinely blocked and the non-blocking path each one
must take. Do not park, do not hand back a partial, do not ask permission to continue.

Baseline to beat, measured 2026-10-12T12:17Z (this is 0.8.0, the state you are starting from):

```
app tests   196/196 passed, 0 failed          (floor 161 before 0.8.0)
typecheck   tsc --noEmit rc 0
server      60 passed in 1.77s  (server/run-tests.sh is the runner of record;
            the bare `python -m pytest server/tests -q` form fails on this host by design)
apk         dist/personae-0.8.0.apk  128502224 bytes
            sha256 1022ad7f8d1144f8a63fc660ccb3f45cce618d0be7567e093f020f734c43edf1
            com.personae.mobile / 9 / 0.8.0 / min-sdk 24 / target-sdk 36
signer      CN=Personae Mobile, OU=Mobile, O=Personae, L=Lisboa, C=PT
            SHA-256 bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26
```

## 1. Standing rules

1. **One commit per phase**, message prefixed `0.9.0 <PHASE>:` and naming the item it closes.
2. **Never print, echo or paste a credential.** Secrets live in `~/.hermes/.env` and are loaded
   into your environment. The verifier already asserts *zero* live bearer occurrences and zero host literals in
   the shipped bundle — keep it that way. Any value you ever see is `[REDACTED]` in anything you write.
3. **Do not restart `hermes-serve`.** It serves the live dashboard on `:9119`, and a previous run killed it by
   accident. Read from it, never bounce it. If a server-side change needs a reload to take effect, say so in
   `PROGRESS.md` and let it take effect on its own schedule.
4. **The server patch must survive `hermes update`.** `~/.hermes/hermes-agent` is Hermes install code and gets
   overwritten. So: prefer a *new* small router/plugin file over editing an existing one; keep any edit to an
   existing file additive and minimal; and write `SERVER-PATCH.md` listing every file you touched under
   `~/.hermes/hermes-agent`, with the exact change, so it can be reapplied in one pass after an update. A
   test that the surface still answers *after* the change is required; a note saying "cannot verify" is not
   enough for this one.
5. **Tests are the argument.** Every item's test must fail before the change and pass after. A test that only
   asserts a style value was written is fine *if* it names the item — that is the 0.8.0 convention (`"0.8.0 A:
   the profile cell is 76 dp"`). Follow it exactly: `"0.9.0 <PHASE>: <what it asserts>"`.
6. **No new native dependency without saying so out loud** in `PROGRESS.md` with the reason. 0.8.0 deliberately
   shipped the swipe on RN core `PanResponder` instead of a gesture library. The one place 0.9.0 almost
   certainly needs a dependency is audio recording (§4 item 9) — that is legitimate and expected, but justify
   it and pick the Expo package, not a third-party one.
7. **Verify on the artifact, not the source.** The APK is the deliverable. `app.json` agreeing with itself is
   not evidence; the verifier's `aapt`/marker checks are.

## 2. Phase 0 — measure before you assume (no product code in this phase)

Write `RECON-0.9.0.md`: for each question, the command you ran and the observed output. A guess here costs a
rewritten phase later. These are the things I could not settle from the outside:

1. **How does an outbound message leave the app today?** Find the route in `src/api/backend.ts` that posts a
   message, and what the body looks like. Is it text-only?
2. **Does a message carry attachments on the wire?** Read the session/thread payload the app already receives
   (the thread endpoint and `/api/profiles/sessions/sidebar`). Is there an attachment/`media`/`files` field on a
   message? **If there is not**, that is the single most important finding in this phase — it decides whether
   §4 items 8 and 9 are client-only work or client + a small server addition.
3. **What can the server already do?** It is more than you think — measured 2026-10-12, all in
   `~/.hermes/hermes-agent/hermes_cli/web_routers/files.py` and `audio.py`:
   - `POST /api/files/upload-stream` — chunked multipart, constant memory, temp-file-then-rename
     (`files.py:694`, via `stream_upload_to_path` at `:650`).
   - `POST /api/files/upload` — base64 `ManagedFileUpload` (`files.py:640`).
   - `POST /api/chat/image-upload` — data-URL images, 25 MB cap (`files.py:467`, cap at `:430`); this is the
     route the dashboard's chat page uses and it drives the TUI's `/image <path>`.
   - `GET` media serving with `inline` vs `attachment` disposition depending on the path (`files.py:594-616`) —
     the comment there says the desktop uses it as its player source for audio.
   - `POST /api/audio/transcribe` — base64 audio, accepts `audio/*` and `video/webm`, with an extension map
     covering `m4a`, `ogg`, `opus`, `wav`, `webm`, `mp3`, `flac`, `aac` (`audio.py:42-53`, `:83`).
   - TTS + a **speak-stream WebSocket** (`audio.py` header, `:51 _SPEAK_MIME_BY_EXT`).
   **Reuse these. Do not invent a parallel upload path.** They are Dashboard-surface routes (`:9119`), which is
   the surface this app already speaks — the legacy `:9222` gateway API has no profile routes at all.
4. **How is the plug-in's per-object menu actually shaped?** Not from its README table — from
   `~/Projects/hermes-desktop-plugins/personae/plugin.js`. See §4 item 6 for the anchors already found.
5. **What actually breaks in landscape?** Constraint first: **there is no `adb` on either host** — 0.8.0 measured
   this, and it is why nothing in 0.8.0 was ever verified on a phone. So this recon is **static**, and the device
   claim belongs in the not-verified list with the reason, not in a commit message as though a phone had run it.
   Audit these, each of which is a real landscape break:
   - `app.json:6` is `"orientation": "portrait"`.
   - Screens apply `paddingTop: insets.top` and nothing horizontal (`app/index.tsx:359`) — the notch's
     **left/right** insets are ignored, and in landscape those are the ones that matter.
   - The sheets cap at `maxHeight: '80%'` (`components.tsx:579`) — which is 80% of a *short* height in landscape.
   - The thread's composer against the raised keyboard (`app/thread/[id].tsx`).
   - Any hard-coded height, fixed `numberOfLines`, or square-ish aspect assumption.
   Each suspect gets a fix or an honest not-verified entry. **Do not claim landscape works** — say what was
   proven statically and what only a device could settle.
6. **Which recorder, and how does the build behave?** Check the installed Expo SDK version, then pick the
   Expo-native recording package that matches it (`expo-audio` on newer SDKs, `expo-av` on older) and install it
   with `npx expo install` — never a hand-pinned version. Then read `PROGRESS.md`'s **"Pitfalls worth keeping
   from this run"** before your first build, because 0.8.0 already paid for these: `expo prebuild` cannot clear a
   root-owned `android/` (Gradle in Docker writes it as root — clean it with
   `docker run --rm -v $PWD:/work alpine:latest sh -c "rm -rf /work/android"` before every prebuild, no sudo);
   the Gradle build must be a **background job**, because a 5-minute tool-call cap makes a foreground wait
   impossible (`setsid nohup docker run … &`, then poll `logs/gradle-v090.log` for `GRADLE_EXIT`); 0.8.0's build
   took **11m42s**; and `npx expo install` can re-resolve the tree and autolink transitive native deps into the
   APK (that is where 114.3 MB → 128.5 MB came from). Expect the recorder to cost more again — name it, do not
   hide it.

## 3. Phases A–J

Order is deliberate. **A is not optional and not last**: three separate items (delete/archive, grouping, sync)
are blocked on the same missing piece — the gateway owning the roster's mutable state — so the surface comes
first and the UI rides it.

- **A — the server surface.** (i) Route the gateway's delete and archive at the verbs the dashboard already
  uses; the `501 archiveUnsupported` / `deleteUnsupported` stubs today live only on the gateway surface
  (`src/api/backend.ts:427,435`) while the dashboard backend already calls `patchFlags(id,{archived:true})` and
  `client.deleteSession(id)` (`src/api/backend.ts:224,228`). Server-side this is plumbing, not new logic:
  `archived INTEGER NOT NULL DEFAULT 0` / `auto_archived` / `pinned` / `hidden` already exist on `sessions`;
  `archive_sessions(...)` is at `hermes_state_sessions.py:1757`; `archive_stale_sessions(idle_days,
  exclude_pinned=True)` at `hermes_state_maintenance.py:274`; `prune_sessions_endpoint` at
  `hermes_cli/web_routers/sessions.py:923` is the destructive path, already routed and profile-scoped.
  **Pinned sessions are not archivable** (mirror `exclude_pinned=True`). **`hidden` is not `archived`** — do not
  collapse the two flags. (ii) The per-user preference document (Phase I reads it): one small document behind
  the API, `{ revision, preferences: {…} }`, per-key last-write-wins, *portable preferences only*. (iii) The
  attachment route for items 8–9, **only if** Phase 0 found no way to ride the existing ones.
- **B — Settings becomes a main page.** the user, verbatim: *"Main page of section rows that open sub-pages —
  today's shape, just promoted to a top-level page."* Section rows, each opening its sub-page; reached as a
  top-level destination, not from the top bar. Notifications becomes a **sibling row under Agent Preferences**
  rather than a sixth top-bar icon. The page **must make the portable/device-local split visible** — see §5.
- **C — Groups / session grouping.** the user chose the desktop's **Groups**: user-authored sections. Create,
  file into, remove from, collapse a heading, rename, delete. Carry the desktop's rule: **deleting a group never
  deletes sessions**; its members fall back into the flat list. This is 0.7.0's parked Phase D — `PROGRESS.md`
  has the prior art, and the phone already has the shell (`sectionMenuEntries()` at `src/roster/menus.ts:65`,
  the `new-group` entry at `src/roster/plusMenu.ts:54`). Do **not** confuse this with 0.8.0's type filter: that
  hides whole *sources*, Groups are authored and hold arbitrary membership.
- **D — long-press → the per-object menu at desktop parity.** See §4 item 6 for the shape and the known gaps.
- **E — multiselect.** See §4 item 7. The desktop's semantics and the user's own edge-case rule are already
  settled; mirror them rather than re-inventing.
- **F — the chrome batch.** §4 items 1, 4, 5, 10, 11, 12 and landscape. All small, all measurable, all in one
  phase because they touch the same handful of style blocks.
- **G — attachments.** §4 item 8.
- **H — voice.** §4 item 9.
- **I — sync.** §4 item 2. The **gateway is the source of truth** — not client-to-client. The phone writes
  portable preferences through the document from Phase A; the plug-in does the same with its own reader/writer.
  **This half of the phase touches a second repo** (`~/Projects/hermes-desktop-plugins/personae`), which is
  the user's live desktop plug-in. It goes **last**, it must pass that repo's own harness before you call it done,
  and it must not change the deployed plug-in's behaviour for a user who never opens the phone app.
- **J — push notifications.** §4 item 12. Genuinely blocked end-to-end; see §6. Implement everything that does
  not need the credential, and do not let it hold the build.

## 4. The items, with acceptance

Verbatim where the user gave words.

1. **Search bar: rounded at the sides, 25% taller.** *"make the search bar rounded at the side, and increase
   it's height by 25%."* Today: `searchRow` is `height: 38`, `borderRadius: radius.sm`, square-ish
   (`src/roster/components.tsx:646-656`). → height 48 (38 × 1.25 = 47.5, and round *up* — 0.8.0's own convention
   for a fractional scale is in `src/roster/geometry.ts:33`), radius to a pill. Derive the height from one
   constant, as 0.8.0 did for the avatars, and assert the derivation in the test — not the literal.
2. **Remove the connection text from the main screen.** *"Remove the text regarding the connection."* See §5 —
   this one has a judgement in it.
3. **Remove the trailing "51 automatic…" line.** *"Remove the text at the end '51 automatic...'"* This is the
   `ListFooterComponent` at `app/index.tsx:429-442`; the exact string is
   `{t.roster.automaticCount(roster.model.automaticSeen)} · {t.roster.automaticHelp}` (`:437`), which renders
   "51 automatic runs · Runs of scheduled tasks…". Remove that line. §5 covers the neighbouring `hidden(n)`
   line.
4. **Attachments in messages, WhatsApp-shaped.** *"scope out the ability to add attachments to the messages
   (reference Whatsapp on how it can be shown in the UI)"* — scope it, then build it. WhatsApp's shape: paperclip
   at the composer's left, picker, a staging strip with per-item remove, send, then a bubble that shows a
   thumbnail (images) or a file card (name, size, type) with tap-to-open, and a caption line. Sending must go
   through an existing upload route (§2.3). **A sent attachment must be reachable by the agent on the box** —
   that is what makes it a real attachment rather than a phone-local image.
5. **Voice messages, send and receive.** *"scope out the ability to send/receive voice messages."* Send: hold to
   record, slide-to-cancel, release to send, with elapsed time and a cancel affordance — this needs the one new
   dependency from §2.6. Receive: an inbound voice note renders as an audio bubble with duration and playback
   (`expo-audio` again, or the media route the desktop already uses as its player source). Note that "receive"
   has two plausible meanings — the agent *sending* a voice note, or the phone *playing* one it received.
   **Cover both**, and if the second is impossible, say which and why in `PROGRESS.md` instead of quietly
   shipping one.
6. **Long-press → dropdown with the desktop's features for that object.** *"profile has 'new session', 'edit
   profile', etc.; Session has 'Select', 'Open', 'Session', etc."* That second example is the desktop menu's top
   level, quoted from the plug-in's own source (`plugin.js:4980-4986`, the user's ordering 2026-10-10): **Select ·
   Open · Session · Apropos · Group · Appearance · Project** — one noun per submenu, verbs inline, pickers last.
   The shape is therefore **flat verbs plus submenus**, not the phone's current single flat list. The phone today
   (`src/roster/menus.ts`): profile at `:31` (new-session, rename, colour, group, sort, copy-id, hide/unhide,
   archive-all), session at `:53` (open, rename, colour, archive, copy-id, delete), group at `:65` (rename,
   delete). **Read the per-object inventory out of `plugin.js`, not the README table** — the README says the
   table is the *shared* set and each menu offers what fits the thing clicked. Known gaps: **Apropos (beta)** and
   the **Project** submenu have no phone counterpart at all. Parity means *all* the features, on both nouns —
   the user's word was "all". List the diff you closed in the commit message.
7. **Multiselect, entered from the long-press.** *"The user can start long pressing on the row, it will show the
   options, but it will also show the selection marks for multiselection."* the user then chose **the WhatsApp
   model**: the held row ticks **immediately**, the menu opens on top of a live selection, and tapping further
   rows grows the set. Rules to carry, not re-derive:
   - Selecting is a **mode** (`plugin.js:3022-3023`): while it is on, a row stops opening and starts ticking, and
     a bar appears whose verbs act on the whole set.
   - **Emptying the set leaves the mode** (`plugin.js:3035-3038`, quoting the user 2026-10-10: *"if the user
     unselects the last item and none are selected, stop the multiselect action."*).
   - Bar verbs on the desktop: Select All, Clear, Close, Archive, Delete, Apropos.
   - **The batch resolves against what is ON SCREEN**, not the raw roster — the desktop had a real bug here
     (`plugin.js:3091-3103`: `profiles.list` carries no `sessions` array, so Select All, the counter and all five
     verbs silently did nothing). Do not re-create it.
   - One delete path: batch delete uses the same gateway verb as single-row delete, and the confirm carries the
     **count** — "Delete 7 sessions? This cannot be undone." **0.8.0's two-step confirm is load-bearing and must
     survive.** A real delete burns message history on the box, triggered from a phone.
   - My inference, unconfirmed: since the set can grow while the menu is open, show batch verbs once more than
     one row is ticked, single-object verbs when exactly one is. If you implement it differently, say so.
8. **Remove the Expand/collapse-all button from the top bar.** *"Remove the Expand/collapse all button from the
   top bar."* It is the middle of the three header glyphs (`app/index.tsx:271-291`, the one control with two
   states, `t.roster.expandAll` / `t.roster.collapseAll`, `:282`). Removing the button must not remove the
   ability — per-profile expand/collapse stays (`roster.toggleProfile`, and the row affordance at
   `components.tsx:145`). Check whether `openProfile` is still reachable, or now dead code.
9. **"+" and Settings bigger, transparent background.** *"Make the + and settings buttons bigger, but with a
   transparent background."* Today both are `styles.headerIcon`: `width: 38, height: 34`, and
   `backgroundColor: colors.panelAlt` (`app/index.tsx:746-753`) — that background is the thing to remove.
   Sizes come from `headerMetrics()` (`src/roster/geometry.ts:212`), which scales glyphs and boxes from ONE
   constant (`HEADER_ICON_SCALE = 1.1`, `:182`) — keep that property, and keep the glyph-vs-touch-target split
   documented at `:207-213`: the hit area must still meet the minimum touch target.
10. **Remove the trailing connection text.** Covered by §4.2.
11. **Landscape, not just portrait.** *"the app should also work in landscape, not just in portrait mode."*
    `app.json:6` is `"orientation": "portrait"` → allow both. Then fix what §2.5 finds. Non-negotiable checks:
    horizontal safe-area insets honoured on every screen; the sheets usable at a short height; the thread's
    composer not swallowed by the keyboard; the roster still readable (its geometry is dp-based, so it should
    be — prove it).
12. **Real push notifications.** *"set up push notifications for 0.9.0"* — notifications that arrive with the app
    killed. Blocked on a Firebase project only the user can create; see §6.

## 5. Judgement calls I made — they are yours to flip, and must be visible

These are calls, not requirements. Implement them, and list them in `PROGRESS.md` under
*"decisions taken, one line each, and how to reverse it"* so the user can veto any of them cheaply.

- **Item 2 vs the connectivity banner.** The banner's whole reason to exist is that "wrong port", "Tailscale not
  running" and "no network" all used to look like an empty list (`src/ConnectivityBanner.tsx:1-7`). So: remove
  the **routine** connection strip from the main screen, and keep the failure disclosure in the state where the
  list genuinely cannot load — otherwise 0.9.0 re-introduces the bug the banner was built to kill. If the user wants
  it gone in *all* states, that is one flag.
- **Item 3 vs the honesty line.** `app/index.tsx:433-434` prints "N automatic runs are hidden — turn automatic
  runs on in Settings." That is the 0.8.0 D disclosure and it is *not* the line the user quoted. Keep it; it is the
  difference between a filtered list and a lying one.
- **Sync scope.** *Syncs*: session types shown, notification preferences, display/ordering preferences.
  **Never syncs**: gateway URL + bearer, pairing state, device identity, OS notification permission. Syncing
  "Gateway Settings" would actively break the desktop — it dials `localhost:9119`, the phone dials the tailnet
  address, and pushing one over the other is how you lose a working desktop. Make the split **visible in the
  Settings page** (Phase B) or "Gateway Settings" reads as synced while quietly never syncing.
- **Attachments ride existing routes** rather than a new endpoint (§2.3).
- **One new dependency, for recording only** (§2.6).
- **Order**: surface → settings → groups → menus → multiselect → chrome → attachments → voice → sync → push.

## 6. The two blocked items, and the non-blocking path each must take

**Push (item 12).** Real end-to-end push needs a Firebase project that only the user can create: a project named
`personae` with Analytics off; an **Android app whose package name is exactly `com.personae.mobile`** and an iOS
app in the same project; `google-services.json` / `GoogleService-Info.plist`; a service-account key for sending;
and, for iOS later, an APNs `.p8` with its key ID and team ID. **The service-account JSON never goes in git.**
You cannot create any of that. So: implement the client registration path, the permission request and the token
handling; implement the gateway sender **behind a configuration flag that is off by default**, reading its
credential from the environment, never from a committed file. Then **ship**. In `PROGRESS.md`, state plainly
which step is blocked, what exactly is missing, and that the feature is inert until the credential exists.

**Anything in items 8–9 that needs a server-side message field.** If Phase 0 finds messages carry no attachment
representation, the smallest additive change that makes an attachment reachable by the agent wins — and note
that the TUI's `/image <path>` convention already demonstrates a message that carries a *path*. Do not build a
second upload path, and do not make the phone the only client that can read it.

**And the honest rule for both:** if something cannot be verified, it goes in `PROGRESS.md` as not-verified with
the reason. **Never** ship a feature whose UI claims something the build cannot do, and never call a
device-side notification "push".

## 7. Receipts — verified 2026-10-12, so you do not have to re-find them

Paths are relative to `~/Projects/personae-mobile` unless absolute.

| thing | where |
|---|---|
| main screen, header, footer, all styles | `app/index.tsx` — header `:252-346`, three glyphs `:258-304`, sheets `:445+`, footer `:429-442`, styles `:741+` |
| search bar | `src/roster/components.tsx:106-129`, `searchRow` `:646-656`, `searchInput` `:659` |
| header geometry | `src/roster/geometry.ts` — `HEADER_ICON_SCALE` `:182`, touch floor `:184+`, `headerMetrics()` `:212-230`, avatar math `:33` |
| long-press wiring (already exists) | `src/roster/components.tsx:189`, `:222`, `:375` all `onLongPress={props.onMenu}`; press-to-menu affordance `:154-156` |
| the phone's menus today | `src/roster/menus.ts` (profile `:31`, session `:53`, group `:65`), `src/roster/plusMenu.ts` (`new-group` `:54`) |
| actions sheet + prompt | `src/roster/components.tsx:470-520` (sheet, `maxHeight: '80%'` at `:579`), `:529-566` (prompt) |
| archive/delete verbs | `src/api/backend.ts` — dashboard calls `:224,228`, gateway `501` stubs `:427,435` |
| swipe (0.8.0 E) | `src/roster/components.tsx:304-381`, logic in `src/logic/swipe.ts` |
| connectivity | `src/ConnectivityBanner.tsx`, `src/ConnectivityContext.tsx`, i18n `:303+` |
| settings model + seam | `src/settings.ts` (one versioned key), `src/settingsLayout.ts` (areas + field order `:46-73`, wizard `:90-92`) |
| i18n | `src/i18n.ts` — EN `:55+`, PT `:599+`; both languages must be filled in for every new string |
| the "51 automatic" string | `src/i18n.ts:65` (`automaticCount`), `:66` (`automaticHelp`), `:73-76` (`hidden`) |
| package version | `app.json:5` version, `:6` orientation, `:20` versionCode |
| desktop plug-in (2nd repo) | `~/Projects/hermes-desktop-plugins/personae` — `plugin.js` (menu authoring `:4980-4986`, multiselect `:3022-3038`, the batch bug `:3091-3103`), `README.md` (menus `:148-157`, groups `:133`, delete rule `:197-203`, safety `:207-213`) |
| server prior art | `~/.hermes/hermes-agent/hermes_cli/web_routers/{sessions,files,audio}.py`, `hermes_state_sessions.py:1757`, `hermes_state_maintenance.py:274` |
| verifier convention | `logs/verify-0.8.0.sh` + `.txt` — copy the shape, bump the numbers |

## 8. Report

`PROGRESS.md` gets a `## 0.9.0` section in the same shape as 0.8.0's: what landed per phase, every test count,
the APK's path/bytes/sha256/signer, the decisions from §5 one line each, and what could not be verified with the
reason. Then stop — that is the finish line.

---
the user's own words for this batch, kept so nobody paraphrases them later:

> 1. In the main screen, make the search bar rounded at the side, and increase it's height by 25%.
> 1.1. Remove the text regarding the connection
> 1.2. Remove the text at the end "51 automatic..."
> 2. Let's scope out the ability to add attachments to the messages (reference Whatsapp on how it can be shown in the UI)
> 3. Let's scope out the ability to send/receive voice messages.
> 4. Remove the Expand/collapse all button from the top bar
> 5. Make the + and settings buttons bigger, but with a transparent background
> oh, and the app should also work in landscape, not just in portrait mode

...plus his earlier 0.9.0 list, which is in `SCOPE-0.9.0.md` beside this file: push notifications, full
desktop↔phone sync, Settings as a main page, session grouping, long-press as a user action, the per-object
menu, and multiselect. `SCOPE-0.9.0.md` also carries his two decisions (delete = delete on the gateway, archive
= archive on the gateway; Settings = section rows as a top-level page) and the answered clarifications
(session grouping = the desktop's Groups; long-press = the WhatsApp model). Read it. It is the why; this file is
the what.
