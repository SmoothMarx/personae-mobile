# GOAL-0.13.0 — the voice attach stops failing and starts telling the truth, the 404 tells the truth, and the app resumes on launch

**This is the brief.** `DESIGN-0.13.0.md` (same directory) locked these decisions; this document implements
them and departs from none. Read the DESIGN once before starting. If this brief and the DESIGN disagree,
**the DESIGN wins** — stop and report the conflict instead of improvising.

**Batch:** one release, one build, four workstreams. Each workstream must be revertable **alone** — none may
depend on a fix that lands in another.

**Baseline:** today the user's Pixel 8 runs `0.12.0` / `versionCode` 15.

**Target:** `version` **0.13.0** (`app.json:5`) / `versionCode` **16** (`app.json:22`).
There is **no `versionName` key** in `app.json`. Do **not** add one. (An earlier note in the research said
"versionName" — that was wrong.)

**Sign with the same release key as 0.12.0.** The upgrade must install straight over the shipped build with
nothing for the user to re-enter. If the key is not the same key, stop and report it — do not ship a build
the user has to uninstall first.

---

## §0 — How to read this brief

Anchors are marked:

- **`[verified]`** — the line was read directly. Its number is quotable.
- **`[~]`** — a **region marker**, not a quotable line number. Find the line; report what you found.
- **`[UNVERIFIED]`** — not read. It is collected in **§11**. Invent nothing; report what you find.

Every acceptance criterion in this brief is **mechanical**: a command with expected output, or an exact
user-visible string. "Works correctly" is not a criterion and will be rejected at verification. If a
criterion cannot be satisfied as written, **report that** — do not quietly satisfy a nearby one.

---

## §1 — The four workstreams, in order

| # | Workstream | One line |
|---|-----------|----------|
| **W1** | Stop destroying the error | The real reason is written at `app/thread/[id].tsx:486` and overwritten at `:620` with a generic sentence. Make the reason travel as data. |
| **W2** | Make the attach actually work | The gateway resolves sessions from an in-memory map. On the first `4001` / `session not found`, resume once and retry once, then stop. |
| **W3** | The new-session 404 | A client-side draft registry decides empty-thread vs error card. |
| **W4** | Credential persistence, auto-connect, resume | A three-state boot machine; "resume" means the profiles screen. |

Do them in this order. W1 first because it is what makes W2 observable.

---

## §2 — Files you will touch

| File | Why | Status |
|------|-----|--------|
| `app/thread/[id].tsx` | W1 + W3: `submitTurn` (`[verified]` `:470-471`), the two attach calls (`[verified]` `:479` image, `:481` file), the destroyed reason (`[verified]` `:486-487`), the other note writers (`[verified]` `:537`, `:598`, `:622`), the generic label (`[verified]` `:620`), `submitTurn`'s voice call site (`[verified]` `:607`), the 404 branch | W1 + W3 |
| `src/api/backend.ts` | W1 + W2 + W3: `attachFile` (`[~]` `:512` / `:528` / `:530`), the text path's activate-then-resume (`[~]` `:783-799`, with `4007` at `~:790` and `4009` at `~:799`), the draft registry's home | W1 + W2 + W3 |
| `src/i18n.ts` | W1 fallback + W4 strings (`[verified]` `recordFailed` at `:252`, `notFound` at `:601`, `unauthorized`/`unauthorizedProfile` at `:594-597`, `tunnelDown` at `:545`) | W1 + W4 |
| `src/settings.ts` | W4: `autoConnect` at `[verified]` `:139`, default at `:199`, connection fields at `:211-213` | W4 |
| `app/connect.tsx` / `src/connect/Wizard` | W4 boot → connect screen (`app/connect.tsx:24`) | W4 |
| `src/api/errors.ts` | W3 + W4: `technical` at `[verified]` `:45-47`, `isAuth` at `:50-51`, 401 mapping at `:99-101`, `notFound` at `:103-105` | W3 + W4 |
| `app.json` | version bump, `[verified]` `:5` and `:22` | all |
| `src/api/client.ts` | W3: the draft registry's consultation point (`["draft"]` search returns nothing today) | W3 |
| `src/api/errors.ts` docblock `:4-8` | `[UNVERIFIED]` `:7` — it cites `gateway/platforms/api_server.py:933`; that citation is not confirmed | W4 |

