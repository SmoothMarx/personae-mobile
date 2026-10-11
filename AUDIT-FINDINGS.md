# AUDIT FINDINGS — Personae Mobile v0.1.0

The Opus audit session (`20261011_020655_978d71`) was **hard-stopped by a $1.50 cost cap** at
20 API calls / $1.6929, before it wrote `AUDIT.md`. These findings are recovered from its run log
(`audit-opus.log`) and **independently re-verified by the orchestrator**. Where a claim is the
model's and not yet reproduced, it says so.

---

## F1 — CONFIRMED (orchestrator-reproduced): every successful streamed turn double-sends

**Severity: high. This breaks the primary user flow.**

On a streamed turn that succeeds completely, the client emits a **spurious `HTTP 0` error** and the
thread then **re-sends the same message** via the blocking fallback. The agent runs the turn twice,
the user's message lands in history twice, and the user sees a bogus
`Erro no gateway (0): HTTP 0 — fell back` notice on a turn that worked.

**Evidence — the orchestrator ran the audit's own repro harness and got this:**

```
$ npx tsx ~/.hermes/cache/scratch/pm-audit/xhr-done-repro.ts
delta "Ol"
delta "á"
final "Olá"                                              <- the stream SUCCEEDED
onError kind=http status=0 msg="Erro no gateway (0): HTTP 0"
onClose aborted=false
THREAD: error branch -> api.chatOnce() RE-SENDS the message
```

Harness: `~/.hermes/cache/scratch/pm-audit/xhr-done-repro.ts`. It stubs
`XMLHttpRequest` with react-native 0.86.3's real abort semantics
(`Libraries/Network/XMLHttpRequest.js` abort ~654-673, `_reset` sets `status=0` ~189-192,
`setReadyState` dispatches `readystatechange` **synchronously** ~687-689) and drives the **shipped**
`createApi().chatStream` + `xhrTransport`.

**Mechanism (traced through source, all line numbers verified):**

1. The `done` frame is parsed at `readyState === 3` (LOADING) — `src/api/transport.ts:81-88`.
2. `src/api/client.ts:315-319` — `case 'done'` calls `close(false)`.
3. `close()` (`src/api/client.ts:361-370`) calls `stream.close()`.
4. `transport.close()` (`src/api/transport.ts:108-116`) sets `aborted = true` then calls `xhr.abort()`.
5. RN's `abort()` synchronously fires `onreadystatechange` with `readyState === 4` and **`status === 0`**.
6. `src/api/transport.ts:90` tests `xhr.status !== 200` → **true** → line 92 raises
   `StreamHttpError(0)`. **This is the bug: a deliberate, self-inflicted abort is reported as an
   HTTP failure.**
7. `src/api/client.ts:326-340` forwards that as `handlers.onError(httpError(0))` → thread records `lastError`.
8. `src/api/client.ts:370` then calls `handlers.onClose({ aborted: false })` with the *original*
   `false` — so the thread sees "not aborted, but there IS an error".
9. `app/thread/[id].tsx:102-116` → `finishTurn` takes the **error branch** → `api.chatOnce(...)`
   re-sends the message.

**Fix address — `src/api/transport.ts:89-95`.** The readyState-4 handler must not report an error
for an abort we initiated ourselves. `aborted` is already set at line 109 *before* `xhr.abort()`, so:

```ts
if (xhr.readyState === 4) {
  if (xhr.status !== 200 && !aborted) {   // <- was: if (xhr.status !== 200)
    callbacks.onError(new StreamHttpError(xhr.status, (xhr.responseText || '').slice(0, 4000)));
  }
  finish({ aborted });
}
```

With that guard the thread takes its success branch (`loadMessages`), which is the intended outcome.

**Why 40/40 tests and `tsc --noEmit` missed it:** the test suite drives the **node** transport,
whose `abort()` does not raise `onError` the way RN's XHR does. The suite and the defect live on
different transports. This is exactly the gap a mock suite cannot cover — and it is *not* a
live-gateway-availability problem, so no API key would have caught it either.

---

## F2 — audit claim, partially confirmed: approval-gated tools hang with no path out

The audit reported the app **ignores `approval.request` events entirely**, so any tool needing
mid-turn approval blocks the run while the UI shows an endless spinner, and **keepalives reset the
client-side stall timer**, so it never times out. The user must press **Stop**.

Verified in source: `client.ts` handles `run.started` / `assistant.delta` / `assistant.completed` /
`run.completed` / `done` — there is **no** `approval.request` case. The server-side timeout behaviour
was being investigated when the cap fired; **not** reproduced end-to-end.

Impact: lower than F1 for a single-user setup with `--yolo`, but it is a dead end with no visible cause.

---

## F3 — audit observed, NOT verified: duplicate-message risk on mid-stream disconnect

The audit noted that on a mid-stream disconnect the server interrupts rather than continues, so the
user's message is likely **already persisted** before the fallback `chatOnce()` re-sends it —
producing a duplicate entry and a re-run turn. Same shape on an error frame. The audit rated this
"moderate but real". **Not reproduced.** It is downstream of the same fallback design as F1, so it
probably shares a fix.

---

## What the audit did NOT get to

- The `Stop` path was traced and looked **correct** (clean "stopped" notice via close/abort/onError).
- `format.ts` uses manual date formatting rather than `Intl`/`toLocaleString` — safe on the Hermes engine.
- `Platform.OS` usage is isolated to the `KeyboardAvoidingView` offsets. No Android-only constructs
  in shared code, consistent with `expo-doctor` 21/21.
- It had begun re-reading `GOAL.md` to score the six conditions when it was stopped. **Conditions 1-5
  were never formally scored**, and Section C (condition 6) was never written.

## Why it was stopped

Not a model failure. **Hermes compressed the session twice** ("Session compressed 2 times — accuracy
may degrade"), and the log shows it losing `GOAL.md`'s wording and re-reading files it had already
read. Root cause: Hermes assumed a ~111,410-token context window for `anthropic/claude-opus-5.5`
(threshold 0.5 → compress at 55,705), while the model actually has **1M**. So it compressed four
times more eagerly than necessary, and every API call re-billed a large, growing context —
$0.4807 at 3 calls, $1.6929 at 20.
