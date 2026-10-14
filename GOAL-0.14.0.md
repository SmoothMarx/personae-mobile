# GOAL-0.14.0 — the second message survives, the roster row stops appearing twice, and opening a box stops yanking the thread to the bottom

**This is the brief.** There is **no `DESIGN-0.14.0.md`**: `DESIGN-0.13.0.md` remains the authority for
anything it already locked, and the three decisions this release needs are written out inline below
(§3.2, §4.2, §5.2). If anything in this brief contradicts `DESIGN-0.13.0.md`, **stop and report the
conflict** instead of improvising.

**Batch:** one release, one build, three workstreams. Each workstream must be revertable **alone** —
none may depend on a fix that lands in another. No new dependency gets added for any of the three.

**Baseline:** the user's Pixel 8 runs `0.13.0` / `versionCode` **16** (`app.json:5`, `app.json:22`
`[verified]` — read today). `npm test` on this tree is **316/316 passed, 0 failed** (`[verified]`, run
today) — that is the number you must not go below.

**Target:** `version` **0.14.0** (`app.json:5`) / `versionCode` **17** (`app.json:22`). There is no
`versionName` key; do not add one.

**Sign with the same release key as 0.13.0** — `~/.personae-android/personae-release.keystore`
(`README.md:62` `[verified]`). The upgrade must install straight over the shipped build with nothing for
the user to re-enter. If the fingerprint is not the same key, **stop and report it**; do not ship a build
the user has to uninstall first.

**Build it through the documented lane, never a bare host `gradlew`.** `README.md:52-60` builds in the
`personae-android:1` image with `--env-file ~/.personae-android/build.env`, and that file is the only
source of `PERSONAE_STORE_FILE` / `PERSONAE_STORE_PASSWORD` / `PERSONAE_KEY_ALIAS` /
`PERSONAE_KEY_PASSWORD` (`android/app/build.gradle:111-116`). With those unset, `build.gradle:127-133`
**silently falls back to the debug key** with one warning line — an APK that cannot install over 0.13.0.
If the build output does not show the release signing configuration in use, **stop and report it**
rather than shipping the artifact.

---

## §0 — How to read this brief

Anchors are marked:

- **`[verified]`** — the line was read directly in this repository today. Its number is quotable.
- **`[~]`** — a **region marker**, not a quotable line number. Find the line; report what you found.
- **`[UNVERIFIED]`** — not read. Collected in **§10**. Invent nothing; report what you find.

Every acceptance criterion is **mechanical**: a command with expected output, or an exact user-visible
string. "Works correctly" is not a criterion and will be rejected. If a criterion cannot be satisfied as
written, **report that** — do not quietly satisfy a nearby one.

---

## §1 — The three workstreams, in order

The user listed them: doubled rows, then the `4001`, then the scroll yank. **I am reordering, and the
reason is severity, not preference:** the `4001` makes the app unusable for any conversation longer than
one turn, so it goes first; the doubled row is a wrong list, so it goes second; the scroll yank is an
annoyance you can work around, so it goes last.

| # | Workstream | One line |
|---|-----------|----------|
| **W1** | The second message must not 4001 | Two halves are missing. The text path has no liveness step at all, and **no** path adopts the new runtime lease `session.resume` returns — so the retry, and every send after it, goes out on an id the gateway has already replaced. One discriminator, one resume, and the lease it hands back is what every session-scoped RPC sends. |
| **W2** | One session, one row | The feed concatenates the recents slice with the lazily-loaded profile page and never dedupes by id; pull-to-refresh "fixes" it by silently dropping the page. Fix the merge, then make refresh mean *fresh*, not *less*. |
| **W3** | Opening a box stops scrolling the thread | `onContentSizeChange` scrolls to the end unconditionally. Make the scroll intent explicit: only a newly appended turn, and only when the reader is already pinned to the bottom. |

---

## §2 — Files you will touch