**Do not touch:** `src/api/client.ts`'s transport semantics, the tunnel feature, `src/settings.ts`'s
`autoConnect`, or any gateway file. This release is client-side except for what §4 says about *using* an
existing gateway contract.

---

## §3 — W1: stop destroying the error

### §3.1 — What is actually broken

The recording is fine — it is not a permissions or encoder problem. On the device: `RECORD_AUDIO` granted
(`[USER_SET]`), appops allow, `duration=+4s567ms`, logcat `MPEG4Writer` `Audio track source stopped` with
`duration_second: 4`.

The banner the user sees is:

```
The recording failed: the turn did not start
```

`recordFailed` (`[verified]` `src/i18n.ts:252`) is `'The recording failed: ${detail}'`. The
`'the turn did not start'` part is a **hard-coded literal** at `[verified]` `app/thread/[id].tsx:620`:

```ts
if (!accepted) setAttachNote(t.thread.voice.recordFailed('the turn did not start'));
```

And `submitTurn` (`[verified]` `:470`, returning `Promise<boolean>` at `:471`) had the real reason in hand
one frame earlier. Its own `catch` writes it into the **same** slot at `[verified]` `:486-487`:

```ts
setAttachNote(normalizeError(error).message);
return false;
```

Two writers, one slot. The caller at `:620` overwrites the truth with the generic sentence.

### §3.2 — The change

1. **`submitTurn` returns a structured result** — `{ ok: boolean; reason: string | null }` — instead of
   `boolean`. `reason` is exactly the value already computed at `:486` (`normalizeError(error).message`),
   or `null` when there is no reason.
2. **`submitTurn` no longer writes to the note slot.** The write at `:486` is **removed**. The slot has one
   writer: the caller.
3. **The caller renders what it is given.** At `:620`, when the turn did not start, render `reason` if it is
   non-empty; use the generic `recordFailed('the turn did not start')` **only** as a fallback when `reason`
   is empty/null. The generic sentence must survive as a fallback and must never again be passed in place of
   a known reason.
4. **The success path clears a stale note.** After a successful turn the attach note is reset, so a previous
   failure can never be read as the current outcome. **This clear does not exist today** — verified: the
   file's five `setAttachNote` writes (`[verified]` `:486`, `:537`, `:598`, `:620`, `:622`) are all
   failures. It is new code. Add it at both call sites (voice and text), or in one place that both pass
   through — your call, but say which you did.
5. **Every `submitTurn` call site adapts.** The voice call site is `[verified]` `:607`
   (`const accepted = await submitTurn({ ... })`). **There is at least one other call site** (the typed text
   send path) — see `[UNVERIFIED]` §11.4. Find them all (`grep -n 'submitTurn' 'app/thread/[id].tsx'`),
   adapt each, and report every line you changed. Do not leave one reading a boolean.

### §3.3 — Acceptance criteria for W1

1. `grep -n 'submitTurn' 'app/thread/[id].tsx'` → the declaration returns `Promise<{ ok: boolean; reason:
   string | null }>` (or an equivalent named type declared in the same file), and **every** call site
   consumes `.ok`/`.reason`, not a bare boolean.
2. `grep -c 'setAttachNote' src/api/backend.ts` → **`0`**. (True today; keep it true. Note: this module
   never had that call anyway — the point is that the note stays a screen-owned slot.)
3. `grep -n 'setAttachNote' 'app/thread/[id].tsx'` → the write at `:486` is **gone**, and the line that
   renders the turn-did-not-start case reads `reason` first.
4. `grep -c "the turn did not start" 'app/thread/[id].tsx'` → **still ≥ 1** (it is the fallback) **and** the
   only occurrence is inside a conditional that checks for an empty reason. Paste the surrounding 5 lines.
5. `grep -n 'recordFailed' src/i18n.ts` → the key is still defined (`[verified]` `:252`; there may be a
   second, pt-BR definition — report every line and every language you find).
6. `grep -rn 'recording failed' src/ app/ __tests__/ 2>/dev/null` → **only** i18n definitions. Confirm
   before changing the call site whether any test or snapshot asserts the exact sentence; if one does,
   update it in the same commit and say so. There is **no `__tests__/` directory** (verified 2026-10-13:
   `tests/` holds only `rnXhr.ts` and `run.ts`) — if you add a test, follow whatever `tests/` already does.
