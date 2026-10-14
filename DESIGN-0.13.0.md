# DESIGN-0.13.0 — voice attach, the new-session 404, and credential resume

**Decisions locked 2026-10-13.** This document exists to stop re-litigation. It states what was decided
and why the alternative was rejected. It is **not** the brief.

**The brief is `GOAL-0.13.0.md`.** It implements these decisions and departs from none of them. If the brief
and this document disagree, this document wins and the brief is wrong.

**Release shape:** one release, one build, four workstreams. Each workstream must be revertable on its own —
no workstream may depend on a fix landing in another.

**Baseline:** `0.12.0` / `versionCode` 15, installed on the Pixel 8. **Target:** `version` 0.13.0
(`app.json:5`) / `versionCode` 16 (`app.json:22`). There is **no `versionName` key** in `app.json`; do not
add one. The build is signed with the **same release key** as 0.12.0 so it installs straight over the
shipped build with nothing for the user to re-enter.

**Anchor legend.** `[exact]` — the line was read in the file. `[~]` — a region marker, not a quotable line
number. `[open]` — not read; parked under *Open questions* at the end of this file and in `§11` of the
brief. Nothing may be written into the brief as a quoted line number unless it is `[exact]`.

---

## The four workstreams

| # | Workstream | What the user sees today | Decision |
|---|------------|--------------------------|----------|
| **W1** | Stop destroying the error | `The recording failed: the turn did not start` — while the app already knew the real reason | `submitTurn` carries the reason out **as data**; the generic label becomes a fallback used only when there is no reason |
| **W2** | Make the attach actually work | The same failure, with its real cause: attaching to a session the gateway no longer holds in memory | On the first `4001` / `session not found` rejection: `session.resume` **once**, retry the attach **once**, then stop |
| **W3** | The new-session 404 | `Session not found does not exist on the gateway (404)` on a session the app just minted; typing immediately afterwards works | A **client-side draft registry** decides: id in registry → empty thread; id not in registry → error card, exactly as today |
| **W4** | Credential persistence, auto-connect, resume | Nothing is broken — the behaviour was never specified | A three-state boot machine, and "resume" means **the profiles screen**, not the last thread |

---

## W1 — Stop destroying the error

### What is actually true on the device

The recording is **not** the problem. Read off the device: `RECORD_AUDIO` granted (`[USER_SET]`), appops
allow, `duration=+4s567ms`, and logcat's `MPEG4Writer` line `Audio track source stopped` with
`duration_second: 4`. Audio was captured.

The user-visible banner, read verbatim from the UI dump, is:

```
The recording failed: the turn did not start
```

That sentence is a **generic label**. The i18n key `recordFailed` `[exact]` (`src/i18n.ts:252`) holds
`'The recording failed: ${detail}'` (a second, pt-BR definition may exist — grep `recordFailed` and report
every line), and the voice path supplies
`the turn did not start` as the `${detail}` at `app/thread/[id].tsx:620` `[exact]`:

```ts
if (!accepted) setAttachNote(t.thread.voice.recordFailed('the turn did not start'));
```

### The defect: two writers, one slot

`submitTurn` is declared at `app/thread/[id].tsx:470` `[exact]` and its own docstring at `:466-469` says
*"Returns `true` when the turn actually started"*. It returns a bare `boolean` (`:471`, `Promise<boolean>`)
to its callers, and returns `false` only from its own `catch` — a catch that **first writes the real reason
into the same note slot** `[exact]`:

```ts
// app/thread/[id].tsx:486-487
setAttachNote(normalizeError(error).message);
return false;
```

The voice caller then **overwrites that same slot** with the generic sentence at `:620`. Two writers, one
slot, and the true error — already computed at `:486` — is destroyed by the second write.

*Correction to the research note:* the destroyed reason is written in **`app/thread/[id].tsx`**, not in
`src/api/backend.ts`. Verified by grep: `src/api/backend.ts` contains **no** `submitTurn` and **no**
`setAttachNote` — a module that has no React state setter cannot own that line. The whole W1 geometry is in
the thread screen.

