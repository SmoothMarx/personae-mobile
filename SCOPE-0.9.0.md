# SCOPE 0.9.0 — parked draft (NOT a brief yet)

**Status: collecting.** the user's words, 2026-10-12, verbatim:

> - Yes, set up push notifications for 0.9.0
> - Let's set up full sync, to avoid any future issues. The Desktop App plug-in and the Phone app should sync their preferences, settings, deletions, archives.
> - Let's make the settings menu a main page. There are currently two sub-sections (Rows): Agent Preferences (inside is the list of session types to check/uncheck; Gateway Settings (inside is everything regarding connecting to the gateway).
>
> So far, this is what 090 will contain, but I will add more as soon as I try out 080

More items will land as the user tests 0.8.0. **Nothing here is implemented, and nothing here may be
bolted onto the running 0.8.0 build.**

## Decisions taken 2026-10-12 (the user, in answer to the two questions)

1. **Delete means delete, archive means archive — on the gateway.** Verbatim: *"The actions should
   reflect what they say: If the user says delete, it should delete the session from the gateway. If
   they archive it, it should be archived in the gateway."* No client-side hiding, no tombstones of
   convenience. See Item 2 for what that costs and what already exists.
2. **Settings keeps the section-rows shape, promoted to a top-level page.** Verbatim: *"Main page of
   section rows that open sub-pages — today's shape, just promoted to a top-level page."* So: Settings
   becomes its own route/destination; the rows (Agent Preferences, Gateway Settings, Notifications…)
   open sub-pages as they do today. Flattening everything inline was **not** chosen.

---

## Item 1 — real push notifications (works with the app killed)

0.8.0 ships the honest half: device-side notifications from the app's own poll while it runs. The missing
half is a push that arrives when the app is backgrounded or closed, which needs an external sender.

**Blocking prerequisite (only the user can do it):** a Firebase project. Android push *is* FCM; there is no
route around it.

1. `console.firebase.google.com` → **Add project** (name `personae`; Google Analytics off — unused).
   Requires his Google login; nobody else touches those credentials.
2. In the project → **Add app → Android**, package name **exactly** `com.personae.mobile`.
3. Add an **iOS app** too (bundle id matching `app.json`), so the same workstream serves both platforms.
4. Download **`google-services.json`** → repo, wired via `app.json` `android.googleServicesFile`
   (iOS: `GoogleService-Info.plist`).
5. Firebase → Project settings → **Service accounts → Generate new private key** → the FCM V1
   service-account JSON. This is the *sending* credential.
6. For iOS, an **APNs key (.p8)** + key ID + team ID from the Apple Developer account.

**Transport decision: Expo's push service** (`https://exp.host/--/api/v2/push/send`) — one endpoint for
Android and iOS, no Google credential on the gateway, and the FCM V1 key lives in the EAS project instead.
Tradeoff, stated plainly: notification content transits Expo's servers. The alternative — the gateway
talking to FCM v1 directly with that service-account JSON — keeps it first-party but adds a secret and a
sender to maintain on the box, and needs a second implementation for APNs later. Revisit only if the
third-party hop becomes unacceptable.

Pieces once the credentials exist:
- app: `expo-notifications` + `getExpoPushTokenAsync({projectId})`, register the token with the gateway,
  re-register on token roll and on foreground; deep-link the tap into the thread.
- gateway: a device-token registry (token, platform, profile, last seen) and a checkpoint sender that
  reuses the *same* checkpoint detection as the app (one source of truth — never two classifiers).
- precedence: the same dedupe watermark as 0.8.0, so a push and a local notification never double-fire.

## Item 2 — full sync between the Desktop plug-in and the Phone app

Target, per the user: **preferences, settings, deletions, archives** stay consistent across both clients.

### The one design point that decides everything

**A setting is either portable or device-local, and mixing them breaks the desktop.**

| portable (sync) | device-local (NEVER sync) |
|---|---|
| session types shown (0.8.0 Phase D) | gateway URL + bearer / connection profile |
| notification prefs + per-kind switches | `personae://connect` pairing state, device identity |
| display/ordering prefs, later appearance | OS notification permission, device push token |

The desktop dials `localhost:9119`; the phone dials the tailnet address. Syncing "Gateway Settings" would
overwrite the desktop's connection with the phone's and vice versa. The 0.9.0 settings page must therefore
split the two explicitly, and the sync layer must carry only the portable class.

### Architecture: the gateway is the single source of truth