| File | Why | Status |
|------|-----|--------|
| `src/api/backend.ts` | W1: `isColdSessionRpc` (`[verified]` `:365-366`), `attachRpc`'s resume-once/retry-once (`[verified]` `:462-492`, resume at `:485`), the text path's `prompt.submit` (`[verified]` `:772`) — no liveness; `watchSession`'s `activate` branches (`[verified]` `4007` at `:901`, `4009` at `:909`, no `4001`) — and the **discarded resume result** at `:484-489` (`attachRpc`) and `:903` (`activate`): both throw away the `session_id` the resume returns | W1 |
| `src/logic/rosterFeed.ts` | W2: the merge (`[verified]` `:503-504` — no dedupe), `rowsForProfile` (`[verified]` `:536`), `sessionRowModels` (`[verified]` `:589`), `FeedSession` (`[verified]` `:33`) | W2 |
| `src/roster/useRoster.ts` | W2: `LAZY_PAGE` (`[verified]` `:99`), `loaded` (`[verified]` `:115`), the row key (`[verified]` `:427`), `openProfile`'s guard (`[verified]` `:452-463`), `refresh` (`[verified]` `:473-476`) | W2 |
| `app/thread/[id].tsx` | W1: `send` (`[verified]` `:874-899`, `setDraft('')` at `:882`) — the draft is destroyed before the turn is known to have landed. W3: the `FlatList` wiring (`[verified]` `:1113-1131`), `listRef` (`[verified]` `:243`) | W1 + W3 |
| `src/logic/scrollPin.ts` *(new)* | W3: the pin decision as a pure function, so it is testable without a device | W3 |
| `tests/` (your harness) | W1 + W2 + W3: new checks, named `0.14.0 W1: …` etc. | all |
| `app.json` | version/versionCode bump (`[verified]` `:5`, `:22`) | build |

---

## §3 — W1: the second message must not 4001

### §3.1 — What is actually broken

**Verified:** the cold-session policy exists, is written down as a rule, and is applied to **one** call
site.

- `src/api/backend.ts:365-366` `[verified]` — `isColdSessionRpc` is the discriminator: a `4001` /
  `session not found` means *the gateway's registry does not hold this session*, as opposed to auth
  (`4007`/`4009`, which mean *this credential may not*). The distinction is correct and stays.
- `src/api/backend.ts:462-492` `[verified]` — `attachRpc` implements the policy: on the first cold
  answer, `session.resume` **once** (`:485`), retry the same RPC **once** (`:492`), then stop. The
  comment above it literally calls the asymmetry the bug — "the missing half" — and then the missing
  half was never written.
- `src/api/backend.ts:772` `[verified]` — the **text path** calls `prompt.submit` through the live
  socket with **no** cold handling at all.
- `src/api/backend.ts:901`, `:909` `[verified]` — `watchSession`'s `activate` handles `4007` and `4009`
  and has **no `4001` branch**: a cold session on the watcher path falls through to `onUnavailable`,
  which is exactly the state the user then sends into.

So: **the registry is the discriminator, and one of the three session-scoped entry points does not ask
it.** That is the first half of the defect.

**Second half, verified in the gateway's own source today — and it is why 0.13.0's liveness step fired
and still did not help.** The gateway resolves every session-scoped RPC out of an **in-memory** map keyed
by the **runtime id the client sends**:

- `server.py:1228-1244` `_sess_nowait` — `_sessions.get(params["session_id"])`; a miss is
  `4001 session not found`, and the log line above it states the contract outright: *(detached/reaped
  runtime; client should resume the stored session)*. `prompt.submit` gates on it too
  (`methods_prompt.py:758` — `session, err = _sess_nowait(params, rid)`), so **no** RPC, submit included,
  can warm a session the gateway does not already hold.
