# GOAL-0.11.0 — Files and voice go through, the mic becomes a choice, `/` completes, and the thread watches itself live

**Batch:** one release, one build. **Half A** is `GOAL-0.10.1.md` §S1–S9 *by reference* (the review-only
batch, unshipped). **Half B** is the six items below — the three things the user reported, one
declaration the voice path has been silently leaning on, and the two halves of the `/` menu. **Half C**
is §7–§8: the two bugs the user reported two days later and still open — the thread must watch its own
session live, and the keyboard must lift the composer. Half C sits in its own sections so it can be
reverted alone (§10.14).

**Baseline:** `dist/personae-0.10.0.apk` — v `0.10.0`, vc `12`, `116,979,706` B,
sha256 `3b231c830f154c5c3af64f9043297aa804430a343be23afe9e4e30286c464c2f`, same release key as
0.1.0–0.10.0.

**Target:** `versionName 0.11.0` / `versionCode 14` (`app.json:5`, `app.json:21`), signed with the
SAME release key, so it installs over 0.10.0. Half A was specced at vc13; **vc13 is skipped** — the
version assertions in `GOAL-0.10.1.md` §9 move to 0.11.0 / vc14 and there is exactly ONE verify
script for the single build (`§14`).

**Work order:** `GOAL-0.10.1.md` §S1–S9 has been read and confirmed by the user. It runs in this same
unit. Nothing here changes any item of it, and no item of it changes this.

---

## §0 — What this batch is, in the user's words

Verbatim, 2026-10-13:

> - Sending a file does not work yet, let's implement that
> - The voice message is not working. The recording is happening, but it's not being sent through.
> - When the user clicks on the microphone and starts recording, change the microphone button into a stop icon.

Asked and answered, same day:

> **Q: when a recording stops, what should happen?**
> → *"Add as an option in settings for the user to choose."*
>
> **Q: which sources should the paperclip offer?**
> → *"Any file + the photo library (adds expo-document-picker + expo-image-picker)"*
>
> **Q: one build or two?**
> → *"Option A, but don't build yet."*

Reported two days later, same session:

> - When opening a session, scroll to the bottom. If the user manually scrolled up, keep the position.
> - When typing in the message box, if the user inserts a "/", show a list of all the commands that can be inserted. If they click on one, insert it into the field.

And the two answers that closed them:

> **Q: the composer already auto-scrolls on every content-size change — leave it, or guard it?**
> → *"If it already auto-scrolls, you can leave it."* → **the scroll report is closed as
> already-implemented; both halves of it are untouched (§15).**
>
> **Q: the `/` menu — text only, or does a command also have to run?**
> → *"For the slash part, go with approach A."* → **the menu is built AND the command executes, with
> its output in the existing notice card (§R5, §R6).**

Reported the same day, still open, and answered with a packaging decision:

> - your responses and reasoning should show up on the conversation in real-time, it should not need a refresh from the user (exist session and come back in)
> - when clicking the message field, and the system keyboard opens, raise the message field above the keyboard, so the user can see what they're typing.
>
> **Q: item one is a change to the streaming path, not a repaint — how should it be packaged?**
> → *"Both into 0.11.0 as a separable Half C (one build, one install; revertable alone if the device
> check fails)."* → **both are in this build, as §7 and §8.**

These answers and decisions are load-bearing and are used here without further argument:

1. the mic gesture is a **setting**, not a swap of the default for everybody (§R3);
2. the paperclip gains **two** new sources and therefore **two** native dependencies (§R2);
3. it is **one build** — Half A and Half B ship together as 0.11.0;
4. the `/` menu is **not cosmetic**: tapping inserts a command *and* pressing send runs it (§R6);
5. the session-open scroll is **not in this batch** — see §15 for what that leaves unfixed;
6. the two newest reports are **in this build** as Half C, each in its own section so it can be
   reverted without touching Half A or Half B (§7, §8);
7. the keyboard fix ships as a **candidate with a device check** — it cannot be verified headlessly
   and will not be reported as verified (§8, §14).

---

## §1 — R1: the reference has to travel with the turn

**This is the bug behind BOTH "the voice message … is not being sent through" and, once a picker
exists, "sending a file does not work".** It is one bug, not two.

### The evidence, from the gateway itself

`file.attach` (`tui_gateway/methods_prompt.py:1030-1050`) stages the bytes and returns:

```python
"ref_path": ref_path, "ref_text": f"@file:{_format_ref_value(ref_path)}",
```

It queues **nothing**. Now contrast `image.attach_bytes` (`:941-969`), which ends in
`_queue_attached_image(...)` → `prompt_attachments.py:137-159` → `session["attached_images"].append(...)`,
and that queue is **consumed automatically by the next submit** — `compute_host_bridge.py:57` hands
`attached_images` to the turn, `:304` clears it afterwards.

So: **an image rides the turn by itself. A file does not.** `ref_text` has no consumer anywhere on the
server — its only other appearances are tests asserting its *shape*
(`tests/tui_gateway/test_tui_gateway_server.py:11772, 11805, 11836, 11898, 11949`). The one side that
can put it into the prompt is the **client**.

### What the client does instead

`app/thread/[id].tsx`, inside `send()`:

```ts
337|    if (staged.length) {
339|        for (const item of staged) {
342|          if (item.kind === 'image') await backend.attachImage(sessionId, base64Of(item.dataUrl), item.name, profile);
343|          else await backend.attachFile(sessionId, item.dataUrl, item.name, profile);
344|        }
```

`backend.attachFile` faithfully returns `{ path, refText, uploaded }` (`src/api/backend.ts:349-362`,
`refText` at `:359`). **The return value is discarded.** The turn is then submitted with
`text = draft.trim()` (`:328`) — which, for a voice note, is the empty string. The note is staged on
the box, the agent receives an empty prompt, and never learns the file exists. That is precisely the
reported symptom: *"the recording is happening, but it's not being sent through."*

### The fix

Collect the refs, and let the wire text carry them while the screen keeps the human words:

- accumulate `refText` from every non-image attach in the loop at `:337-350`;
- build the wire text as caption + refs, each on its own line, empties dropped;
- pass the **wire** text to `backend.chatStream(...)` (`:360-393`);
- keep `pendingRef.current` (`:353`), `setLive({ user: … })` (`:357`) and the live bubble (`:521`) on
  the **caption**, so the user never reads `@file:/home/…` in their own message;
- **the live bubble must never be blank.** A voice note has no caption, so the display falls back to a
  label — and the label already exists and is **dead**: `t.thread.voice.sending` = `'Voice note'`
  (`src/i18n.ts:235`, PT `:1054`), declared in 0.9.0 Phase H and referenced nowhere. Consume it. A file
  with no caption falls back to its file name.
