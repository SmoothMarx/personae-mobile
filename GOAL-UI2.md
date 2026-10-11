# GOAL — Personae Mobile 0.5.0: the roster becomes the plugin's roster

**Owner:** cody · **Repo:** `~/Projects/personae-mobile`
**Reference of record (the thing to be faithful TO):** `~/Projects/hermes-desktop-plugins/personae/`
— read `README.md` (the capability table) and `plugin.js` (8 365 lines: the rail, `searchInSessions`,
`SECTIONS_KEY`, `PROFILE_SWATCHES`, the status lights, `messenger-expanded-v1`). **This file wins on
scope; the plugin wins on behaviour.**
Plus `PLAN-UI.md` REV 5 for transport/auth facts and `PROGRESS.md` for what 0.4.0 already shipped.

Deliverable: **`dist/personae-0.5.0.apk`** — `versionName 0.5.0`, `versionCode 5`, same Personae
release keystore (installs over 0.4.0), with F5–F7 fixed and **no regression of F1–F4**.

---

## §0 — Why this goal exists (the defect, with evidence taken from the live box today)

0.4.0 fixed four defects *inside the wrong shape*. The main view is a **flat session feed with a
horizontal profile-chip scroller**; the plugin's main view is a **vertical roster of profiles that
expand in place into their sessions**, with a search bar, named groups, status lights and colour that
fills. the user's screenshot (`Screenshot_20261011-142809.png`) shows the consequence: one `Principal`
pill, and a list of **cron-job runs** — no profiles, no expansion, no search, no groups.

Verified against the live dashboard with the app's own credential (`HERMES_PERSONAE_BEARER`):

| Probe | Result |
|---|---|
| `GET /api/profiles` | **200 · 22 profiles**; keys incl. `display_name, name, model, provider, gateway_running, role, skill_count, has_avatar` (**`has_avatar` is `null` for all 22** — hence the background avatar probe) |
| `GET /api/profiles/sessions?limit=8` (what the app calls) | **200 · `total: 1771`** — and the page mixes `source` values: `desktop`, `api_server`, `cli`, **`cron`** (`'Scholes - Daily School Digest · Oct 11 05:31'`, `'Dobbs - Birthday Briefing · Oct 11 06:03'`) |
| `GET /api/profiles/sessions/sidebar` | **200**; slices `recents` (22) / `cron` (5) / `messaging` (22) / `errors` / `storage` — **`recents` is the plugin's feed and it contains no cron runs** |
| `GET /api/plugins/messenger/search?q=&profile=&limit=` | **200** `{profile, query, results:[{session_id, role, snippet}]}` — message-body FTS, no new server work needed |
| Unauth `GET /api/profiles` | **401** (the gate is intact; the bearer is the app credential, `~/.hermes/.env`, provider at `~/.hermes/plugins/personae-mobile-auth/`) |
| `limit` semantics | **per profile, not a global cap** — `limit=8` returned 25 rows. Do not assume; measure. |

Facts about the screenshot worth not re-litigating: `toMillis`/`formatAge` (`src/format.ts:38-66`) are
**correct** (epoch-seconds heuristic, DD-MM-YYYY). The ages are real data. And the one-pill rail is the
silent fallback, see F7.

## §1 — F5: the roster is the plugin's roster (the main work)

Re-shape `app/index.tsx` (split it — it is 627 lines and about to grow):

- **R1 vertical accordion, not chips.** One row per profile: **face** (28–40 px circle, `has_avatar`
  is unreliable → probe in the background, monogram until it lands, never block the paint) + **name** +
  **preview of its latest session** + **age** + **status light** + **unread count**. Delete the
  horizontal chip scroller.
- **R2 expand in place.** Tapping a profile row expands **its sessions** underneath it (dot, title,
  preview, age), newest first. Tapping a session opens `/thread/[id]`. Expansion is a **per-profile
  set** (`messenger-expanded-v1` semantics — several may be open), persisted.
- **R3 the feed is `recents`, never cron.** Cron-run sessions (`source === 'cron'`) must not appear in
  the roster feed. Prefer the sidebar `recents` slice; if you use `/api/profiles/sessions`, filter
  `source !== 'cron'` and prove it with a test. Cron runs stay reachable — show them **under their own
  profile, marked as automatic runs**, never as the main list. This is F6.
- **R4 groups (the plugin's "sections").** Named groups with collapsible headers, exactly the plugin's
  shape: `{sections:[{id,name}], members:{profile:sectionId}, collapsed:[], order:{}, sort:{}}` — same
  keys so the later sync (P11, out of scope) maps 1:1. Ungrouped profiles render in an implicit
  section. Create/rename/delete a group; assign a profile to one; **deleting a group never deletes
  sessions** (honest deletes). "An empty group explains how to fill it", as the plugin does.
- **R5 search bar.** Filters **profiles *and* sessions**: the metadata sweep (title/preview/profile) plus
  server-side FTS via `GET /api/plugins/messenger/search?q=&profile=&limit=`. A hit inside a profile
  must **auto-expand that profile and show the matching sessions under it** — that is the plugin's rule.
  Debounced, cancellable, and it must not fire 22 requests per keystroke.
- **R6 colour that fills.** Profile colour tints its profile row and every session under it; a session
  colour overrides its profile's. Coalesce whatever the surface exposes (a thin alias like
  `coloursFor(profile)` is fine) and **tolerate its absence** — never invent a hue, never crash.