- `methods_session.py:1049` `session.resume` is the only thing that mints a resident session — and it
  mints a **new** one: `sid, source, cwd = ctx.mint()` (`:974` cold, `:991` eager, `:947` deferred), and
  `_resume_response` (`:894-905`) answers `{"session_id": <the NEW runtime sid>, "resumed": <the stored
  key you passed>, "session_key": <that same stored key>, …}`. The reuse-live fast path (`:876-893`) is
  the same shape: `session_id` is the **live** sid, `resumed` is the stored key.

A resume therefore hands the client a **new lease**, and the old one is dead. Both current call sites
throw that answer away: `attachRpc` resumes at `:485` and retries with the **unchanged** `params`
(`:492`), and `activate`'s `4007` branch resumes at `:903` and returns without reading the result. That
is the `reject → resume → reject` in 0.13.0's own gateway log, explained: **the resume worked, and the
retry went back out on the id the gateway had just replaced.**

**What is expected of the fix** — two rules, each with one home:

1. **The registry is the only discriminator, on every session-scoped entry point.** On the first `4001`
   for `prompt.submit`, an attach RPC, or `session.activate`: resume the **stored** id once, retry that
   RPC once, then stop. Nothing non-cold is ever retried.
2. **A resume returns a lease, and the lease is what callers send.** The `session_id` in the resume
   result is adopted and re-used — by the retry, by every later RPC for that session, and by whatever
   the screen holds for it. A session thus has **two** identities and they are not interchangeable: the
   **stored key** (what the roster lists, what the route carries, what `resume` is called with — returned
   as `session_key`/`resumed`) and the **runtime lease** (the `session_id` argument of every
   session-scoped RPC). The stored key is durable; the lease is replaced on every resume.

If a resumed session still answers `4001` on the retry *using the returned lease*, that is a different
bug — report it; do not work around it.

**`[UNVERIFIED]` — do not assert it:** *why* the session is cold by the second message. The orphan-reap
grace is 20 s (`server.py:143` — `_WS_ORPHAN_REAP_GRACE_S = 20.0`): a detached WS session is parked for a
quick reattach, then reaped. That is a plausible trigger for a phone that backgrounds or drops its socket
between turns — and it is a **hypothesis**, not a measurement. §9 says how to capture the wire evidence;
§10 is where it is parked. Do not write an unmeasured mechanism into a code comment.

### §3.2 — The change

1. **One liveness step, one home — and it yields the lease.** A single helper — call it
   `withColdSession` — that takes the RPC call, consults `isColdSessionRpc`, and on a cold answer
   performs exactly one `session.resume` and exactly one retry. `attachRpc` is refactored onto it
   (`[verified]` `:462-492`; **its observable sequence changes**: the retry must carry the lease the
   resume returned), `prompt.submit` (`:772`) goes through it, and `activate` gains `4001` handling as a
   third branch next to `4007`/`4009` (`:901`, `:909`).
2. **The lease is adopted, in one place, and re-used.** The helper reads `session_id` out of the resume
   result and puts it where the session's live identity lives — one named holder, that holder's only
   writer — so the retry **and every later send for that session** go out on it, while the stored key
   keeps its own role (route, roster, the `resume` argument). If the retry re-uses the old id, this
   workstream has not touched the defect: `attachRpc`'s current shape is the bug, not the template.
   Adopt it **unconditionally** — do not skip adoption when the returned id equals the old one; the
   reuse-live fast path returns a live sid that is still not the stored key.
3. **One resume in flight per stored key.** Three call sites can now be cold at once (the watcher's
   `activate`, a `prompt.submit`, an attach). Concurrent `session.resume`s for the same session are a
   hazard, not a retry budget: guard the resume so a second caller **awaits the in-flight one** and
   receives the same lease. Single-flight map keyed by the stored key, cleared when the resume settles.
4. **The retry budget does not grow.** One resume, one retry, per RPC. A second cold answer
   propagates — never a loop, never a third attempt. Nothing non-cold is retried.