- `captionFor` (`src/logic/attachments.ts:113`) is only `draft.trim()` — it does **not** compose
  caption + refs. The composition is new code: give it its own named function rather than growing the
  loop, and leave `captionFor` alone.

After the turn completes and the thread refreshes, the server's stored user message contains the
`@file:` ref, which `parseMessageContent` already parses into a file card / voice-note bubble
(`attachments.ts:141`, `voiceNoteOf` — `src/logic/voice.ts:127`). That is the intended end state: the
bubble shows the caption **and** the attachment, exactly the way an inbound one does.

**Rule R1.a — the empty-prompt guard stays a guard and never becomes the fix.** `send()`'s
`if ((!text && !staged.length) || streaming || !sessionId) return;` (`:329`) is correct as written. Do
not make it "send if attachments only" and call the job done: with an empty wire text the turn still
carries nothing the agent can open.

**Rule R1.b — no server change.** The asymmetry between `image.attach_bytes` and `file.attach` is the
server's design, not a bug to fix here; the TUI has always carried the ref in the message text. The
client is the side that is wrong.

---

## §2 — R2: a picker, so a file can be chosen at all

There is no picker. Not a broken one — none.

- The paperclip's third row is `key: 'document'` with `disabled: true` and
  `reason: t.thread.attach.documentReason` (`app/thread/[id].tsx:729-735`), whose text admits it:
  *"Choosing a file from this phone needs a file picker that is not built yet. Pictures work today."*
- Neither `expo-document-picker` nor `expo-image-picker` is in `package.json` — the declared list holds
  `expo-audio`, `expo-camera`, `expo-clipboard` and friends, and no picker of either kind. Neither name
  appears in the shipped `dist/personae-0.10.0.apk` either (`assets/index.android.bundle`, `classes*.dex`).
  **Weight those two facts differently.** The dependency list is the load-bearing one: a declared module
  that is imported lazily also shows zero bundle matches — `expo-clipboard` does exactly that today — so
  a grep alone proves nothing. The dependency list plus the `disabled: true` row above is the proof.

### Add two dependencies, from the SDK, and nothing else

`expo-document-picker` (any file) and `expo-image-picker` (the photo library). Both are Expo SDK
packages at the version `expo@57.x` pins — **no floating versions, no third-party pickers, no
`react-native-document-picker`.**

### Wire it

- **Rows.** Re-enable `document` (drop `disabled` and `reason`) and add the photo-library row. the user
  chose "any file + the photo library", so the sheet ends up: camera, photo library, file, clipboard.
- **Trap (`labelOf`).** `app/thread/[id].tsx:737-742` resolves a row's label through a ternary chain
  whose **final `else` is `document`**. Adding rows without extending that chain mislabels them all.
  Resolve labels from the entry, not from a positional fallback.
- **From picker result to staged item.** Both pickers hand back a URI + name + mime (the document
  picker also a size). Build the data URL and go through the ONE existing door: `stage(...)`
  (`attachments.ts:81`), which already enforces `ATTACHMENT_MAX_BYTES` = 25 MB (`:36`) and returns the
  `refused` reason the screen already displays (`app/thread/[id].tsx:308`). Do **not** hand-roll a
  second staging path — the strip, `unstage` (`:105`) and the send loop must keep working untouched.
- **Size check BEFORE reading bytes.** A picker can hand over a multi-gigabyte URI. Refuse on the
  reported size first; read base64 only for what passes. Reading first and refusing after is an OOM on
  a phone.
- **Read the bytes the same way the voice note already does** — `expo-file-system`'s `File(uri)`
  (see `endVoice`, `app/thread/[id].tsx:264-301`). One read implementation, not two.
- **`app.json`.** Register both plugins, with permission strings written the way the existing ones are
  (`expo-camera`, `app.json:61-66`; `expo-audio`, `:36-39`) — a sentence that says what the app does
  with it, not a formality. iOS gets the photo-library usage description; Android needs no new
  manifest permission for the storage access framework, and do not add one speculatively.
  `expo-camera`'s config is deliberately narrow (`recordAudioAndroid: false`,
  `microphonePermission: false`) — **do not widen it**; the mic belongs to `expo-audio`.
- **Permission refusal is a sentence, not a crash.** A denied photo-library permission shows the
  reason in the same note slot the camera already uses (`t.thread.attach.cameraDenied` is the model).
- **Strings.** New keys for the two rows and their reasons, in **both** tables (`src/i18n.ts` EN and
  PT). Neither row is settings-wizard text, so `EN_ONLY_SETTINGS_KEYS` (`:804-816`) is not where they
  go. Half A's `wizIpHelp` deletion is unaffected.

---

## §3 — R3: the mic becomes a setting, and the stop icon needs a gesture to mean anything

### Why this is not an icon swap

The mic is hold-to-record today: `onPressIn={() => void beginVoice()}` /
`onPressOut={() => void endVoice()}` (`app/thread/[id].tsx:696-697`), glyph `mic-outline` (`:705`).
While a thumb is **held down**, repainting the button as a stop square offers nothing the user can act
on. *"Clicks on the microphone and starts recording, change the microphone button into a stop icon"*
describes **tap to start, tap to stop** — a different gesture, which is why the user made it a setting
rather than replacing the gesture for everyone.

### The setting

- One field on `Settings` (`src/settings.ts:72`), stored through the existing blob
  (`SETTINGS_STORE_KEY` `:138`, `DEFAULT_SETTINGS` `:142`, `loadSettings`/`saveSettings` in
  `src/settingsStore.ts:39,108`) — **do not invent a second store**.
- Values: **hold** (today: press and keep holding, slide left to cancel, release to keep) and **tap**
  (tap to start, button becomes a stop, tap stop to finish).
- **Default: `tap`.** It is the behaviour the request describes, and in `hold` a mere *tap* is a
  press-and-release under `MIN_DURATION_MS` (`voice.ts:47`) and therefore a refusal — so a user who
  wants to tap must be able to. Flagged in §16 for confirmation.
- **Scope: device-local.** There is no server meaning for a phone gesture, and portable would mean
  writing a new key into the server's preference document. Declare it in `DEVICE_LOCAL_SETTING_IDS`
  (`src/settingsPages.ts`) — the page's own promise (`PORTABLE_SETTING_IDS` / `DEVICE_LOCAL_SETTING_IDS`
  / `scopeOfSetting`) is a tested fact, and a field on screen in neither list is a bug by that module's
  own definition.
- **Consequence, do not paper over it:** Agent Preferences is the natural home, and its row currently
  declares `scope: 'portable'`. A device-local field inside it makes that chip a lie. Change the row's
  scope to `'mixed'` and name the exception in its help text — **exactly the shape Notifications
  already uses** ("the switches sync, the OS permission cannot"). That is the codebase's own
  convention for this situation, not a new one.