7. `npx tsc --noEmit` → exits `0`.
8. **On device, with a deliberately cold/unreachable session** (§9): the banner text must **not** read
   `The recording failed: the turn did not start`. It must read `The recording failed: <the real reason>`.
   Paste the banner text you observed. If the reason is empty and the fallback renders, say so explicitly —
   that is a finding, not a failure.

---

## §4 — W2: make the attach actually work

### §4.1 — What is actually broken

The gateway holds sessions in an **in-memory map**. `_sess_nowait` (`tui_gateway/server.py` `[~]` `:1229`)
does `s = _sessions.get(sid)`; on a miss it logs
`session-scoped RPC rejected: method=... session_id=... not in memory` and returns error code **4001** with
message **`session not found`**. `_sess_building` (`[~]` `:1253`) only starts an agent build *after* that
lookup succeeds — so an attach can never warm a cold session. The gateway's own log line states the
contract: **the client should resume the stored session.**

The **typed-text** path already resolves first: activate-then-resume, `src/api/backend.ts` `[~]` `:783-799`.
The **attach** path (`attachFile` `[~]` `:512` / `:528` / `:530` → RPC `file.attach`) has **no liveness
step**. That asymmetry is the bug.

### §4.2 — The change (the retry policy — do not extend it)

On the **first** attach rejection that carries code `4001` **or** message `session not found`:

1. call `session.resume` **once**;
2. **retry the attach once**;
3. on a **second** failure: surface the normalized error and **STOP**.

**No loop. No third attempt. No backoff. No retry on any other code.** The `session.resume` call goes
**inside the attach wrapper** and on the **same shared `DashboardSocket`** the rest of the client uses — do
not open a second socket.

**Do not delete the `4001` branch later on the grounds that the text path doesn't have one.** The text path
triggers on `4007` (`[~]` `:790`) and `4009` (`[~]` `:799`) and has **no** `4001` branch. The attach path
**adds** one. This is a **pattern copy, not a literal copy**.

### §4.3 — Acceptance criteria for W2

1. `grep -n '4001' src/api/backend.ts` → **≥ 1**, and paste the branch. (Today: expected `0` — the file was
   grepped for `4001` and no occurrence was found. If it is present today, report that first.)
2. `grep -n 'session not found' src/api/backend.ts` → the attach predicate; paste it.
3. `grep -c 'session.resume' src/api/backend.ts` → report the count. The attach wrapper contributes
   **exactly one** new call site; if the text path already had one, the report must name both and their
   lines.
4. `grep -n '4007\|4009' src/api/backend.ts` → **unchanged** from before the batch (`[~]` `:790`, `:799`).
   The text path's behaviour is not part of this workstream.
5. **On device** (§9): with a session that the gateway has dropped (restart the gateway, or let the session
   expire, then attach), the attach must **succeed on the retry**, and logcat/gateway log must show exactly
   **one** resume and **one** retry. Paste the lines. A second retry is a failure even if it works.
6. **Failure honesty, both cases.** If the attach succeeds only on the retry, say so — do not describe it as
   "fixed. If it fails twice, the banner must carry the **real** reason (the W1 change) and there must be
   **no third attempt** in the log. Paste both.

---

## §5 — W3: the new-session 404

### §5.1 — What the user sees

Starting a new session shows:

```
Session not found does not exist on the gateway (404) HTTP 404 - Session not found
```

Typing immediately afterwards **works**.

### §5.2 — Why the response cannot be trusted

The banner is **double-written**: `src/api/errors.ts:103-105` `[verified]` builds
`t.errors.notFound(serverMessage)` (i18n `[verified]` `:601`, `'<what> does not exist on the gateway
(404).'`) while the `ApiError.technical` getter (`[verified]` `:45-47`) appends the raw status/code/detail.

Underneath, the gateway raises the **same** detail string `Session not found` for the resolve-miss **and**
for the different-profile case. **The response body cannot discriminate them.**

### §5.3 — The change

A **module-level draft-session registry**:

- **populated** at the moment the app itself mints a session;
- **consulted** by the thread screen when it renders a 404;
- **cleared** for that id on the first successful read or submit.

Then:

- 404 for an id **in** the registry → render an **EMPTY THREAD** (not an error card).
- 404 for an id **not in** the registry → surface the error card **exactly as today**.

**Placement: `src/api/backend.ts`** — it is the only module that mints sessions and therefore the only place
with provenance knowledge. Confirmed by the mint call chain: `app/index.tsx` → `src/roster/useRoster.ts` →
`backend`. **If the mint turns out to live elsewhere, the registry follows the mint, not the file name** —
report where you actually put it.

**Do not filter the strings.** Do not strip `does not exist` / `HTTP 404` from the banner. Fixing the draft
case removes the source of both strings; a string filter is explicitly not the fix.

### §5.4 — Acceptance criteria for W3

1. `grep -n 'createSession' src/roster/useRoster.ts` → **re-find this first.** A previous pass got **no
   match** (`[UNVERIFIED]` §11.1). Report the real mint call site and file. Do not fabricate a line number;
   if you cannot find it, say so and put the registry at the point where the id first exists.
2. `grep -n -i 'draft' src/api/backend.ts` → the registry declaration (plus, if you export it,
   `src/api/client.ts`). Paste it.
3. The registry is **module-level** and the 404 branch is the **only** change in the thread screen's error
   path. `grep -n 'registry\|draft' 'app/thread/[id].tsx'` → paste the branch.
4. **On device** (§9): start a new session. The error card must **not** appear. Paste the screen text.
5. **On device**: open an id that is in the registry but genuinely gone from the gateway **after** a
   successful read (the entry clears) → the **error card** must appear. Paste the screen text. This is the
   half that protects against papering over real errors; do not skip it.
6. `grep -rn "does not exist on the gateway" src/i18n.ts` → the string still exists, unmodified. No filter
   was added: paste `grep -rn 'includes(' src/api/errors.ts 'app/thread/[id].tsx'` and show no new
   string-matching on the 404 path.

---

## §6 — W4: credential persistence, auto-connect, resume

**The semantics are locked. Do not redesign them. Do not add a toggle.**

### §6.1 — What "auto-connect" means

The user's verbatim clarification:

> when I said "When this is activated" I just meant to say when the user logs in for the first time
> successfully, this should be the default. Resuming is just going to the main screen, where all profiles
> are displayed.

Therefore: **no toggle, no settings switch, no new persisted field.** Persistence is **already** a fact —
`expo-secure-store` (`~57.0.4`, already a dependency, already registered in `app.json` plugins; Keystore on
Android, Keychain on iOS) already holds the connection (token + base URL). **The only condition for
auto-connect on launch is that BOTH are present.**

**Do not repurpose `autoConnect`.** The field at `src/settings.ts:139` `[verified]` (default `false` at
`:199` `[verified]`) is a **Tailscale tunnel broadcast** master switch. It is not credential auto-connect.
Leave it exactly as it is.

### §6.2 — The boot state machine

```
boot
 ├── no stored credentials  → connect screen (app/connect.tsx:24 hosts src/connect/Wizard)
 └── credentials present    → validate (see §6.3)
        ├── valid   → profiles screen
        └── invalid → login screen WITH the reason
```

### §6.3 — The validation probe must be token-gated

- `GET /api/health` (`hermes_cli/web_routers/status.py:116-127` `[verified]`) is **unauthenticated** and only
  reports `auth_required`. It **cannot** prove a token is good. **Do not use it as the probe.**
- Use **`GET /api/profiles`** (`hermes_cli/web_routers/profiles.py:806-808` `[verified]`).

### §6.4 — Resume, and the stale token

- **Resume means landing on the main profiles screen** listing all profiles. It does **not** reopen the last
  thread.
- On **401**: fall back to the login screen **ONCE**, show the reason, and **never** silently retry rejected
  credentials.
- Reuse the existing classifier — **do not invent a second one**. `ApiError.isAuth`
  (`src/api/errors.ts:50-51` `[verified]`) is `status === 401 || code === 'gateway_auth_failed'`; 401
  already maps to `t.errors.unauthorized` / `unauthorizedProfile` (`src/api/errors.ts:99-101` `[verified]`;
  i18n `:594-597` `[verified]`).