5. **The failure must be readable — and the user's text must survive it.** In
   `app/thread/[id].tsx`'s `send`, `setDraft('')` currently runs at `:882` — *before* the turn is known
   to have landed. On a failed turn the typed text is gone and only a note remains. Move the clear to
   the success branch, next to `setStaged([])` (`[verified]` `:888-890`): **the composer is cleared on
   success only** — the same rule the staged attachments already follow. A failed second message leaves
   the user's sentence in the box and the real reason in the note.

### §3.3 — Acceptance criteria for W1

1. **The wire order is exact, and the retry carries the lease.** A new harness check with a fake socket
   whose first `prompt.submit` answers `{code: 4001}` and whose `session.resume` returns a **different**
   `session_id` than the one it was called with — a **minting** resume, the real gateway's shape
   (`methods_session.py:894-905`): the RPC log is exactly `prompt.submit` → `session.resume` →
   `prompt.submit`, **three** calls, no fourth, and the third call's `session_id` is the **returned** one.
   **This check must fail against today's tree** (today the third call re-uses the old id) — run it before
   the fix and paste both runs in the close-out.
2. **The next send re-uses the adopted lease.** After that sequence, a **second** `prompt.submit` for the
   same session goes out on the returned id with **no** further `session.resume`. That is the user's
   "second message" as a check.
3. **A second cold answer stops.** If the retried `prompt.submit` answers `4001` again, the caller gets
   an error with status `4001` and the RPC log has **no fourth call** and **no second resume**.
4. **Nothing else is retried.** With a non-cold failure (the `4007`/`4009` shapes already in the tree),
   the RPC log is exactly **one** call and no `session.resume`.
5. **One resume, three callers.** Two cold RPCs for the same session id, started together, produce
   exactly **one** `session.resume` on the wire — and both callers continue on the lease it returned.
6. **`activate` asks the registry.** A `4001` on `activate` attempts exactly one `session.resume`
   (behaviour check on the fake socket, plus a source assertion that `activate` no longer has only the
   `4007`/`4009` branches); the `4007` branch's resume (`:903`) likewise feeds the adopted lease forward
   instead of discarding it.
7. **The draft survives a failed turn.** Render-level check: type text, submit with a socket that
   answers `4001` twice, and the composer still holds the text while the note holds the provider's
   sentence. (The 0.13.0 W1 checks already assert on the note's single writer — extend that style, do
   not add a second writer.)
8. `npm test` ≥ 316 passing, 0 failing, and every pre-existing check about the attach retry
   (`0.13.0 W2`) still passes **unchanged** — if you had to edit one of those, say so loudly in the
   close-out.

---

## §4 — W2: one session, one row

### §4.1 — What is actually broken

**The doubled row.** `src/logic/rosterFeed.ts:503-504` `[verified]`:

```ts
const merged: FeedSession[] = [...input.sessions];
for (const list of Object.values(input.loaded ?? {})) merged.push(...list);
```