- Control: a two-option choice, saving on tap like every other single-field setting on that page
  (`pedro-app-defaults`: no Save button). Place it on the Agent Preferences page after the session-types
  block's closing `</View>` (`app/settings.tsx:1011`), before the fragment close (`:1013`).
- **The composer must read it.** `app/thread/[id].tsx` imports neither `useSettings` nor the context
  today (it gets `backend` from `useBackend()`, `:114`, which reads settings internally). Add the
  `useSettings` consumer (`src/SettingsContext.tsx:85`) so the composer re-renders when the choice
  changes — a setting that needs an app restart is not a setting.

### The mic in each mode

- **tap:** tap starts → the button becomes a **stop square**, red, and the recording bar appears with
  the elapsed clock (`voiceNow`, `:240-246`) and an explicit **cancel** control. Tap stop → finish.
  The slide-to-cancel affordance does not exist in this mode (there is no drag), so the bar must offer
  cancel as a button; a mode with no way to abort a recording is a trap.
- **hold:** unchanged gesture, same slide-left-to-cancel — **which must be wired while we are here.**

### Rule R3.a — the dead slide

`updateSlide` is imported at `app/thread/[id].tsx:68` and **called nowhere**: there is no
`onTouchMove`/PanResponder on the mic. `slideLabel` (`voice.ts:102`) therefore never returns
`'cancelling'`, and `CANCEL_DX` (`:44`) is unreachable. The hold mode's advertised
*"Slide left to cancel, release to keep"* is dead copy. Wire it (a move handler feeding `updateSlide`
and the bar fed by `slideLabel`) or delete the affordance and its strings — **do not leave a label
promising a gesture that does nothing.** Prefer wiring it: `releaseRecording` already reads
`slideDx` (`voice.ts:93`) and treats a slide past `CANCEL_DX` as a cancel, so the logic is finished and
only the input is missing.

### Rule R3.b — stopping sends

When a recording stops, **the note is sent**, in both modes. Not staged into the strip: the user's report
is that a recorded note does not go through, and a second gesture between "I recorded it" and "it was
sent" is the thing he is complaining about. The strip keeps its job for images and files, where
choosing and sending are genuinely separate acts (Pick → see it → Send). Flagged in §16.

Consequently, a voice note must be **visible in the thread immediately** when the turn starts: it rides
R1's display fallback (`t.thread.voice.sending`, §1), never an empty bubble, and it stops being a
`kind: 'file'` item sitting in a strip nobody pressed Send on.

### Rule R3.c — the recorder's lifecycle is untouched

`beginVoice`/`endVoice` (`:247`, `:264`), `releaseRecording`, `MIN_DURATION_MS`, `MAX_DURATION_MS`
(`voice.ts:47,50`) and `voiceAttachment` (`:145`) keep their contracts; the tap mode adds an entry
point and an icon, it does not fork the state machine. `VoicePhase` (`:31`) already has `'recording'`
and `'cancelling'` — a mode is not a phase. Do not add one.

---

## §4 — R4: declare `expo-file-system`

`await import('expo-file-system')` is how the voice note's bytes are read
(`app/thread/[id].tsx:264-301`), and the package is **not in `package.json`**. It resolves today only
because `expo@57.0.27` depends on `expo-file-system@57.0.7` — verified present in `node_modules`,
present in the shipped bundle, and present in the APK's `classes5.dex`, so voice recording works today.
It is a transitive dependency doing load-bearing work under a dynamic import.

Declare it explicitly at the version already installed (`57.0.7`). One line, and the next SDK bump
cannot silently take the voice path with it. R2's "read the bytes the same way the voice note already
does" (the `File(uri)` API) is the same dependency — after this, both paths rest on a declared package.

---

## §5 — R5: the `/` menu, served by the gateway's own completer

the user, verbatim: *"if the user inserts a `/`, show a list of all the commands that can be inserted.
If they click on one, insert it into the field."*

**Nothing has to be invented on the server side.** `complete.slash`
(`tui_gateway/methods_complete.py:278-331`) is this feature already: it takes `{text, session_id,
profile}` and answers

```json
{"items": [{"text": "/help", "display": "…", "meta": "…", "kind": "command"}], "replace_from": 1}
```

- It answers **only when `text` starts with `/`** — `if not text.startswith("/"): return {"items": []}`
  (`:282-283`). The trigger condition is the server's, not ours to guess at.
- `kind` is `'command'` or `'skill'` (`:308`): skills are offered by the same call and are insertable
  exactly like commands.
- `replace_from` is the splice index, computed as `text.rfind(" ") + 1 if " " in text else 1` (`:331`)
  — **from the END of the string.**
- `text == "/"` is the browse case (`:322`, `browsing=text == "/"`) and returns the ranked whole
  list, which is exactly "all the commands that can be inserted".
- A draft starting with `/` that has an argument (`/model gpt`) takes the second branch (`:313-324`) and
  completes **the argument** instead. That is the two-stage flow the feature gets for free.

### No new socket, no new dependency

`createDashboardBackend` already keeps one lazily-opened shared socket for RPC
(`src/api/backend.ts:203-215`, `shared()`, currently serving avatar fetches) exposing
`rpc<T>(method, params)` (`src/api/dashboard.ts:206`). Add one facade method beside the existing ones
and reach `complete.slash` through `shared()` — it is a WS method with no HTTP route
(`complete.*` lives in `methods_complete.py`; the web routers do not mount it).

### Rails

- **Debounce, and last-write-wins.** Typing `/he` fires three queries; a slower earlier answer must
  never overwrite a later one. Keep a monotonic sequence and drop stale results.
- **Show the menu only when the caret is at the end of the text** (`onSelectionChange`;
  `selection.end === draft.length`). `replace_from` is computed from the string's end, so a caret parked
  mid-text would splice into the wrong place — hiding the menu is the honest behaviour, and it is the
  TUI's own assumption.
- **Tap inserts; it does not send.** `draft = draft.slice(0, replace_from) + item.text`, then re-query
  with the new text, so a command with an argument stage (`/model `) completes its argument next. If the
  re-query returns nothing, close the menu.
- **Dismiss** on send, on blur, on backspacing past the `/`, and whenever the text no longer starts with
  `/`.
- **Placement:** in the flow directly above the composer row, inside the container R8 lifts
  (`app/thread/[id].tsx:567`, §8) — a plain view, **not** a `Modal`, so it has no keyboard math of its
  own. It has to move with the composer: on Android the KAV itself no longer moves (§8).
- **A backend that cannot answer closes the menu. Silent, non-blocking.** A completion request must
  never hold, block or slow typing, and must never surface an error the user did not ask for.
- Strings for the list's own rows (empty / loading / group labels) go in **both** tables — the
  both-tables rule, §10.8.

---

## §6 — R6: a command has to run, or the menu hands out dead text

the user chose **approach A** (2026-10-13). This is the half that makes R5 worth building.