- The gateway's 401 envelope is `{ error: session_expired | unauthenticated, detail: Unauthorized, reason,
  login_url }` (`hermes_cli/dashboard_auth/middleware.py:84-86` `[verified]`), with reasons including
  `no_cookie` (`:101` `[verified]`) and `invalid_or_expired_session` (`:155` / `:182` `[verified]`). That
  reason string is the signal a stale or revoked token produces.

### §6.5 — Disconnect

A visible **"Disconnect"** action clears the secure-store entry (token + base URL). **Find the key before
adding one**: only `tunnelDown` at `src/i18n.ts:545` (`[verified]`, `'Disconnected'`) is confirmed, and it
belongs to the tunnel UI — **do not borrow it** (`[UNVERIFIED]` §11.6). If no dedicated key exists, add one
(en + pt-BR if the file carries both) and report the key name and the exact rendered string.

### §6.6 — What is persisted — and what is not

Persisted: the **dashboard/session token + base URL**. **Never** the Hermes dashboard password. The pairing
flow persists it as **`apiKey`** (`src/pairing.ts:216`, = `result.token`; verified 2026-10-13). Name it in the
report; never write a value.

### §6.7 — Acceptance criteria for W4

1. `grep -n 'autoConnect' src/settings.ts` → **unchanged**: `:139`, default `false` at `:199`. Paste both
   lines. A repurposed `autoConnect` fails this workstream outright.
2. `grep -rn 'api/health' src/ app/` → **`0`** occurrences on the boot path. Paste the empty result.
3. `grep -rn 'api/profiles' src/` → the probe. Paste the call site.
4. `grep -rn 'isAuth' src/` → reused, not duplicated; report every site.
5. **On device, cold launch with stored credentials, gateway up** → the **profiles screen**, listing all
   profiles. Paste the screen text. (Not the last thread. Not the connect screen.)
6. **On device, cold launch with the credentials cleared** → the **connect screen**
   (`app/connect.tsx:24` / `src/connect/Wizard`). Paste the screen text.
7. **On device, cold launch with a deliberately invalidated token** (revoke the session on the gateway): the
   **login screen**, showing the reason, and the log must show **one** fallback — not a retry loop. Paste
   the screen text and the log lines.
8. **Disconnect** clears the stored connection: after tapping it, a cold launch lands on the connect screen.
   Paste both screen texts.
9. `grep -rn 'password' src/pairing.ts src/settings.ts src/connect/` → **no** new persistence of a dashboard
   password. Paste the result.
10. The exact rendered string for each of criteria 5-8 is quoted in your report.

---

## §7 — Order of work and revert discipline

1. **W1** first — it makes W2's real behaviour observable.
2. **W2** second.
3. **W3** third.
4. **W4** last.
5. Bump `app.json` (`:5` → `0.13.0`, `:22` → `16`) **once**, in its own commit, after all four are green.
6. Each workstream in its **own commit(s)**, each revertable alone. No commit mixes two workstreams.
   Do not add a `versionName` key in any commit.

---

## §8 — THE VERIFIER

Run every one of these from `~/Projects/personae-mobile` and **quote the real raw output**.
An unquoted criterion is unverified.

1. `grep -n 'version' app.json` → `:5` `"version": "0.13.0"` and `:22` `"versionCode": 16`.
2. `grep -c 'versionName' app.json` → **`0`**.
3. `grep -n 'submitTurn' 'app/thread/[id].tsx'` → structured return; every call site consumes it.
4. `grep -c 'setAttachNote' src/api/backend.ts` → **`0`**.
5. `grep -n 'setAttachNote' 'app/thread/[id].tsx'` → the `:486` write is gone; a clear-on-success exists.
6. `grep -n '4001' src/api/backend.ts` → ≥ 1, in the attach wrapper only.
7. `grep -c 'session.resume' src/api/backend.ts` → the wrapper's single call is named.
8. `grep -n -i 'draft' src/api/backend.ts` → the registry exists and is module-level.
9. `grep -rn 'api/health' src/ app/` → `0`; `grep -rn 'api/profiles' src/` → the probe.
10. `npx tsc --noEmit` → exit `0`.
11. The device runs of §3.3.8, §4.3.5, §4.3.6, §5.4.4, §5.4.5, §6.7.5-8 — each with the observed screen
    text quoted verbatim.
12. `git log --oneline` for the batch → each workstream's commits are separable, and the version bump is
    its own commit.

**A criterion is PASS only with the command's real output pasted. "Looks right" is not a result.**

---

## §9 — How to reproduce the device conditions

- **Disconnected / cold session (W1, W2):** restart the gateway so its in-memory session map is empty, then
  attach a voice note to a thread the app still has open. The first attach is expected to be rejected
  (`4001` / `session not found`); W2 must resume + retry once.
- **Timeout / unreachable:** put the device on a network that cannot reach the gateway, then attach.
- **Stale token (W4):** revoke the session on the gateway side, then cold-launch the app with the stored
  credentials still in the secure store.
- **Draft 404 (W3):** start a brand-new session and observe the first render, before any read succeeds.
- Capture the app screen and the logcat (`adb logcat`) around each run; quote the relevant lines.

---

## §10 — Honesty: what not to claim

- **Do not claim** the discarded reason is code `4001`. It is **not proven**. The rival hypothesis is a
  staging rejection inside `_stage_session_file_attachment`
  (`tui_gateway/prompt_attachments.py` `[~]` `:187-230`: the `"invalid data_url payload"` branch, and the
  `_session_home_dir` root lookup). W1 makes the answer **observable** — report what the banner actually
  says; do not theorise past it.
- **Do not claim** W3's different-profile case is fixed-by-test if you did not exercise the path. The
  registry rule is designed to cover it; saying so is not the same as proving it.
- **Do not claim** iOS parity if you only ran an Android device.
- **Do not** describe the W2 attach as "fixed" when it succeeded on the second attempt — say it succeeded on
  the retry, and quote the log showing exactly one.
- **Do not** silently work around an unverifiable anchor. Report it in §11 and in the close-out.

---

## §11 — Anchors: what is verified, and what is UNVERIFIED

### Verified anchors (quotable — line numbers were read)

| Anchor | What it is |
|--------|-----------|
| `app/thread/[id].tsx:470-471` | `const submitTurn = useCallback(` / `async (input: {...}): Promise<boolean> =>` |
| `app/thread/[id].tsx:479` | `await backend.attachImage(sessionId, base64Of(item.dataUrl), item.name, profile)` |
| `app/thread/[id].tsx:481` | `const attached = await backend.attachFile(sessionId, item.dataUrl, item.name, profile)` |
| `app/thread/[id].tsx:486-487` | `setAttachNote(normalizeError(error).message);` / `return false;` — **the reason W1 destroys** |
| `app/thread/[id].tsx:537` | `recordFailed(String((error as Error)?.message ?? error))` in the record-start catch |
| `app/thread/[id].tsx:598` | `recordFailed('no file')` |
| `app/thread/[id].tsx:607` | the voice call site: `const accepted = await submitTurn({ ... })` |
| `app/thread/[id].tsx:620` | `if (!accepted) setAttachNote(t.thread.voice.recordFailed('the turn did not start'));` |
| `app/thread/[id].tsx:622` | the outer catch: `recordFailed(String((error as Error)?.message ?? error))` |
| `src/api/backend.ts` | contains **no** `submitTurn` and **no** `setAttachNote` (grep-verified) |
| `app.json:5`, `app.json:22` | `"version": "0.12.0"`, `"versionCode": 15` |
| `src/i18n.ts:252`, `:545`, `:594-597`, `:601` | `recordFailed`, `tunnelDown`, `unauthorized`/`unauthorizedProfile`, `notFound` |
| `src/api/errors.ts:45-47`, `:50-51`, `:99-101`, `:103-105` | `technical`, `isAuth`, 401 mapping, `notFound` |
| `src/settings.ts:139`, `:199`, `:211-213` | `autoConnect`, its default, the connection fields |
| `hermes_cli/dashboard_auth/middleware.py:84-86`, `:101`, `:155`, `:182` | the 401 envelope and its reasons |
| `hermes_cli/web_routers/status.py:116-127` | `/api/health` — unauthenticated, `auth_required` only |
| `hermes_cli/web_routers/profiles.py:806-808` | `GET /api/profiles` — the correct probe |
| `src/pairing.ts:208`, `:216`, `:205` | `settingsAfterPairing(...)` returns the persisted credential as **`apiKey`** (`:216` = `result.token`); its docblock (`:205`) says settingsStore keeps `apiKey` in secure storage only. W4 reuses this field — do not invent one. |
| `tests/` | contains only `rnXhr.ts` and `run.ts`. **No `__tests__/`, no `*.test.*`, no `*.snap`.** Nothing asserts the banner sentence — it is composed at `src/i18n.ts:252` from the detail literal passed at the call site. |

### UNVERIFIED — park here. Name what you find; invent nothing.

Per the mandate, these are collected here rather than guessed at inline. Investigate each, then either
replace the `[UNVERIFIED]` marker with the real anchor (and say you did) or leave it and report it.

1. **`src/roster/useRoster.ts` — the `createSession` mint site (W3 chain).** `grep -n createSession`
   returned **no match**. The `roster.createSession(...)` call site is unverified. Find it or describe it
   without a line number.
2. **`app/thread/[id].tsx` — the `attachNote` `useState` declaration line.** Not read.
3. **`app/thread/[id].tsx` — the submitTurn success path / where a stale `attachNote` is cleared.** Verified
   only in the negative: the five note writes are all failures, so no clear exists. Name the line you add.
4. **`src/api/backend.ts` — the `attachImage` end line, and the declaration sites of `4001`/`4007`/`4009`.**
   Only the inline literals around `:790`/`:799` were seen; `4001` was **not** seen in this file at all.
   Also unverified: the **other `submitTurn` call site** (the typed-text send path) in the thread screen.
5. **`src/ConnectivityContext.tsx` — the read/write lines for `everReachedGateway` / `lastErrorKind` /
   `lastTriggerResult`.** The fields themselves exist at `src/settings.ts:211-213`.
6. **`src/i18n.ts` — a dedicated Disconnect action key, and the W4 boot/login-reason string.** Only
   `tunnelDown` at `:545` (`'Disconnected'`) is confirmed, and it is the tunnel's string.
7. **`gateway/platforms/api_server.py:933` (`_openai_error`) and `:1580` (auth failure).** Cited only by the
   `src/api/errors.ts:4-8` docblock; never read. Treat those numbers as **unverified**. Do not change the
   docblock in this batch.
8. **`app.json` version keys** — see §VERSION above. The older `versionName` wording was **wrong**; a
   `versionName` key must not appear.
9. ~~`src/pairing.ts` — the token field persisted by the pairing flow.~~ **RESOLVED 2026-10-13 — promoted to the
   table above.** It is `apiKey` (`src/pairing.ts:216`, set to `result.token` by `settingsAfterPairing` at
   `:208`), and the docblock at `:205` states it lives in secure storage only.
10. ~~**W1 wording check.**~~ **RESOLVED 2026-10-13 — nothing asserts it.** `grep -rn 'turn did not start'
    tests/` is empty; there is no `__tests__/` directory and no `*.test.*` or `*.snap` anywhere in the repo.
    The only repo hits for the sentence are this brief's own quote, `PROGRESS.md:3038` (history) and the call
    site `app/thread/[id].tsx:620`. W1 may change the detail string freely.

---

## §12 — Identity, secrets, and the environment

- **Never write a secret into any file, log, report, or commit.** Token, password, API key and connection
  string values live in `~/.hermes/.env` and must never appear anywhere else. The only safe
  token-related string is the env-var **name** `BWS_ACCESS_TOKEN` — and even that is a name you should not
  need.
- When §W4 asks for the persisted field, report its **name**.
- Gateway source lives under the local Hermes install (`~/.hermes/hermes-agent/`); `tui_gateway/*` paths are
  relative to that root.
- `hermes_cli/web_auth.py` **does not exist**. The dashboard auth middleware is
  `hermes_cli/dashboard_auth/middleware.py`. If you find yourself editing `web_auth.py`, you are editing
  nothing.

---

## §13 — The close-out report

Report, in this order:

1. Each workstream: what changed, file + line, and the acceptance criteria output **quoted**.
2. Every `[UNVERIFIED]` anchor from §11: what you found, or that you could not find it.
3. The device runs: the exact screen strings observed.
4. The banner text from §3.3.8 — the real reason, whatever it turns out to be.
5. Anything you could not verify, stated plainly. An honest unknown is a pass; a plausible guess is a
   failure.

---

## §14 — Dispatch addendum: the build, the deliverable, and the device (added by the dispatcher, 2026-10-13)

**Mechanics only — no new scope.** Nothing here changes §3–§6. Where this section and the DESIGN disagree,
the DESIGN still wins; where it and §7/§8 overlap, this section names the exact commands.

### §14.1 — The deliverable

**`~/Projects/personae-mobile/dist/personae-0.13.0.apk`** — a release-signed APK, badged by
`aapt dump badging` as `versionCode='16'` and `versionName='0.13.0'`.

> The APK's `versionName` is **derived** from `expo.version` by prebuild. §VERSION's ban is on adding a
> `versionName` **key** to `app.json` — a badging line reading `versionName='0.13.0'` is correct and expected.
> Do not reconcile this by editing `app.json`.

### §14.2 — Signing: the same key as 0.12.0, checked by fingerprint

```
apksigner verify --print-certs dist/personae-0.13.0.apk
```

The signer SHA-256 must equal **`bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26`**
(the 0.12.0 release key, as recorded in `logs/verify-0.12.0.sh`). If it differs, **stop and report** — never
hand over a build the user has to uninstall first. Keystore and its password live outside the repo
(`~/.personae-android/personae-release.keystore`, `~/.personae-android/build.env`): read the env **names**,
never the values, and never copy that directory into the repo or a commit.

### §14.3 — The build lane (exact — README "Rebuilding the APK")

```bash
npx expo prebuild -p android --no-install
bash scripts/patch-android-signing.sh
docker run --rm --env-file ~/.personae-android/build.env \
  -v "$PWD":/work -v ~/.personae-android/gradle:/root/.gradle \
  -v ~/.personae-android:/signing:ro -w /work/android personae-android:1 \
  bash -lc './gradlew :app:assembleRelease --no-daemon --console=plain'
```

Then copy `android/app/build/outputs/apk/release/app-release.apk` → `dist/personae-0.13.0.apk` and the Gradle
output → `logs/gradle-0130.log`. `android/` is generated and git-ignored: never commit it, and never hand-edit
`android/app/build.gradle` (the next prebuild discards it). If the container's bind-mounted outputs come back
`root:root`, `chown -R "$(id -u):$(id -g)" android/app/build dist` and say you did — an unowned APK installs
fine but breaks the next host-side build.

### §14.4 — The verifier

Extend `logs/verify-0.12.0.sh` → **`logs/verify-0.13.0.sh`**, run it, and paste the raw output into
`logs/verify-0.13.0.txt`. It must keep every older named list (that is the regression gate) and add:

- the §8 command list, with raw output;
- the **suite floor**: 312 passed / 0 failed at 0.12.0 → 0.13.0 must be ≥312 with `, 0 failed`, plus
  `npx tsc --noEmit` rc 0;
- the §14.2 signer fingerprint;
- the leak sweep in **both directions** — the markers that must be present, and the values that must not
  (`Bearer `, `eyJ`, any password/token value). Read every hit and classify it prohibition or leak;
- every device-only item printed **`MANUAL`**, never `PASS`.

### §14.5 — The device is not attached

`adb devices` is **empty** on this host right now. So §9's device conditions and every
§3.3.8 / §4.3.5 / §4.3.6 / §5.4.4 / §5.4.5 / §6.7.5-8 item are **MANUAL**: report each as *not run*, with the
exact commands for the user —

```
adb install -r ~/Projects/personae-mobile/dist/personae-0.13.0.apk
adb shell dumpsys package com.personae.mobile | grep -E 'versionName|versionCode|lastUpdateTime'
```

— and the exact screen strings to look for, quoted from the code. **Never claim a device run that did not
happen.** If a device does appear, the wireless-ADB lane in the `android-apk-builds` skill applies (pair code
first, sweep for the connect port, read the device as text with `uiautomator dump`).

### §14.6 — Commits

One commit per workstream (§7.6), the version bump alone (§7.5), and append to `PROGRESS.md` as each phase
closes. Commit messages name what shipped, not "wip".