`input.sessions` is the recents slice (global recent sessions — for a busy profile it **already contains
that profile's newest sessions**), and `input.loaded[profile]` is the profile's own page fetched when the
row is opened (`useRoster.ts:452-463` `[verified]`, `LAZY_PAGE = 25` at `:99`). The two overlap by
construction. Nothing dedupes by id, so `all` for that profile holds each of those sessions **twice**,
and `rowsForProfile` (`:536` `[verified]`) draws `all.slice(0, perProfile)` — twice each. The rows are
keyed `session:${session.profile}:${session.id}` (`useRoster.ts:427` `[verified]`), so the duplicate is
not just visually doubled: it is **two entries with the same React key**.

**Why pull-to-refresh "removes" them.** `useRoster.ts:473-476` `[verified]`:

```ts
const refresh = useCallback(async () => {
  setLoaded({});
  await loadAll({ silent: true });
}, [loadAll]);
```

It **drops the lazily-loaded page** (`loaded`, `:115`) and never refetches it: `openProfile`'s guard
(`:453-457`) is `if (!opening || loaded[name] || !backend.hasProfiles) return;` — with no `loaded[name]`
to trip on, but also no `opening` transition (the row is *already* expanded), **nothing fetches**. The
profile keeps rendering, now from the recents slice alone, so the duplicates are gone and the page's
other rows are gone with them — until the user collapses and re-expands, which refetches.

So the user's "workaround" is data loss, and it is the second half of this workstream: **if you dedupe
the merge without fixing refresh, the user's tell ("refresh fixes it") turns into "refresh empties my
profile row"** — a worse bug with the same root.

### §4.2 — The change

1. **The merge is the only writer of the feed, and it dedupes by id.** `buildRoster`'s merge produces a
   list that is unique by session id, keeping the **first** occurrence's position (the recents order is
   the more recent one; a session already placed by recents does not move down just because a page also
   lists it). Do this **at the merge**, not in `rowsForProfile`/`sessionRowModels`: one place decides
   what a session is, the same way `NON_CONVERSATION_SOURCES` decides what a conversation is. A row
   builder that silently de-dupes would leave the search path (`:545` `[verified]` — the `some(...)`
   guard is a different thing) free to disagree.
2. **Refresh re-fetches the pages it dropped.** `refresh` clears `loaded` **and** re-fetches the page for
   every currently-expanded profile, so a profile row that is open before the pull is open with a full
   page after it. One helper decides which pages are needed (`expanded` ∩ `loaded`-invalidated), and
   `refresh` awaits them alongside `loadAll`. Keep `openProfile`'s lazy-on-open behaviour exactly as it
   is — this is not a refetch-everything rewrite.
3. **Do not "fix" the duplicate by keeping the user's data out of the list.** No cap changes, no hiding
   `loaded` rows, no key rewriting that papers over the double (`LAZY_PAGE`/`perProfile` stay as they
   are). If the count of unique sessions exceeds the display cap, that is the cap working — the
   criterion is *no duplicate*.

### §4.3 — Acceptance criteria for W2

1. **A duplicated session draws once.** New harness check: `buildRoster` with the same session id
   present in `sessions` **and** in `loaded[profile]` yields a profile block whose drawn rows contain
   that id exactly **once**, and whose total row count equals the number of **unique** ids.
2. **Row keys are unique.** For that same input, the rendered row keys (the `session:<profile>:<id>`
   shape at `useRoster.ts:427`) contain **no duplicate**, asserted on the built models (not on a
   screenshot).
3. **Order is kept.** With the duplicate in both lists, the surviving row is the position the **recents**
   entry gave it (assert the index equality against the recents-only ordering).
4. **Refresh means fresh, not less.** Fake backend counting `profileSessions` calls, with profile `p`
   expanded: calling `refresh` calls `profileSessions` **once** for `p` and the resulting roster still
   contains `p`'s page rows (the check must fail against today's `setLoaded({})`-and-forget code).
5. **Nothing else about the roster moved.** The existing roster/group/search checks all pass unchanged;
   `LAZY_PAGE` and `perProfile` are untouched.
6. `npm test` ≥ 316 passing, 0 failing.

---

## §5 — W3: opening a box stops scrolling the thread

### §5.1 — What is actually broken

`app/thread/[id].tsx:1131` `[verified]`:

```tsx
onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
```

**Every** content-size change scrolls to the bottom — including a layout change **inside an item**,
which is exactly what expanding a long AI-generated block (a tool call) is: the box grows, the list's
content height changes, and the reader is pulled off whatever they were reading back to the end. The
user's description matches the mechanism exactly: scroll down, open a long box, try to scroll up, get
dragged back.

There is a second reason a fix is needed rather than a tweak: the list has **no notion of where the
reader is**. `scrollToEnd` is unconditional, so no rule about the reader's position exists to be
honoured.