**`prompt.submit` has no slash handling at all.** The word "slash" does not occur once in
`tui_gateway/methods_prompt.py`, and nothing downstream of it parses a leading `/`. Slash commands are
dispatched by separate, **client-called** RPCs — `slash.exec` (`tui_gateway/methods_tools.py:1113`) and
`command.dispatch` (`:1093`, over the table `_SLASH_BUILTINS` at `:1086-1091`) — and that file states
the contract in as many words: *"Recognized skills keep the 4018 gate so clients command.dispatch."*
The messaging gateway agrees by construction: `gateway/slash_commands.py` is a **per-surface ingress
interception**, not something the agent does with a prompt.

So without R6, tapping `/help` and pressing send submits the literal string `/help` as a prompt. A menu
that inserts commands which do not run is worse than no menu.

### Approach A — run it, show it in the card that already exists

Inside `send()` (`app/thread/[id].tsx:327-350`), when the trimmed draft starts with `/`: **do not open a
stream.** Call the command and put what it returns in the **existing** dismissible notice card
(`:638-641`, the `attachNote` slot the attachment refusals already use).

- **No new `ThreadItem` kind.** The union is only `message | tools | reasoning`
  (`src/logic/thread.ts:52-53`); a fourth kind is a separate, larger change — that is approach B, and it
  is declined here, not forgotten (§15).
- **Route:** `slash.exec` first. If it refuses with the documented `4018` for a skill, retry once via
  `command.dispatch`. (`slash.exec` already routes pending-input commands and bundles to
  `command.dispatch` itself — `:1132-1137` — so the retry exists only for the skill path.)
- **A failed command says so.** The draft is cleared and the card carries the outcome either way;
  nothing may vanish silently.
- **`command.dispatch` payloads are command-specific and are not always `{ output }`.** Render `output`
  when it is there, otherwise the error / `_exec_out` text. Do not invent a renderer per command.

### Rule R6.a — the guard keeps its job

`if ((!text && !staged.length) || streaming || !sessionId) return;` (`:329`) still runs first. Command
interception slots in **after** it. A command sent together with a staged attachment is out of scope:
send the file first.

### Rule R6.b — a command turn opens no stream

No `chatStream`, therefore no `setStreaming(true)`, no `live` bubble, no pending ref. Use the notice
affordance that already exists. A command must not leave the composer disabled behind a stream that was
never started.

### Rule R6.c — the limitation, stated rather than papered over

Approach A's output is **transient**: it lives in a card, not in the transcript. It does not survive a
thread refresh and does not scroll with the conversation. Commands that need a UI — `/model`-style
pickers, approval flows, the pager — are out of scope; their **text** appears in the card and nothing
more. Approach B (a real row) is what fixes persistence, and it is declined for this build.

### Rule R6.d — only the first token counts

A `/` mid-sentence is a literal character: the server's own gate (`complete.slash:282`) answers nothing
for it, and `prompt.submit` carries it as text. Do not invent a second rule.

---

## §7 — R7: the thread has to watch its own session

the user, verbatim: *"your responses and reasoning should show up on the conversation in real-time, it
should not need a refresh from the user (exist session and come back in)"*. Three defects, one symptom.

### R7.a — nothing is subscribed, so only a fresh mount can show news

The gateway routes events to the **session's transport**. A socket receives a session's frames only if it
has attached to that session.

- The attach RPC is `session.activate` (`tui_gateway/methods_session.py:1166`); its contract reads
  *"Attach the frontend to a live session without closing the previously focused one"*
  (`contracts/sessions.py:215`), and its params are `{session_id, cols, omit_messages}` (`:210-213`) —
  `omit_messages: true` skips the DB history read.
- The handler ends in `_rebind_live_transport(sid, session, current_transport() or _stdio_transport)`, so
  **the attaching transport is the socket the request arrived on**: the socket you call it from is the
  socket that starts receiving the session.
- Attach is **additive by construction**. `_rebind_live_transport`'s own docstring: *"Attach a live peer
  without displacing existing subscribers"* (`session_lifecycle.py:830-833`), implemented by
  `_attach_session_transport` → `FanoutTransport(existing, transport)` (`session_transports.py:71-103`).
  Ownership is not enforced — a second login is logged, never refused (`_warn_foreign_login`, `:59-68`).
- **The app never calls it.** The thread screen's only socket is created inside `chatStream` at send time
  (`src/api/backend.ts:452`) and closed when the turn ends (`:443`). Its mount effect only reads history
  (`app/thread/[id].tsx:196-199` → `loadThread()`). A turn started anywhere else — desktop, TUI, another
  device — has **no listener on this device at all**, and the only path to its content is a fresh mount
  re-reading the DB. That is literally "exit the session and come back in".

### R7.b — `reasoning.delta` is emitted, then dropped

The gateway emits the model's live reasoning as `reasoning.delta` (`agent_callbacks.py:135-138`, wired as
`reasoning_callback` at `:165`), gated by `_session_show_reasoning(sid)` (`server.py:2136-2141` — a session
flag, else the config default; *"Missing means the config default, not hidden"*), and that gate is a tested
server fact (`tests/tui_gateway/test_show_reasoning_display_gate.py:42`).

`chatStream`'s switch handles five types — `message.delta`, `message.complete`, `tool.start`,
`tool.complete`, `turn.error` — with `default: break` (`src/api/backend.ts:457-506`). The wire carries
about two dozen more (`message.start`, `message.interim`, `tool.generating`, `reasoning.delta`,
`reasoning.available`, `notification.show`, `status.update`, `session.usage`, …). So reasoning is never
painted live and appears only from the stored transcript after re-entry — the second half of the user's
sentence.

Not every dropped type is a defect. `thinking.delta` (`agent_callbacks.py:117-125`) carries *wait notices
and the quiet spinner*, with a comment saying outright they are not reasoning blocks. Leave it dropped
(§15).

### R7.c — a dropped socket is reported as a finished turn

`chatStream` wires `onClose: () => finish(false)` (`:453`) — `aborted: false` — and `sawCompletion` is
computed and then thrown away (`void sawCompletion`, `:507`). The comment above it promises the caller is
told "never silently"; the value is discarded instead. A mid-turn disconnect therefore paints a truncated
reply as a normal end of turn.

### The fix — one subscription on the socket the app already opens

- **One socket per mounted thread screen.** A facade method beside the existing ones (`shared()` +
  `rpc<T>`, `src/api/backend.ts:203-215`, `src/api/dashboard.ts:206`): attach with
  `session.activate {session_id, omit_messages: true}`, then register **typed listeners on that same
  socket** (`socket.on(type, handler)` — the registry at `dashboard.ts:371-379`) and return an
  unsubscribe.
- **Filter on the session id.** `GatewayEvent` already carries `sessionId` and `seq`
  (`dashboard.ts:179-184`, parsed at `:371-376`); every handler ignores a frame whose `sessionId` is not
  the watched one.