Not client-to-client. The phone is asleep most of the day and the plug-in is not always open, so a
peer-to-peer design only syncs when both are awake — and both clients *already* dial the same gateway.
So: one small per-user state document behind the API.

- shape: `{ revision, preferences:{...} }` — membership (deleted/archived) is *not* in the document
- clients **read** on foreground/resume/refresh; **write** a patch with the revision they last saw
- merge: per-key last-write-wins for the **portable** preferences only (membership is the server's — see below)
- `revision` is monotonic; a client holding a stale revision gets the merged result back, never a clobber

**Tombstones became unnecessary — because the user chose real server-side verbs.** Membership (what exists,
what is archived) is now the *server's* answer, identical for both clients, so there is nothing for a
client to resurrect and nothing to reconcile: a deleted session is absent from the next read, an archived
one comes back flagged. Tombstones are the fix for *client-side* hides, which we are explicitly not doing.
That leaves only **portable preferences** needing merge logic (per-key last-write-wins + a revision), which
is a much smaller problem than syncing membership. His choice simplified the design.

Cost, honestly: three workstreams (gateway endpoint + plug-in reader/writer + app reader/writer), and the
plug-in currently keeps its own state, so the gateway endpoint becomes the contract between them.
0.8.0 deliberately keeps every setting behind `src/settings.ts` (one versioned key, defaults + migration),
which is the seam this layer bolts onto — that is why 0.8.0 is **not** being re-scoped to pre-build it.

### What already exists server-side (measured 2026-10-12, read-only)

Good news: neither verb needs new *semantics*, because the state layer already models both.

- `sessions` in `state.db` already carries `archived INTEGER NOT NULL DEFAULT 0`, **`auto_archived`**,
  `pinned`, and `hidden`, alongside `last_read_at`. Archive is a first-class concept, not a new flag.
- `hermes_state_sessions.py:1757` — `archive_sessions(...)`; `hermes_state_maintenance.py:274` —
  `archive_stale_sessions(idle_days, exclude_pinned=True)`. So archiving is an established operation with
  an existing policy shape (and a reason `pinned` must not be archivable).
- `hermes_cli/web_routers/sessions.py:923` — `prune_sessions_endpoint` (`SessionPrune`): the **destructive**
  path, already routed and already scoped (there is a test asserting profile scope on it).
- The app's own dashboard backend already calls both: `archiveSession(id)` →
  `client.patchFlags(id, {archived:true})`, and `deleteSession(id)` → `client.deleteSession(id)`.
  **The 501 stubs live only on the gateway surface** (`src/api/backend.ts:427,435`).

So the work is **plumbing, not semantics**: route the gateway surface at the verbs that already exist and
are already exercised by the dashboard path. Concretely:

- archive → the same flags update the dashboard uses (`archived`), not a parallel write path;
- delete → the existing per-session delete, falling back to the prune route only if no single-id route exists;
- explicitly **not** archiveable: pinned sessions (mirror `exclude_pinned=True`), and say so in the UI
  rather than failing silently;
- `hidden` vs `archived` stays a distinction the *plugin* owns — do not collapse them into one flag.

**Risk, flagged once:** this is now a genuinely irreversible path. A real delete destroys the session's
message history on the box, and the trigger is a swipe on a phone. 0.8.0's two-step confirm is the
mitigation and it must survive into 0.9.0 unchanged. Second-order risk: any change to the gateway surface
is a change to the Hermes install, so it must land as a small self-contained patch, or `hermes update`
will clobber it.

## Item 3 — Settings as a main page

Current: Settings is entered from the top bar and its entries are rows that open sub-pages —
**Agent Preferences** (session types to check/uncheck) and **Gateway Settings** (everything about reaching
the gateway).

Asked for: Settings *is* a main page.

Layout — **decided**: main page of section rows, each opening its sub-page (today's shape), with Settings
promoted to a top-level destination instead of something reached from the top bar. Concretely: Settings
becomes its own route; the row list holds **Agent Preferences** (session types; Notifications joins it as
a sibling row, not a sixth top-bar button), **Gateway Settings** (connection: pairing, Tailscale, device
picker, bearer), and whatever else accumulates — each still opening the sub-page it opens today.

Note the interaction with Item 2 above: the page must make the portable/device-local split visible, or
"Gateway Settings" will read like a synced section and quietly not be.

Constraint from Item 2: whatever the shape, the portable/device-local split above must be visible on the
page, or the sync layer will look like it is losing settings.

---

## Item 4 — Session grouping

the user, 2026-10-12: *"session grouping. let me know if you need any clarifications on that."*

**ANSWERED 2026-10-12 — the user chose:** the desktop's **Groups**, finished on the phone — user-authored sections:
file a session into one, collapse a heading, rename/delete the group. That is 0.7.0's parked Phase D at parity
with the desktop. Automatic grouping (by profile / by type / by recency) was offered and **not** chosen — do not
build it. Scope therefore is: create a group, file into it, remove from it, collapse a heading, rename, delete —
carrying the desktop's delete rule (`README.md:197-203`): **deleting a group never deletes sessions**; its
members fall back into the flat list.

Prior art, and the reason this is not a blank sheet: this is **0.7.0's parked Phase D**, named in `PROGRESS.md`,
and the desktop plug-in ships it today as **Groups** (`README.md:133 "🗂️ Groups"`). The mobile already has the
shell of it — `sectionMenuEntries()` in `src/roster/menus.ts:65` (rename/delete a group) and a `new-group` entry
in `src/roster/plusMenu.ts:54` — so what is missing is the *grouping* itself rather than the noun.

**Do not confuse this with the 0.8.0 type filter.** That hides or shows whole *sources* (conversations, cron,
webhooks). Groups are authored by the user and hold arbitrary membership.

## Item 5 — Long-press is a user action

the user, 2026-10-12: press-and-hold as a first-class gesture.

**This already exists on the phone** — so this item is an upgrade of established behaviour, not new plumbing:
`src/roster/components.tsx:189`, `:222`, `:375` all wire `onLongPress={props.onMenu}`, and the menus behind it
are `src/roster/menus.ts` (the "R8" menus, whose own header comment calls them *"mobile's answer to the
plugin's right-click"*). Likewise `:154-156` shows a press-to-menu affordance beside `canManage`. Nothing here
needs a new gesture recogniser; it needs the *menu* and the *mode* behind it to reach parity (Items 6 and 7).

## Item 6 — Long-press opens the desktop's per-object menu (full parity)

the user, 2026-10-12: *"provide a dropdown pop-up with all the features you have in the desktop version
corresponding to that object (profile has 'new session', 'edit profile', etc.; Session has 'Select', 'Open',
'Session', etc.)"*.

His second example is the desktop menu's top level quoted almost verbatim. From the plug-in's own source
(`~/Projects/hermes-desktop-plugins/personae/plugin.js:4980-4986`) — the user's ordering, 2026-10-10:

> ONE NOUN PER SUBMENU, one verb inline, and the two pickers last. Top level reads as a table of contents:
> **Select · Open · Session · Apropos · Group · Appearance · Project.**

So the shape is **flat list of verbs → submenus, one noun each**, not the phone's current single flat list.
Shared inventory of desktop verbs (`README.md:148-157`): Open, Rename…, Colour, File into a group, Sort,
Copy id, Apropos (On that topic, beta), Delete. The README notes the table is the *shared* set and each menu
offers what fits the thing clicked, so **the per-object diff must be read out of `plugin.js`, not the table.**

What the phone has today (`src/roster/menus.ts`), for the diff:

- profile (`:31`): new-session, rename, colour, group, sort, copy-id, hide/unhide, + archive-all (destructive)
- session (`:53`): open, rename, colour, archive, copy-id, delete (destructive — the only irreversible verb)
- group (`:65`): rename, delete

Gaps visible without further reading: **Apropos (beta)** and the **Project** submenu have no mobile counterpart
at all, and the submenu *structure* is newer than the phone's flat list. The descriptor line to preserve
per the user's instruction is parity — "all the features", on both nouns.

## Item 7 — Multi-select, entered from the long-press

the user, 2026-10-12: *"The user can start long pressing on the row, it will show the options, but it will also
show the selection marks for multiselection."* So the menu and the tick marks appear **together** — the menu
does not have to be dismissed to tick a second row.

**ANSWERED 2026-10-12 — the WhatsApp model:** the held row ticks **immediately**; the menu opens on top of a
live selection, and tapping further rows grows the set. So the desktop's "selecting is a mode you *enter*" is
not the phone's gesture — keep the mode, change the entry point. **Inferred, not confirmed:** since the set can
grow while the menu is still open, the menu should show the batch verbs once more than one row is ticked and the
single-object verbs when exactly one is (the desktop's shared-verbs rule, `README.md:145-146`).

The desktop already settled the semantics, and the user already ruled on its edge case. Mirror it exactly rather
than re-inventing:

- **Selecting is a MODE, not a modifier key** (`plugin.js:3022-3023`): while it is on, a session row stops
  opening and starts ticking, and a bar appears whose verbs act on the whole set.
- **Emptying the set leaves the mode** — `plugin.js:3035-3038`, quoting the user 2026-10-10: *"if the user
  unselects the last item and none are selected, stop the multiselect action."* A mode with nothing ticked has
  nothing to act on, and its bar would only read "0 selected".
- **Selection bar verbs** (desktop): Select All, Clear, Close, Archive, Delete, Apropos. On the phone the same
  list, minus anything that cannot work, plus visible reasons rather than silent absences.
- **The batch resolves against what is ON SCREEN**, not the raw roster — the desktop had a real bug here
  (`plugin.js:3091-3103`: `profiles.list` carries no `sessions` array, so Select All, the counter and all five
  verbs silently failed). Do not re-create it: tick-state must derive from the rendered rows.
- Archive/delete in a batch go through the same gateway verbs as the single-row case — **one delete path**.
- Interaction with Item 2's decision: a batch delete is real and irreversible, so the confirm must carry the
  **count** ("Delete 7 sessions? This cannot be undone."), and 0.8.0's two-step confirm shape must survive.

---

## Items 8–15 — the second batch (2026-10-12)

All of Items 4–15 are now briefed in `GOAL-0.9.0.md`, which is the **build contract**; this file remains the
*why*. Verbatim, as given:

> 1. In the main screen, make the search bar rounded at the side, and increase it's height by 25%.
> 1.1. Remove the text regarding the connection
> 1.2. Remove the text at the end "51 automatic..."
> 2. Let's scope out the ability to add attachments to the messages (reference Whatsapp on how it can be shown in the UI)
> 3. Let's scope out the ability to send/receive voice messages.
> 4. Remove the Expand/collapse all button from the top bar
> 5. Make the + and settings buttons bigger, but with a transparent background
> oh, and the app should also work in landscape, not just in portrait mode

- **Item 8 — search bar**: rounded at the sides, 25% taller. Today `searchRow` is `height: 38`,
  `borderRadius: radius.sm` (`src/roster/components.tsx:646-656`) → 48, pill.
- **Item 9 — the connection text** on the main screen (the `ConnectivityBanner`). See the judgement note in
  `GOAL-0.9.0.md` §5: the routine strip goes, the failure disclosure stays, or 0.9.0 re-introduces the
  "empty list vs broken" bug the banner was built to kill.
- **Item 10 — the trailing "51 automatic…" line**: `app/index.tsx:437`,
  `{t.roster.automaticCount(...)} · {t.roster.automaticHelp}`, in the `ListFooterComponent` at `:429-442`.
  The neighbouring `hidden(n)` honesty line (`:433-434`) is *not* the line he quoted — keep it.
- **Item 11 — attachments**, WhatsApp-shaped UI. Server routes already exist (`/api/files/upload-stream`,
  `/api/chat/image-upload`, media serving) — reuse, do not add a parallel path.
- **Item 12 — voice messages**, send and receive. Needs the one new dependency (a recorder). "Receive" has two
  readings — the agent sending a voice note, and the phone playing one — cover both or say which is impossible.
- **Item 13 — remove Expand/collapse-all** from the top bar (`app/index.tsx:271-291`). The per-profile
  expand/collapse stays.
- **Item 14 — "+" and Settings bigger, transparent background**: sizes come from `headerMetrics()`
  (`src/roster/geometry.ts:212`); the thing to delete is `backgroundColor: colors.panelAlt`
  (`app/index.tsx:750`).
- **Item 15 — landscape.** `app.json:6` is `"orientation": "portrait"`. Static audit only: **there is no `adb`
  on either host**, so this cannot be device-verified.

Relationship to the earlier items: Item 3 (Settings as a main page) and Items 4–7 (grouping, long-press, the
per-object menu, multiselect) are unchanged. Three of them — delete/archive, grouping, and full sync — are
blocked on the same missing piece, the **gateway owning the roster's mutable state**, so the server surface is
Phase A and the UI rides it.

## Do not

- Do not start any of this in the 0.8.0 run.
- Do not touch Phase D of 0.7.0 (session groups) — still parked, still named in `PROGRESS.md`.
- Do not add a Firebase credential to the repo or the gateway until the user has produced it and said where
  it should live. `google-services.json` is not a secret in the API-key sense, but the service-account
  JSON is: it never lands in git.