### §5.2 — The change

1. **The reader's position is state, and it is measured.** Track pinned-to-bottom from the scroll
   events: pinned when `contentHeight - (offsetY + layoutHeight)` is within a small threshold (use
   **48px**), with `scrollEventThrottle={16}`. Initial value: pinned.
2. **The scroll intent is explicit and has one writer.** Only one thing asks for a scroll to the end:
   **a turn this screen just appended** (the send/stream path). Set that intent where the turn is
   appended, honour it in `onContentSizeChange`, and **clear it after one scroll**. Expanding or
   collapsing a block never sets it. Opening a thread (first paint, load complete) may scroll once to
   the end — that is a different intent and may share the flag, set at load, not by layout.
3. **A pinned reader still follows the stream.** When the reader is pinned and a turn is appended, the
   list still goes to the end (that behaviour is wanted and must not regress). When the reader is *not*
   pinned and a turn arrives, no scroll — the new-turn affordance is not in scope for this release; the
   requirement is only that nothing drags the reader.
4. **The decision is a pure function, in its own module.** `src/logic/scrollPin.ts` exporting the pin
   update and the intent check (`'end' | 'none'` given pinned + appended), so the rule is testable
   without a device. The screen wires it; the screen decides nothing.
5. No new dependency. Do not reach for `maintainVisibleContentPosition` or a list-library swap in this
   release; if you conclude the pinning fix is insufficient on the device, **stop and report that**
   rather than adding a library.

### §5.3 — Acceptance criteria for W3

1. **The pure rule passes its cases.** Harness checks on `scrollPin.ts`: at the end ⇒ pinned;
   within 48px of the end ⇒ pinned; a screen up ⇒ not pinned; an appended turn while pinned ⇒ `'end'`;
   an appended turn while not pinned ⇒ `'none'`; **a content growth with no appended turn ⇒ `'none'`
   regardless of pin state**.
2. **The flag has one writer and one consumer.** Source assertion on `app/thread/[id].tsx`:
   `onContentSizeChange` consults the intent (it is no longer a bare `scrollToEnd`), and the intent is
   set on the turn-append path (and at load) — nowhere else.
3. **The device case, end to end.** With the APK installed: open a thread, scroll up so the list is not
   at the end, expand a long tool-call block ⇒ the list **does not move**; scroll back to the end,
   wait for the next turn ⇒ the list follows the stream. Report both observations as the user's exact
   steps, not as "verified".
4. `npm test` ≥ 316 passing, 0 failing.

---

## §6 — Order of work, revert discipline, commits

W1 → W2 → W3. One commit per workstream, message prefixed `0.14.0 W1`, `0.14.0 W2`, `0.14.0 W3` (the
house label pattern: `0.13.0 W1` … `0.13.0 W4`). Each commit must stand **alone**: reverting W2 must
leave W1's behaviour intact and W3 untouched. The first commit also appends a `0.14.0` header to
`PROGRESS.md` naming this brief, one writer for that file.

State the rule each workstream establishes in its commit body, in the same voice as the existing ones
("one writer", "one fallback", "a clear on success"). Expected:

- W1 — *the registry is the only discriminator; one liveness step per session-scoped RPC, and the lease a resume returns is the identity every later RPC sends.*
- W2 — *the feed has one writer, and it is unique by id; refresh never removes a row it has not refetched.*
- W3 — *the scroll intent is explicit and has one writer; layout changes never move the reader.*

---

## §7 — THE VERIFIER

`npm test` — today: **316/316 passed, 0 failed** (`[verified]`). It is the gate for every workstream.

- New checks are named `0.14.0 W1: …` / `0.14.0 W2: …` / `0.14.0 W3: …`, matching the existing
  numbering style (`0.13.0 W1: the reason travels as data …`).