- **Route frames through the same handlers `chatStream` already uses** (delta / tool / final), so a turn
  started elsewhere streams into the bubble and tool rows this screen already renders.
- **`case 'reasoning.delta'` → the live reasoning block,** rendered with the existing `reasoning` item
  kind (`src/logic/thread.ts:52-53`). **No client-side gate:** the server emits it only when the session
  displays reasoning.
- **`prompt.submit` rides the same socket.** The per-turn socket is folded in rather than run alongside:
  `send()` submits on the subscribed socket and the stop control calls `session.interrupt` on it. The
  returned handle keeps its `{close}` shape, so the screen's cancel path is unchanged.
- **Focus-scoped.** Attach on focus, detach on blur (`useFocusEffect`) — not only on unmount. A hidden
  thread must not keep a session pinned in the gateway (§R7.d), and returning must re-attach, which is
  what makes the catch-up below pay off. The existing unmount cleanup (`[id].tsx:201-207`,
  `handleRef.current?.close(); backend.dispose()`) stays; `dispose()` closes the socket
  (`src/api/backend.ts:544-552`).
- **Catch up on (re)connect.** Track the highest `seq` seen; on a socket (re)open call
  `session.events.since {session_id, last_seen}` → `{events, latest_seq, truncated, count, epoch,
  open_requests}` (`methods_session.py:2334-2348`):
  - `truncated: true` (past the ring window) → **refetch the thread**; never stitch a holey replay.
  - `epoch` differs from the `replay_epoch` carried by the connection's own `gateway.ready` frame → the
    gateway restarted: reset the watermark and refetch. That frame is the first one of every connection
    (`ws.py:367`; payload `{skin, change_events, heartbeat, replay_epoch}`, schema
    `contracts/events.py:51-61`) and the app drops it today with the rest of the unknown types — capture
    it. `replay_epoch()` is *"an opaque token identifying this server process's seq numbering"*
    (`event_replay.py:48-50`).
  - `open_requests` are server→client requests still unanswered (a question still waiting, which the ring
    cannot carry) → re-deliver them to the request handlers.