- **R7 status lights.** Amber = waiting on you, emerald = unread, neutral = nothing, **numbered at 2+** —
  from `unread` / `last_read_at`; keep the app's `lastSeen` watermark for "new since my last visit".
- **R8 long-press menus** (mobile's right-click): profile → new session, rename, colour, hide/unhide,
  archive all; session → open, rename, archive, delete, colour. Icons + labels, PT-PT labels.
- **R9 scale.** 22 profiles and 1771 sessions: `FlatList`-style virtualisation, per-profile lazy load
  (**the rail's `limit` is per profile** — measure, then paginate per profile or fetch the sidebar
  slices once), and no 22 parallel avatar fetches stalling the first paint.

## §2 — F7: stop lying when the surface is wrong

`app/index.tsx:113` (and its siblings) swallow a failed profile list and fall back to
`contactsOf(settings)` — a **single synthetic `Principal` contact**. That is what the screenshot shows,
and it is worse than an error, because the user cannot tell "no profiles" from "not connected". Also
`src/logic/roster.ts:32-34` still asserts *"The server exposes no /api/profiles route"* — that is stale,
`/api/profiles` returns 22.

Required: a failed `/api/profiles` on a surface that has profiles renders the **connectivity banner with
the real error** (reuse `ConnectivityBanner` + the export log), never a fabricated one-contact roster;
the stale comment goes; and the connection surface names the one thing a user must set —
`Tipo de ligação = Dashboard (:9119)` + the bearer — with the check result next to it. If the app is on
the `:9222` api_server surface (which has no `/api/profiles`), say so **in the UI**, since that is
exactly the state a 0.4.0 upgrade lands in (its stored credential is the old `:9222` key).

## §3 — Don't break what 0.4.0 fixed

F1 avatars · F2 Ionicons (glyphs must survive the **release** bundle — the font footgun is real) ·
F3 `Ver detalhes` expands one run at a time with real tool args/results and a `Pensamento` block ·
F4 the top bar shows the session **name**. All four keep working, with their tests.

## §4 — Out of scope (do not start, do not half-start)

Multi-select · Apropos · iOS/EAS · the gateway-side state store / layout sync (**P11 — but keep every
roster preference behind one module, e.g. `src/rosterPrefs.ts`, so the server store can replace the
backing later without touching the screens**) · export/import of the layout · right-click parity.

## §5 — Acceptance (each line needs the command or test that shows it)

1. `dist/personae-0.5.0.apk` exists; `versionName 0.5.0`, `versionCode 5`, **release**-signed with the
   Personae key; `logs/verify-apk.sh` + `verify-dex.sh` summaries pasted into `PROGRESS.md`.
2. `npm test` ≥ **93 passing, 0 failing** (the 0.4.0 floor) and `tsc --noEmit` clean, on the final commit.
3. Tests, offline on `mock/`, that pin: cron runs absent from the roster feed; a profile failing to load
   produces the banner and **no** fabricated contact; expansion is per-profile; search auto-expands a
   matching profile; a deleted group deletes no session; group shapes round-trip (`sections/members/
   collapsed/order/sort`).
4. Evidence file `logs/roster-<date>.txt` with the real endpoint responses you built against (status,
   counts, one sample row per source) — no secrets, no bearer.
5. One commit per phase, `PROGRESS.md` current, and an honest list of what is still not pixel-verified
   (there is still no adb and the Pixel 8 is offline — do **not** claim a device test you did not run;
   emit the install + check list for the user instead).

## §6 — NOT DONE IF

- The main view is still a flat feed, or a chip scroller survives as the primary roster.
- Cron runs are still in the roster feed.
- Tapping a profile does not expand its sessions in place.
- Search matches sessions but does not reveal them under their profile.
- A profile list that fails still shows one invented `Principal` contact.
- Any of F1–F4 regressed, or the test count dropped below 93.
- A secret reached a file, a commit, a log tail, or the repo.

## §7 — Rules of engagement

Long run; phased commits; `PROGRESS.md` current; prefer a verified small step over a large unverified
one. Do not touch `:9222`, the Funnel, or any other service. The dashboard's bearer and the provider are
already installed and working — **nothing host-level needs changing this run**; if you believe it does,
stop and say so rather than mutating a unit. Offline-testable first: every behaviour gets its `mock/`
route and its test before it needs the live box. If you are blocked more than ~30 minutes, record it in
`PROGRESS.md` and move on.