### Decision

**`submitTurn` returns a structured result instead of a boolean:**

```ts
{ ok: boolean; reason: string | null }
```

`reason` carries the value it already computes — `normalizeError(error).message` — out as data. The generic
`recordFailed` label becomes a **fallback used only when `reason` is empty or null**. The write at `:486`
is removed: `submitTurn` stops writing to the note slot at all, because the slot has exactly one writer, the
caller.

### Rejected

**Keeping two writers and relying on write order.** Write order *is* the defect. Documenting it ("the caller
must write last") re-creates the same silent loss the next time someone reorders a line. It is removed, not
documented.

### Decision, second half — the same rule on the success path

The single-writer rule must also cover SUCCESS: **a stale attach note is cleared on success**, so a previous
failure can never be read as the current outcome. Today there is no clear — the five writes in the file,
`:486`, `:537`, `:598`, `:620`, `:622` `[exact]`, are all failures. The clear is **new code**, not a
relocation.

### Honesty

It is **not proven** that the discarded reason is code `4001`. The rival hypothesis is a staging rejection
inside `_stage_session_file_attachment` (`tui_gateway/prompt_attachments.py` `[~]` `:187-230`): the
`"invalid data_url payload"` branch, and the `_session_home_dir` root lookup. W1 does not settle that
question — it makes the answer **observable**. Do not claim W2 is proven. W1's whole point is that the next
device run tells us which one it is.

---

## W2 — Make the attach actually work

### What is actually broken

The gateway resolves sessions from an **in-memory map**. `_sess_nowait` (`tui_gateway/server.py` `[~]`
`:1229`) does `s = _sessions.get(sid)`; when the id is not resident it logs
`session-scoped RPC rejected: method=... session_id=... not in memory` and returns error code **4001** with
message `session not found`. `_sess_building` (`[~]` `:1253`) starts an agent build only *after* that
lookup succeeds — so an attach can never warm a cold session.

The gateway's own log line states the contract: **the client should resume the stored session.**

The **text** send path in `src/api/backend.ts` already resolves first (activate-then-resume, `[~]`
`:783-799`). The **attach** path (`attachFile` `[~]` `:512` / `:528` / `:530`, reaching RPC `file.attach`)
has no liveness step at all. That asymmetry is the bug.

### Decision — the retry policy

On the **first** attach rejection carrying code `4001` **or** the message `session not found`:

1. call `session.resume` **once**,
2. then retry the attach **once**,
3. on a second failure, surface the normalized error and **STOP** — no loop, no third attempt.

The resume is called **inside the attach wrapper**, on the **same shared `DashboardSocket`** the rest of the
client uses. A second socket would produce a second session view and is not acceptable.

### Nuance that must survive

The text path triggers on `4007`/`4009` and has **no `4001` branch** (both are inline literals in
`src/api/backend.ts` `[~]` `:790` and `:799`). The attach path therefore **adds** a `4001` branch. This is a
**pattern copy, not a literal copy** — anyone reading this later must not "fix" the divergence by deleting
the `4001` branch on the grounds that the text path doesn't have one. The divergence is the design.

### Honesty

W2 makes cold-session attach work. It does **not** by itself fix the W1 banner, and W1 does not fix the
attach. They are separate workstreams that happen to share a symptom. Landing one without the other is a
legitimate revert.

---

## W3 — The new-session 404

### What the user sees

Starting a new session shows:

```
Session not found does not exist on the gateway (404) HTTP 404 - Session not found
```

and typing immediately afterwards **works**.

### Why it is double

The banner is **double-written**. `src/api/errors.ts:103-105` `[exact]` builds
`t.errors.notFound(serverMessage)` — i18n `:601` `[exact]`, `'<what> does not exist on the gateway (404).'`
— while the `ApiError.technical` getter (`src/api/errors.ts:45-47` `[exact]`) appends the raw
status/code/detail. Two strings, one banner.

### Why the response cannot be trusted to discriminate

Underneath, the gateway raises the **same** detail string, `Session not found`, for two different things:

- the resolve-miss (an id the gateway has no record of), and
- the **different-profile** case (a session that exists, but under another profile).

The response body therefore **cannot** tell them apart. Any rule keyed off the detail text or the bare
status code is guessing.

### Decision — client-side provenance

A **module-level draft-session registry**:

- **populated** at the moment the app itself mints a session,
- **consulted** by the thread screen when it renders a 404,
- **cleared** for that id on the first successful read or submit.

Then:

- `404` for an id **in** the registry → render an **EMPTY THREAD**. The id is real to the app and not yet
  real to the gateway; that is a draft, not an error.
- `404` for an id **not in** the registry → surface the error card **exactly as today**. This covers the
  profile mismatch, a genuinely deleted session, and a wrong id.

The app knows something the response body does not: **whether it minted the id.** That is the only
discriminator available, so it is the one we use.

### Rejected

**Keying off the detail text** (`'Session not found'`) or **the bare status code** (`404`). The gateway
emits one string for both cases; a rule built on it is a coin flip that will one day render an empty thread
over a real error, or an error card over a fresh session.

### Decision — placement

The registry's **recommended home is `src/api/backend.ts`**, because it is the only module that mints
sessions and therefore the only place with provenance knowledge. **Flagged for confirmation:** the mint
call chain runs `app/index.tsx` → `src/roster/useRoster.ts` → `backend` (`[open]` — a
`grep -n createSession src/roster/useRoster.ts` returned **no match**, so the exact mint line is unverified;
see *Open questions* 1). If the mint site turns out to live elsewhere, **the registry follows the mint, not
the file name**.

### Note on the double banner

The UI must **not** paper over the double banner with string filtering. Fixing the draft case removes the
source of **both** strings. A `filter(s => !s.includes('does not exist'))` is explicitly not the fix.

---

## W4 — Credential persistence, auto-connect, resume

**Semantics are LOCKED. Do not redesign them.**

The user's own clarification, verbatim:

> when I said "When this is activated" I just meant to say when the user logs in for the first time
> successfully, this should be the default. Resuming is just going to the main screen, where all profiles
> are displayed.

### Therefore

- **NO toggle. NO settings switch. NO new persisted field.**
- Persistence is **already a fact**: `expo-secure-store` (`~57.0.4`, already a dependency and already
  registered in `app.json` plugins; Keystore on Android, Keychain on iOS) already holds the connection —
  token + base URL.
- The **only** condition for auto-connect on launch is that **BOTH are present**.

### Critical correction — do not repurpose `autoConnect`

The existing settings field `autoConnect` (`src/settings.ts:139` `[exact]`, default `false` at `:199`
`[exact]`) is a **Tailscale tunnel broadcast** master switch. It is **not** credential auto-connect and must
**not** be repurposed. Reusing it would tie "connect on launch" to the tunnel, which is a different feature
with a different failure mode.

### Decision — the boot state machine

```
boot
 ├── no stored credentials  → connect screen (app/connect.tsx:24 hosts src/connect/Wizard)
 └── credentials present    → validate
        ├── valid   → profiles screen
        └── invalid → login screen WITH the reason
```

### Decision — the probe must be token-gated

`GET /api/health` (`hermes_cli/web_routers/status.py:116-127` `[exact]`) is **unauthenticated** and only
reports `auth_required`. It therefore **cannot prove a token is good**. The probe is
`GET /api/profiles` (`hermes_cli/web_routers/profiles.py:806-808` `[exact]`).

### Decision — resume, and the stale token

- **Resume means landing on the main profiles screen** listing all profiles. It does **not** reopen the last
  thread.
- On **401** the app falls back to the login screen **ONCE**, shows the reason, and **never** silently
  retries rejected credentials.
- A visible **"Disconnect"** action clears the secure-store entry.
- What is persisted stays the **dashboard/session token + base URL — NEVER the Hermes dashboard password.**

### The signal a stale token produces

The gateway's 401 envelope is `{ error: session_expired | unauthenticated, detail: Unauthorized, reason,
login_url }` (`hermes_cli/dashboard_auth/middleware.py:84-86` `[exact]`), with reasons including `no_cookie`
(`:101` `[exact]`) and `invalid_or_expired_session` (`:155` / `:182` `[exact]`). That reason string is the
signal a stale or revoked token produces.

The classifier already exists: `ApiError.isAuth` (`src/api/errors.ts:50-51` `[exact]`) is
`status === 401` **or** `code === 'gateway_auth_failed'`, and 401 already maps to `t.errors.unauthorized` /
`unauthorizedProfile` (`src/api/errors.ts:99-101` `[exact]`; i18n `:594-597` `[exact]`). **Reuse it — do not
invent a second classifier.**

---

## Anchors the brief must honour

- `app.json:5` = `"version": "0.12.0"`; `app.json:22` = `"versionCode": 15`. No `versionName` key exists.
- `src/i18n.ts:252` defines `recordFailed`; the sentence `The recording failed: the turn did not start` is
  composed, not stored — `'the turn did not start'` is a literal in `app/thread/[id].tsx`.
- `src/api/backend.ts` contains **no** `submitTurn` and **no** `setAttachNote`.
- Writer discipline: five `setAttachNote` writes exist today (`app/thread/[id].tsx:486`, `:537`, `:598`,
  `:620`, `:622`), zero clears. After W1: one writer per outcome, and a clear on success.
- RPC code `4001` / message `session not found` belongs to `tui_gateway/server.py`'s in-memory session map.
  The attach path is the only client path that has to learn about it.

---

## Open questions (UNVERIFIED — do not write these as facts)

1. **`src/roster/useRoster.ts` — the `createSession` mint site.** `grep -n createSession` returned **no
   match** in that file, so the `roster.createSession(...)` call site in the W3 chain is unverified and must
   be re-found, or described without a line number.
2. **`app/thread/[id].tsx` — the `attachNote` `useState` declaration line.** Not read.
3. **`app/thread/[id].tsx` — the submitTurn success path / where a stale `attachNote` is cleared.** Verified
   only in the negative: the file's five note writes are all failures, so the clear does not exist. The
   exact call site to add it at is not yet named.
4. **`src/api/backend.ts` — the `attachImage` end line, and the declaration sites of `4001`/`4007`/`4009`.**
   Only the inline literals around `:790` / `:799` were seen. `4001` was **not** seen in this file at all.
5. **`src/ConnectivityContext.tsx` — the read/write lines for `everReachedGateway` / `lastErrorKind` /
   `lastTriggerResult`.** The fields themselves exist at `src/settings.ts:211-213`.
6. **`src/i18n.ts` — a dedicated Disconnect action key, and the W4 boot/login-reason string.** Only
   `tunnelDown` at `:545` (`'Disconnected'`) is confirmed, and it is the wrong string to borrow.
7. **`gateway/platforms/api_server.py:933` (`_openai_error`) and `:1580` (auth failure).** Cited only by the
   `src/api/errors.ts:4-8` docblock; never actually read. Treat the docblock's line numbers as unverified.
8. **`app.json` version keys** — see above; the older `versionName` wording was wrong and must not reappear.
9. ~~**`src/pairing.ts` — the token field persisted by the pairing flow.**~~ **RESOLVED 2026-10-13.** The
   persisted credential is `apiKey` — `settingsAfterPairing` (`src/pairing.ts:208`) returns it as
   `apiKey: result.token` at `:216`, and its docblock (`:205`) states secure storage only. W4 rides this
   existing field.
10. ~~**W1 wording check**~~ — **RESOLVED 2026-10-13.** Nothing asserts the sentence: no `__tests__/`, no
    `*.test.*`, no `*.snap`; `tests/` holds only `rnXhr.ts` and `run.ts`. The banner is composed at
    `src/i18n.ts:252` from the detail literal at `app/thread/[id].tsx:620`, so W1 is free to reword it.