- **Attach can fail transiently, and that is not an error card.** `_reattach_refusal`
  (`session_lifecycle.py:819-827`) answers `4007 "session no longer live; retry resume"` and
  `4009 "session disconnect interrupt settling"`. On `4007`, fall back to `session.resume` with the same
  params (`contracts/sessions.py:202` — *"reuse it if live here, else lazy / deferred / cold / eager
  rebuild"*); on `4009`, retry once after a short delay; on anything else, `loadThread()` and leave the
  thread readable without a subscription. A watcher that cannot attach must not look broken.

**Rule R7.d — the watcher must not become a keeper by accident.** While the phone is attached its
transport counts as a live peer, and `_detach_session_transport` returns *"whether another live client
prevents parking"* (`session_transports.py:106-121`). Two consequences, both the server's existing policy,
neither of them new: a session watched by the phone is **not parked** when the desktop closes (the
fan-out's whole purpose), and when the phone's socket dies with **no other live client** the session is
parked and torn down after the WS-orphan grace (`_schedule_ws_orphan_reap`, `session_lifecycle.py:878+`;
default `20 s`, `server.py:139-146`). That is exactly why the subscription is focus-scoped and always
cleanly dropped.

**Rule R7.e — `send()` is where three items meet.** The guard (§R6.a) runs first, then the `/`
interception (§R6), then the wire text is composed (§R1 — caption plus refs, and it is the *wire* text,
not the caption, that travels), and only then is that text submitted on the subscribed socket (§R7). R1
owns the payload, R7 owns the call, R6 owns the interception. None of the three may quietly replace
another: a build that submits the caption instead of the composed wire text has R1 undone, and a build
that opens a stream for a `/` command has R6 undone.

**Rule R7.f — no server change here either.** Attach, park, reap and the replay ring are read, cited and
left alone. The client is the side that was missing.

---

## §8 — R8: the keyboard has to lift the composer

the user, verbatim: *"when clicking the message field, and the system keyboard opens, raise the message field
above the keyboard, so the user can see what they're typing."*

### What is there today

`KeyboardAvoidingView` wraps the whole screen (`app/thread/[id].tsx:567`) with
`behavior={Platform.OS === 'ios' ? 'padding' : 'height'}` and
`keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}` (`:572-573`), carrying a 0.9.0 comment that
Android "needs `height`, not nothing". The composer row is that view's last child
(`<View style={[styles.composer, sidePad]}>`, `:673`; `TextInput` `:683-691`), and `styles.screen` is
`flex: 1` (`:800`).

### Diagnosis

The app is RN `0.86.3` / Expo `57` (`package.json`) — the edge-to-edge era, where the Android window no
longer resizes under the keyboard, so `behavior="height"` has nothing solid left to subtract against.
`app.json`'s `android` block is package/versionCode/adaptiveIcon/permissions only: neither
`softwareKeyboardLayoutMode` nor any edge-to-edge opt-out is set. The iOS branch is fine and stays.

**An honest limit on this one: it cannot be reproduced without a device.** It ships as a *candidate* with a
device check (§14), never as "fixed, verified" off a build log.

### Fix — dependency-free, one file

Stop asking KAV to do Android's job:

- keep `KeyboardAvoidingView` for iOS (`padding` + the existing offset), and give Android no KAV behaviour
  at all — the padding below does the work, and two spacers fighting is the classic double-gap bug;
- on Android, take the lift from the keyboard's own report: `Keyboard.addListener('keyboardDidShow' /
  'keyboardDidHide')`, height from `endCoordinates.height` (`Keyboard.metrics()` if that is unavailable),
  held in component state;
- apply it as `paddingBottom` on the composer row, floored at the safe-area inset the screen already reads
  (`useSafeAreaInsets`, `:23`, `:135`), so the composer is never left floating or below the gesture bar;
- reset to the inset on hide;
- **do not add `insets.bottom` on top of a non-zero keyboard height** — the Android keyboard's reported
  height already includes the navigation bar.

**No new dependency.** `react-native-keyboard-controller` is the usual answer for this and it is declined
(§15): this batch's dependency budget is the two Expo SDK pickers (§10.3), and the fix above is a listener
and a padding.

**The `/` menu rides the same lift.** R5 places the menu inside `KeyboardAvoidingView` (§5); it must end up
inside the *lifted* container, not in the KAV that no longer moves on Android. A command menu that stays
behind the keyboard is worse than no menu at all.

---

## §9 — Half A: the 0.10.1 review fixes, by reference

`GOAL-0.10.1.md` §S1–S9 — the nine review points, eight items, plus the S9 record item — is executed in
this same unit, **byte-for-byte as written there**. It is not summarised here on purpose: two copies of
a spec is one copy that drifts.

Two mechanical reconciliations, and nothing else:

1. **Version identity.** Its §9 target (`versionName 0.10.1` / `versionCode 13`) becomes `0.11.0` /
   `14`. Both version edits happen **once**, for the single build, in `app.json:5` and `:21`.
2. **Verification scripts.** Its `logs/verify-0.10.1.sh` / `red-0.10.1.sh` name a version that will
   never exist. Both are **renamed and merged** into this batch's single pair (§14). The red lane keeps
   every one of its `-S1.txt … -S8.txt` falsifications, unchanged, under the new name.

Everything else about Half A — the items, the anchors, the traps it names (the lost ordering assertion
at `tests/run.ts:5428/:5432/:5433`, the `typeNoneWarning` last-position guard, the two `saved` decoys,
the orphaned imports) — stands as written.

---

## §10 — Invariant rules for this batch

1. **No server change.** Not in Half A, not in R1–R8. The gateway's attach and command surfaces are read,
   cited and left alone.
2. **No new screen.** The picker rows go in the sheet that exists; the mic setting goes on a page that
   exists; the composer gains no new bar (the recording bar exists at `app/thread/[id].tsx:624`), and the
   `/` menu is an overlay inside the composer's own view — not a screen, not a `Modal`.
3. **Two new native dependencies, both from the Expo SDK** (`expo-document-picker`,
   `expo-image-picker`), plus one **declaration** of an installed package (`expo-file-system`).
   Anything else is out of scope and stops the run.
4. **One staging path.** Every new source produces a `stage()` input (`attachments.ts:81`). No direct
   `setStaged` for a picked file or photo — the voice path's direct append is the one legacy copy of
   this rule and is not a precedent to extend.
5. **One read implementation** for phone-side bytes (`expo-file-system`'s `File`), shared by voice and
   by the picker.
6. **The wire carries the refs; the screen carries the words.** No user-visible `@file:` ref in a
   composer, a bubble or a label.
7. **Nothing that exists stops working.** The camera, the clipboard, the strip, `unstage`, the 25 MB
   refusal, the inbound voice player (`voiceNoteOf`, `:127`), the checkpoints and Half A's nine fixes
   are all in the regression surface.
8. **Both tables or neither.** Every new string lands in EN and PT (`src/i18n.ts`).
9. **An anchored claim is checked, not repeated.** Where this brief names a line, a run that finds it
   moved reports the move instead of editing around it.
10. **R5 and R6 add no dependency and no socket.** The completer and the command dispatch ride the
   socket the app already opens (`shared()`, `src/api/backend.ts:212-215`). A second connection for
   either is a bug, and no new package may appear in `package.json` for them.
11. **One socket per mounted thread screen.** The subscription (§R7), the turn submit (§R7), the
   completer (§R5) and the command dispatch (§R6) all ride the same dashboard socket; a second
   connection for any of them is a bug. Rule 10 is this same rule for Half B alone.
12. **The subscription is focus-scoped and always dropped.** A thread that is not on screen must not
   hold its session live in the gateway (§R7.d).
13. **No polling.** A live thread is never refreshed on a timer: the gateway pushes, and
   `session.events.since` is the only catch-up path — event-driven, on reconnect.
14. **Half C is revertable alone.** Its hunks stay inside `src/api/backend.ts` (streaming),
   `app/thread/[id].tsx` (live wiring and the keyboard lift) and its own test block; nothing in
   Half A or Half B depends on them, and it stores nothing new.

---

## §11 — Anchors (verified on this baseline, 2026-10-13)

| What | Where |
| --- | --- |
| `send()` guard + attach loop + discard | `app/thread/[id].tsx:328-350`, `:342-343` |
| `pendingRef` / live bubble text | `:353`, `:357`, `:521` |
| stream call (takes the wire text) | `:360-393` |
| staged strip | `:644-671` |
| mic Pressable / glyph / send-button glyph | `:694-697`, `:705`, `:714` |
| picker rows / `labelOf` chain | `:726-736`, `:737-742` |
| recorder + voice state | `:143-149`, `:154-156`, `:240-246`, `:247`, `:264-301` |
| `updateSlide` imported, never called | `:68` |
| no `useSettings` import | `:109-114` |
| `attachImage` / `attachFile` (`refText`) | `src/api/backend.ts:333-342`, `:349-362` |
| staging: limit, kind, base64, size, door | `src/logic/attachments.ts:36,41,55,68,81,105,113,141,209` |
| voice machine and constants | `src/logic/voice.ts:31,47,50,57,66,93,102,109,127,145` |
| strings: attach / voice / dead `sending` | `src/i18n.ts:207-238` (`sending` `:235`, PT `:1054`), `EN_ONLY_SETTINGS_KEYS:804-816` |
| settings shape + store | `src/settings.ts:72,138,142`, `src/settingsStore.ts:39,108` |
| settings context | `src/SettingsContext.tsx:26,85` |
| page plan / scope lists / row scope | `src/settingsPages.ts` (`PORTABLE_SETTING_IDS`, `DEVICE_LOCAL_SETTING_IDS`, `scopeOfSetting`, `SETTINGS_PAGE_ROWS`) |
| agent page block end | `app/settings.tsx:1011`, `:1013` |
| version identity | `app.json:5`, `app.json:21` |
| plugin registration pattern | `app.json:36-39` (`expo-audio`), `:61-66` (`expo-camera`) |
| **server** `file.attach` | `tui_gateway/methods_prompt.py:1030-1050` |
| **server** `image.attach_bytes` + queue | `tui_gateway/methods_prompt.py:941-969`, `prompt_attachments.py:137-159` |
| **server** image queue consumed / cleared | `compute_host_bridge.py:57`, `:304` |
| composer `TextInput` (no ref, no selection tracking) | `app/thread/[id].tsx:683-691` |
| `KeyboardAvoidingView` (the menu's container) | `:567` |
| notice card / `setAttachNote` slot (R6's output) | `:638-641` |
| `ThreadItem` union — only 3 kinds | `src/logic/thread.ts:40,52-53` |
| shared socket + `rpc<T>` | `src/api/backend.ts:203-215`, `src/api/dashboard.ts:206` |
| **server** `complete.slash` (items + `replace_from`) | `tui_gateway/methods_complete.py:278-331` |
| **server** `slash.exec` / `command.dispatch` / builtin table | `methods_tools.py:1113`, `:1093`, `:1086-1091` |
| **server** no slash parsing in `prompt.submit` | `methods_prompt.py` (zero occurrences of "slash") |
| 0.9.0 voice tests / attachment tests | `tests/run.ts:4071-4172` (H), `:4174+` (G) |
| `GatewayEvent` carries `sessionId` + `seq` | `src/api/dashboard.ts:179-184`, `:371-376` |
| socket listener registry (`on(type, …)`) | `src/api/dashboard.ts:378` |
| per-screen backend instance + `dispose()` | `src/useBackend.ts:21-24`, `src/api/backend.ts:544-552` |
| thread mount / unmount effects | `app/thread/[id].tsx:196-199`, `:201-207` |
| composer row / KAV props / insets | `:673`, `:567`, `:572-573`, `:23`, `:135` |
| `reasoning` item kind (R7's live block) | `src/logic/thread.ts:52-53` |
| **server** `session.activate` (fan-out attach) | `tui_gateway/methods_session.py:1166`, `contracts/sessions.py:210-215` |
| **server** `_rebind_live_transport` / `_attach_session_transport` | `session_lifecycle.py:830-833`, `session_transports.py:71-103` |
| **server** reattach refusals (`4007` / `4009`) | `session_lifecycle.py:819-827` |
| **server** `session.events.since` + replay fields | `methods_session.py:2334-2348` |
| **server** `gateway.ready` (carries `replay_epoch`) | `contracts/events.py:51-61`, `ws.py:367`, `event_replay.py:48-50` |
| **server** orphan-reap policy + grace | `session_lifecycle.py:878+`, `server.py:139-146` |
| **server** `reasoning.delta` / `thinking.delta` | `agent_callbacks.py:135-138`, `:117-125` |
| **server** reasoning display gate | `server.py:2136-2141` |
| **server** `SessionResumeParams` (R7's fallback) | `contracts/sessions.py:202` |

---

## §12 — Tests

Add, in the existing blocks' idiom (`tests/run.ts`):

- **R1 — the ref travels.** A source-level assertion that a non-image attach's returned `refText`
  reaches the submitted text, and a unit assertion that caption + refs compose with an empty caption
  dropping out and the ref surviving. Plus: the wire text is what is streamed, and the **display**
  text is not the wire text (the ref never appears in `live.user`).
- **R1 — the dead string is alive.** `t.thread.voice.sending` is referenced by the composer (it is
  currently referenced nowhere — assert the reference, and that it is non-empty in EN and PT).
- **R2 — the picker exists and the disabled row is gone.** `expo-document-picker` and
  `expo-image-picker` are declared in `package.json`; the `document` entry is no longer `disabled` and
  no longer carries `reason`; a photo-library entry exists. A picked doc/photo becomes a `stage()`
  input, and an over-limit one is refused **before** its bytes are read.
- **R2 — `labelOf` cannot mislabel.** Every entry resolves its own label (no positional fallback).
- **R3 — the setting exists, is device-local, and defaults to tap.** `Settings` carries it;
  `DEFAULT_SETTINGS` has it; it is in `DEVICE_LOCAL_SETTING_IDS`; `scopeOfSetting(id)` returns
  `'device-local'`; the Agent Preferences row's scope is `'mixed'` and its help names the exception.
- **R3 — the icon follows the gesture.** In tap mode a recording exists → the button is a stop; in
  hold mode it is not. The stop control ends the recording; the cancel control discards it and nothing
  is sent.
- **R3 — the slide is no longer dead.** `updateSlide` has a caller, and a slide past `CANCEL_DX` on
  release cancels instead of sending (`releaseRecording` already returns that outcome — assert the
  wiring, not the arithmetic).
- **R3 — stopping sends.** A completed recording reaches the send path without a second gesture.
- **R4 — the declaration.** `expo-file-system` is a declared dependency at the version installed.
- **R5 — the menu is the server's list.** `complete.slash` is called with the draft text and the
  session id through the **shared** socket (no second connection is opened); a response's `items` render
  as rows; tapping one splices at `replace_from` and re-queries. A stale (earlier) response arriving
  after a newer one does not overwrite it. The menu is offered only with the caret at the end of the
  text, and a draft that does not start with `/` produces no request at all.
- **R6 — the command runs, and the stream does not.** A draft starting with `/` calls `slash.exec` and
  **never** `chatStream`; a `4018` skill refusal is retried once through `command.dispatch`; the returned
  text lands in the notice card; a failure is reported rather than swallowed; `streaming` is never set
  by a command turn, and the composer is not left disabled.
- **R6 — a mid-sentence `/` is text.** A draft with a `/` that is not the first token is submitted as an
  ordinary prompt — no command call, no card.
- **R7 — the thread subscribes to its own session.** On focus the screen attaches with
  `session.activate {session_id, omit_messages: true}` **on the socket it sends on**, registers
  listeners, and detaches on blur; a frame whose `sessionId` is a different session is ignored; the
  thread opens exactly one socket (no second `client.connect` on the thread path — §10.11).
- **R7 — reasoning paints live.** A `reasoning.delta` for the watched session produces the live
  reasoning block; `thinking.delta` does not (status channel, §15); a `reasoning.delta` for another
  session id changes nothing.
- **R7 — catch-up, and no holey replay.** `latest_seq` is tracked; a reconnect calls
  `session.events.since` with the last seen seq; `truncated: true` causes a refetch instead of
  applying the replay; a changed `epoch` resets the watermark and refetches.
- **R7 — an incomplete turn is not a success.** A socket close without `message.complete` reports
  `aborted: true`; the `sawCompletion` value is used, never discarded.
- **R7 — a failed attach is not an error.** `4007` falls back to `session.resume`; `4009` retries
  once; any other failure still leaves the thread readable.
- **R7 with R1 and R6 — the order inside `send()`.** The composed wire text (caption + refs) is what
  reaches `prompt.submit`; a `/`-leading draft never opens a stream; a command does not clear a
  staged attachment (§R7.e).
- **R8 — Android is off KAV `height`.** The Android branch no longer passes `behavior="height"`; a
  `keyboardDidShow` / `keyboardDidHide` subscription exists and is removed on unmount; the composer's
  `paddingBottom` is floored at the safe-area inset; `react-native-keyboard-controller` is **absent**
  from `package.json`; the iOS branch still passes `padding` plus its offset.
- **Regression:** the 0.9.0 H block (`:4071-4172`) and the 0.9.0 G block (`:4174+`) plus Half A's own
  checks must be green. **The source assertion at `:4124` pins the `attachFile` call's exact argument
  list** — `await backend.attachFile(sessionId, item.dataUrl, item.name, profile)`. It is a substring
  match, so capturing the return for R1 keeps it green **as long as those arguments do not change**;
  changing them is the rewrite being wrong, not the assertion.

---

## §13 — Identity and build

- `versionName 0.11.0`, `versionCode 14` (`app.json:5`, `app.json:21`), `package.json` version
  followed for consistency.
- Signed with the same release keystore as 0.1.0–0.10.0 — an APK that cannot install over 0.10.0 is a
  failed build, and `app.json`'s `versionCode` is the only thing that makes the install an upgrade
  rather than a refusal.
- Android artifact: `dist/personae-0.11.0.apk`, size and sha256 recorded in the verify log.
- iOS: **no binary.** The two new plugins are registered in `app.json` so the config is correct for a
  later EAS build; nothing here requires a Mac.

---

## §14 — Verification

One pair of scripts for the one build, replacing Half A's:

- `logs/verify-0.11.0.sh` → `logs/verify-0.11.0.txt`. Real assertions over real bytes: the APK's
  `versionName`/`versionCode`/package/signer via `aapt`/`apksigner`, the presence of the two new SDK
  packages in the bundle, the ABSENCE of a `disabled` document row, and the suite's own exit code.
  **A verifier that cannot go red is not a verifier** — the same hard floor and `exit $fail` discipline
  Half A's script was specced with.
- `logs/red-0.11.0.sh` → `logs/red-0.11.0-S1.txt … -S8.txt` (Half A's falsifications, renamed,
  unchanged) and `-R1.txt … -R8.txt` (this batch's): each one breaks exactly one claim and proves the
  corresponding check fails.

Do not trust a PASS line that was not produced by the script in `logs/`. The 0.10.0 cycle's lesson
stands: the artifact is inspected independently of the implementer's summary.

**One item cannot be verified by script: R8's keyboard lift.** The log carries it as its own line —
`MANUAL: R8 keyboard lift — awaiting device confirmation` — and that line is never written as PASS.
What the script *can* assert about R8 is its shape (§12): the Android branch is off KAV `height`, the
keyboard listener exists and is removed on unmount, the lift is applied with an inset floor, and no
keyboard library entered `package.json`.

---

## §15 — Out of scope

- No server-side change to the attach methods, and no attempt to make `file.attach` queue like
  `image.attach_bytes` — the client-side ref is the fix, and it is the TUI's own convention.
- No new picker source beyond the two chosen, no share-sheet/drag-in target, no in-app file browser.
- No change to the camera capture path beyond keeping it working.
- No rewrite of `parseMessageContent` / the inbound voice player.
- No third mic mode, no per-conversation override, no voice-activity auto-stop.
- **The session-open scroll is left exactly as it is.** the user, 2026-10-13: *"If it already auto-scrolls,
  you can leave it."* `onContentSizeChange` → `scrollToEnd` (`app/thread/[id].tsx:609`) is untouched,
  and **the second half of his report is therefore still open**: that scroll is unconditional, so
  scrolling up to read during a live turn is still pulled back down on the next delta. One `useRef`
  at-bottom guard closes it when he asks — not in this build.
- **No command output as a thread row** (approach B, declined), and no command pager, `/model`-style
  picker or approval UI (§R6.c).
- **No keyboard library.** `react-native-keyboard-controller` (or any other) is not added for R8 —
  two Expo SDK pickers are already this batch's dependency budget (§10.3).
- **No polling and no timer refresh of a live thread** (§10.13), and no second socket for a
  subscription (§10.11).
- **No rendering of `thinking.delta`** — it is the status/diagnostic channel (wait notices, the quiet
  spinner), not reasoning (`agent_callbacks.py:117-125`).
- **No change to the gateway's attach, park or reap policy**, and no attempt to make the mobile
  client a privileged viewer (§R7.d, §R7.f).
- **No `@` mention completion.** The `@`/context completer is a different method (`complete.path`,
  `methods_complete.py:233`); R5 reaches only `complete.slash`. It is the obvious next step and is not
  this one.
- `GOAL-0.10.1.md` is executed as written — **its items are not reopened.**

---

## §16 — Decisions taken here, overridable

Asked for and confirmed by the user: the setting (§R3), both pickers (§R2), one build (§0).

Taken by me, each trivially reversible if he disagrees — say so and it changes:

1. **Default mic mode is `tap`,** not `hold` (§R3): the requested behaviour, and a tap in `hold` mode
   is a sub-second refusal, so a default of `hold` hides the feature behind its own setting.
2. **Stopping sends, in both modes** (§R3.b): no staged voice note. The strip stays for images and
   files, where pick-then-send is genuinely two acts.
3. **The mic setting lives on Agent Preferences,** which forces that row's scope chip to `'mixed'`
   (§R3) — the alternative is a new page for one control, which §10.2 rules out.
4. **`expo-file-system` is declared, not replaced** (§R4): removing the dynamic import would be a
   larger change than the bug it guards against.
5. **The hold mode's slide-to-cancel is wired rather than deleted** (§R3.a): the logic is finished and
   only the input handler is missing.
6. **The `/` menu is gated on the caret being at the end of the draft** (§R5): `replace_from` is
   computed from the string's end, so hiding the menu is correct where splicing would be a guess.
7. **A tapped command re-queries instead of closing** (§R5): that is what surfaces a command's argument
   stage, which the server already implements.
8. **R6 shows output in the notice card, not a new row kind** (§R6) — **confirmed by the user as approach
   A.** The cost is persistence, and it is stated as a limitation (§R6.c) rather than hidden.
9. **R5/R6 add no dependency and no socket** (§10.11): the completer and the dispatch ride the socket the
   app already opens.
10. **The per-turn socket is folded into the subscribed one** (§R7): one socket per mounted thread
    screen instead of a second connection beside the existing one. Smaller surface, and it makes
    catch-up a single watermark rather than two.
11. **The subscription is focus-scoped** (§R7, §10.12): attach on focus, detach on blur, so a hidden
    thread cannot keep a session alive in the gateway.
12. **Android gets explicit keyboard padding instead of KAV `height`** (§8), dependency-free; the iOS
    branch is untouched.
13. **Half C is one build with the rest, confirmed by the user** (§0) — and R8 is reported as a candidate
    with a device check, not as verified (§14).

---

## Verbatim, the user, 2026-10-13

> Sending a file does not work yet, let's implement that
>
> The voice message is not working. The recording is happening, but it's not being sent through.
>
> When the user clicks on the microphone and starts recording, change the microphone button into a stop icon.

And on the three questions:

> Add as an option in settings for the user to choose. *(mic behaviour)*
>
> Any file + the photo library (adds expo-document-picker + expo-image-picker) *(paperclip sources)*
>
> Option A, but don't build yet. *(one build, 0.11.0)*

And on the two later items, same session:

> When opening a session, scroll to the bottom. If the user manually scrolled up, keep the position.
>
> When typing in the message box, if the user inserts a "/", show a list of all the commands that can be inserted. If they click on one, insert it into the field.

> If it already auto-scrolls, you can leave it. *(the scroll item — closed as already-implemented)*
>
> For the slash part, go with approach A. *(menu + execution, not text only)*

And on the two bugs reported the same day, still open:

> your responses and reasoning should show up on the conversation in real-time, it should not need a refresh from the user (exist session and come back in)
>
> when clicking the message field, and the system keyboard opens, raise the message field above the keyboard, so the user can see what they're typing.

And the packaging decision that closed them:

> Both into 0.11.0 as a separable Half C (one build, one install; revertable alone if the device check fails)