- The harness already renders screens and drives fake sockets/backends — the `0.13.0 W2` check ("a COLD
  session resumes once and retries once …") is the template for W1; the roster checks are the template
  for W2. Use them; do not build a parallel harness.
- **Do not edit an existing check to make a new behaviour pass.** If a pre-existing check has to change,
  it is evidence about the change, and it goes in the close-out with the reason. (Precedent: two checks
  that pinned the old ordering were rewritten in the desktop plugin's session-order fix — that was
  reported, not hidden.)
- Report the exact final counts, not "all green".

---

## §8 — How to reproduce each defect (device conditions)

1. **W1** — connect to a profile, start a session, send one message, wait for the turn to finish, send a
   second. Expect today: `4001 session not found` and the typed sentence gone from the box. Capture three
   things and put them in the close-out, because they are the whole case: the gateway's own reject line —
   `session-scoped RPC rejected: method=… session_id=… not in memory (detached/reaped runtime; client
   should resume the stored session)` (`server.py:1236-1244`) — the `session_id` in the `session.resume`
   **result**, and the `session_id` the retry actually sent. Without those three the fix is an assertion.
2. **W2** — open a profile row for the first time in a session ⇒ sessions appear doubled. Pull to
   refresh ⇒ they un-double **and** the profile's rows thin out to the recents slice. Collapse and
   re-expand ⇒ the page (and the doubles) come back. That third step is the confirmation that refresh is
   dropping data.
3. **W3** — open a long thread, scroll up, expand a tool-call block ⇒ the list jumps to the bottom.

---

## §9 — Honesty: what not to claim

- **Do not claim you fixed the cause of the cold session.** You are fixing the app's *response* to a
  cold session, which is a real defect (the attach path already knew the answer and the text path did
  not). Whether the session goes cold because of a gateway TTL, a turn teardown, or a socket reconnect
  is `[UNVERIFIED]` (§10) — capture the wire evidence (the failing RPC, its params, the answer, and
  whether resume-then-retry made the retry succeed) and report it. If the `4001` turns out to arrive
  from a **different method or a different code** than the brief assumes, say so — the discriminator is
  the code, not the call site, and the brief's assumption is then wrong, not the device.
- **Do not claim the doubled row is a rendering bug.** It is a data bug: two rows with one key.
- **Do not claim refresh was always fine.** Today it is the user's workaround because it loses rows.
- **Do not claim the scroll fix improves anything you have not watched happen on the device.** The pure
  checks prove the rule, not the device.
- Anything you could not reproduce, or reproduced differently, is reported — not smoothed.

---

## §10 — Anchors: what is verified, and what is UNVERIFIED

### Verified anchors (quotable — read today)

| Anchor | What it says |
|--------|--------------|
| `app.json:5`, `:22` | `version` `0.13.0`, `versionCode` `16` |
| `README.md:52-60`, `:62` | the APK lane: the `personae-android:1` docker build with `--env-file ~/.personae-android/build.env` and `./gradlew :app:assembleRelease --no-daemon --console=plain`; keystore `~/.personae-android/personae-release.keystore` |
| `android/app/build.gradle:111-116`, `:127-133` | the signing env vars; the debug-signing fallback when `PERSONAE_STORE_FILE` is unset |
| `npm test` | **316/316 passed, 0 failed** |
| `src/api/backend.ts:365-366` | `isColdSessionRpc` — `4001` is the cold discriminator |
| `src/api/backend.ts:462-492` | `attachRpc` — the resume-once/retry-once policy (resume `:485`) |
| `src/api/backend.ts:772` | the text path's `prompt.submit` — no cold handling |
| `src/api/backend.ts:901`, `:909` | `activate`'s `4007`/`4009` branches — no `4001` |
| `server.py:1228-1244` | `_sess_nowait` — session-scoped RPCs resolve `_sessions[session_id]`; a miss is `4001`, and the log line names the contract: resume the **stored** session |
| `methods_prompt.py:758` | `prompt.submit` gates on `_sess_nowait` — it cannot warm a session either |
| `methods_session.py:894-905` | `_resume_response` — answers `session_id` = the **new** runtime sid, `resumed`/`session_key` = the stored key |
| `methods_session.py:947`, `:974`, `:991` | `ctx.mint()` in the deferred / cold / eager resumes — every resume mints a new lease |
| `methods_session.py:876-893` | `_resume_reuse_live_locked` — the fast path's `session_id` is the **live** sid, still not the stored key |
| `session_lifecycle.py:819-827` | `_reattach_refusal` — `4007 "session no longer live; retry resume"`, `4009 "session disconnect interrupt settling"` |
| `server.py:143` | `_WS_ORPHAN_REAP_GRACE_S = 20.0` — a detached WS session is parked 20 s, then reaped (**hypothesis** for the trigger, not a measurement) |
| `src/logic/rosterFeed.ts:503-504` | the merge — `merged.push(...list)`, no id dedupe |
| `src/logic/rosterFeed.ts:536` | `rowsForProfile` draws `all.slice(0, perProfile)` |
| `src/logic/rosterFeed.ts:589`, `:33` | `sessionRowModels`; `FeedSession = HermesSession & { profile? }` |
| `src/roster/useRoster.ts:99`, `:115` | `LAZY_PAGE = 25`; `loaded` state |
| `src/roster/useRoster.ts:427` | row key `session:${session.profile}:${session.id}` |
| `src/roster/useRoster.ts:452-463` | `openProfile` guard `if (!opening \|\| loaded[name] \|\| !backend.hasProfiles) return;` |
| `src/roster/useRoster.ts:473-476` | `refresh` = `setLoaded({})` + `loadAll({ silent: true })` |
| `app/thread/[id].tsx:1131` | `onContentSizeChange` → unconditional `scrollToEnd` |
| `app/thread/[id].tsx:243`, `:1113-1130` | `listRef`; the `FlatList` wiring |
| `app/thread/[id].tsx:874-899` | `send`: `setDraft('')` at `:882`, clear-on-success at `:888-890` |

### UNVERIFIED — park here. Name what you find; invent nothing.

1. **Why the session is cold by the second message.** Gateway TTL, turn teardown, socket reconnect — not
   read, not measured. Capture the wire evidence (§9) and name the mechanism you observed.
2. **RESOLVED from source, still to confirm on the wire:** `session.resume` is **not** sufficient by
   itself — it returns a new `session_id`, and the client must send on that (§3.1). What is *not* proven
   is that the live gateway accepts the retry on that lease for `prompt.submit` specifically; the device
   run plus the gateway log settle it. If it still answers `4001` on the returned lease, report it — that
   is a different bug and it does not get worked around.
3. **Whether `watchSession`'s `activate` actually receives the `4001` in the user's failing run** (it is
   the missing-branch finding from reading; the device log decides).
4. **Whether anything else in the thread re-renders the list on box expansion** (e.g. a height change
   that also changes an item's key) — read before you blame `onContentSizeChange` alone; the anchor is
   strong but it is one line.
5. **Whether `PROGRESS.md` or another plan file already describes a 0.14.0** — I did not find one today;
   if you do, say so in the close-out before adding a second narrative.

---

## §11 — The close-out report

Per workstream: the commit, the files, the rule it establishes, the new checks with their names, and the
command + exact output that proves it. Then: final `npm test` counts; the W1 wire log (the failing RPC,
its params, the resume's returned `session_id`, and the retry's `session_id` and answer); the three device observations written as the user's exact
steps with what was seen; the APK path, its `versionCode` 17, and the signing fingerprint compared
against the shipped 0.13.0; and every `[UNVERIFIED]` item from §10 replaced with what you actually found
or left standing with a reason. Anything you did not verify is labelled as not verified.
