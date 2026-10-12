# RECON 0.9.0 — measure before assuming

Every entry is a question, the command that was RUN, and the output that was OBSERVED on this host,
2026-10-12. No entry here is inferred from a README or from another release's notes. Where a question
could not be settled, it says so and says why (there is no `adb` on either host — 0.8.0 measured that,
and it is why nothing in 0.8.0 was ever verified on a phone).

Paths are absolute where they leave the repo. `$H` = `~/.hermes/hermes-agent`.

---

## 1. How does an outbound message leave the app today?

**Command**

```
grep -n 'chatStream' src/api/backend.ts
```

**Observed** — two implementations, one per surface, both text-only:

* dashboard (`backend.ts:263-348`): `client.connect({...})` then
  `await live.rpc('prompt.submit', { session_id: sessionId, text, ...(profile ? { profile } : {}) })`
  — a **JSON-RPC call over the `/api/ws` socket**, one string field.
* legacy (`backend.ts:462`): `api.chatStream(...)` → the `:9222` REST/SSE path, same single `text`.

**Command**

```
grep -n 'prompt.submit' $H/tui_gateway/methods_prompt.py
```

**Observed** — `657:@method("prompt.submit")`. The handler reads `params.get("text")`, sanitises it
with `sanitize_user_prompt_text`, honours `display_kind`, `title_preview`, `interrupted`, `surface`,
`voice_context` and the truncation params. **There is no `attachments` parameter**: a prompt is text,
and an attachment reaches the turn through a *separate RPC* (see §2).

**Conclusion.** Text-only, one string, over the WS RPC the app already speaks. No REST POST.

---

## 2. Does a message carry attachments on the wire? — **THE FINDING THAT DECIDES ITEMS 8 AND 9**

**Command**

```
grep -n '@method' $H/tui_gateway/methods_prompt.py
```

**Observed**

```
657:@method("prompt.submit")
797:@method("clipboard.paste")
821:@method("image.attach")
849:@method("image.attach_bytes")
880:@method("pdf.attach")
938:@method("file.attach")
961:@method("image.detach")
976:@method("input.detect_drop")
1002:@method("prompt.background")
...
```

Three of these exist **specifically for a remote client**:

* `image.attach_bytes` (`:849-877`) — docstring, verbatim: *"Attach an image from base64 bytes (remote
  client); reply mirrors `image.attach`. `filename`/`ext` hint the extension, else magic bytes decide
  (fallback `.png`)."* It queues into `session["attached_images"]` and returns
  `{attached, path, count, ..., text: "[User attached image: <name>]"}`.
* `file.attach` (`:938-959`) — docstring: *"Stage a non-image file into the session workspace; returns a
  workspace-relative `@file:` ref. `data_url` carries the bytes when `path` isn't gateway-visible."*
  Reply: `{attached, name, path, ref_path, ref_text: "@file:<ref>", uploaded}`.
* `pdf.attach` (`:880-937`) — renders pages to images and queues them.

**Command**

```
sed -n '178,220p' $H/tui_gateway/prompt_attachments.py
```

**Observed** — `_stage_session_file_attachment()`: *"Inside the workspace -> as-is; gateway-visible but
outside -> copied into `attachments/` (bind-mounted into container backends so `@file:` resolves in the
sandbox); not on the gateway -> **`data_url` bytes decoded into `attachments/`**"*, and the decoder is
*"Any media type (unlike the image-specific decoder)"*.

**Do INBOUND messages carry an attachment?** Yes — as content **parts**, not as a dedicated field.

**Command**

```
grep -n -A25 'def _coerce_message_text' $H/tui_gateway/session_history.py
sed -n '130,160p' $H/tui_gateway/session_history.py
```

**Observed** — `message['content']` is `str`, a **parts list**, or one structured dict. An attached image
is a part `{type:'image_url', image_url:{url:'data:image/...;base64,...'}}` beside a text part whose text
ends in `@image:<path>` refs (or the older `[Image attached at: <abs path>]` hint, `_IMAGE_HINT_RE`,
`:131`). `_project_for_display(..., inline_images=True)` — the **default** at
`$H/hermes_cli/web_routers/sessions.py:617` — passes content through untouched, so
`GET /api/sessions/{id}/messages` returns the **data URL inline**. `inline_images=False` is the
kilobyte-saving read, and it projects the same part to `[image]` (`sessions.py:636-645`).

**Conclusion, and this is the single most important line in this document:**

> **There is NO `attachments`/`media`/`files` field on a message. There does not need to be.**
> A message carries an attachment two ways already, both of which the phone can both *produce* and
> *read*:
> * **images** — a `content` parts list with an inline `image_url` data URL (already served to the app
>   by the thread endpoint it already calls), produced by `image.attach_bytes`;
> * **any file** — an `@file:<ref>` / `@image:<path>` text reference, produced by `file.attach`, which
>   is the same convention the TUI's `/image <path>` uses.
>
> **Items 8 and 9 are therefore CLIENT-ONLY work. No server addition, no second upload path.**

---

## 3. What can the server already do?

All measured read-only on 2026-10-12; all Dashboard-surface routes (`:9119`), which is the surface this
app already speaks.

**Command**

```
grep -rn 'api/files/upload-stream\|api/files/upload\|api/chat/image-upload\|api/audio/transcribe\|audio/\|def upload_chat_image\|_MEDIA_CONTENT_TYPES\|_STREAMABLE_MEDIA_EXTENSIONS' $H/hermes_cli/web_routers/{files,audio}.py | head -40
```

**Observed (line numbers as measured)**

| route | where | shape |
|---|---|---|
| `POST /api/files/upload-stream` | `files.py:691-712` (impl `stream_upload_to_path` `:650-689`) | chunked multipart, constant memory, temp-file-then-rename, 413 over the cap |
| `POST /api/files/upload` | `files.py:640-647` | base64 `ManagedFileUpload` |
| `POST /api/chat/image-upload` | `files.py:467+` (cap `_CHAT_IMAGE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024`, `:430`; extension allowlist `:431`) | data-URL images only; writes into `<hermes home>/images/` *"where the embedded TUI can read it"* and drives the TUI's `/image <path>` |
| `GET /api/files/download` / `/api/files/stream` | `files.py:594-616`, `:611-617` | `inline` vs `attachment` disposition; `sec-fetch-dest: audio/video` selects inline, which is *"the route the desktop uses as its player source"* |
| `POST /api/audio/transcribe` | `audio.py:42-53`, `:83` | base64 audio, accepts `audio/*` + `video/webm`, extension map covering `m4a, ogg, opus, wav, webm, mp3, flac, aac` |
| TTS + speak-stream WS | `audio.py` header, `_SPEAK_MIME_BY_EXT` `:51` | server-side speech out |

**Managed-path policy — measured, because it decides whether an upload can land anywhere useful:**

**Command** `grep -n -A35 'def _managed_files_policy' $H/hermes_cli/web_server_files.py`

**Observed** (`:124-138`): the root is **locked** only when `HERMES_DASHBOARD_FILES_ROOT` is set or the
Hermes root *is* `/opt/data`; otherwise `ManagedFilesPolicy(default_path=Path.home(), locked_root=None,
can_change_path=True)`. With `locked_root=None` an absolute path is accepted as-is (`..` is always
rejected, `:155-162`).

**Conclusion.** Reuse these. Do not invent a parallel upload path — and for items 8/9 the app does not
need one at all: the WS RPCs in §2 are the highest-fidelity route (they put the bytes where the *agent*
reads them, not merely where HTTP can serve them back).

---

## 4. How is the plug-in's per-object menu actually shaped?

Read from `~/Projects/hermes-desktop-plugins/personae/plugin.js` (8 975 lines), **not** from the README
table. The README says the table is the *shared* set and each menu offers what fits the thing clicked —
the source confirms that.

**Command** `grep -n 'ContextMenuContent' ~/Projects/hermes-desktop-plugins/personae/plugin.js`
**Observed** — three menu bodies: the session row, the profile row, the group heading.

### Session (plugin.js:4978-5170) — top level, in the user's 2026-10-10 order

| # | entry | kind |
|---|---|---|
| 1 | **Select** | inline verb |
| 2 | **Open** | submenu → *In new window* · *In new tab* |
| 3 | **Session** | submenu → *Mark as unread* · *Rename…* · *Branch* · *Copy id* · *Export…* · *Hide from Personae / Unhide in Personae* · *Archive* · —separator— · *Delete session…* (destructive) |
| 4 | **Apropos (On that topic, beta)** | submenu → *From this session* · *Create group* |
| 5 | **Group** | submenu → *New session group* · *Move to group* ▸ (*<each group>* · *Ungrouped*) |
| 6 | **Appearance** | submenu → the colour picker body |
| 7 | **Assign to project** | submenu → the project picker body |

### Profile (plugin.js:5772-5885)

`New session` · `Edit profile…` · `Open newest session` · `Open all in tabs` · —separator— ·
`Sort sessions` ▸ *(SESSION_SORT_MODES)* · `Show hidden (n)` · `Unhide all (n)`.

### Group heading (plugin.js:6300-6350, via `sessionGroupMenuEntries`)

`Rename…` · `Move up` · `Move down` · `Apropos this group (beta)` / `New child session (beta)` ·
—separator— · `Delete group` (destructive).

**The phone today** (`src/roster/menus.ts`, read directly): profile `:31`, session `:53`, group `:65` —
each a **flat** list, no submenus. So the shape to adopt is *flat verbs plus one-noun submenus*, and the
diff to close is: Apropos, Project, the Open/Session/Group/Appearance submenus, Edit profile…, Open
newest session, Open all in tabs, Show hidden / Unhide all, and the group heading's Move up / Move down.

---

## 5. What actually breaks in landscape?

**Constraint first, restated because it governs every claim below: there is no `adb` on either host**
(`which adb` → empty), and the Pixel 8 is offline, so **none of this was measured on a device**. This
section is a **static audit**; the device claim belongs in the not-verified list of `PROGRESS.md`.

**Command** `grep -rn 'useSafeAreaInsets\|insets\|SafeAreaView' app/ src/`
**Observed** — four call sites only: `app/index.tsx:359`, `app/index.tsx:377` (both `paddingTop:
insets.top`), and `src/roster/components.tsx:472`, `:539` (both `sheetPadding(insets)`, bottom only).
`app/thread/[id].tsx` and `app/settings.tsx` never read insets at all.

**Command** `grep -n 'orientation' app.json`
**Observed** — `6: "orientation": "portrait"`.

**Command** `grep -rn 'numberOfLines\|height: [0-9]\|maxHeight\|width: [0-9]\|aspectRatio' app/ src/`

**Observed suspects, each of which is a real landscape break:**

| # | suspect | where | why it breaks |
|---|---|---|---|
| L1 | `"orientation": "portrait"` | `app.json:6` | the OS never rotates the app; nothing else matters until this changes |
| L2 | `paddingTop: insets.top` and **nothing horizontal** | `app/index.tsx:359`, `:377` | the notch's **left/right** insets are ignored, and in landscape *those* are the large ones — the title and both header buttons sit under the cutout |
| L3 | `maxHeight: '80%'` on the sheet | `src/roster/components.tsx:579` | 80 % of a *short* height; with an on-screen keyboard the sheet has almost nothing to scroll in |
| L4 | composer vs the raised keyboard | `app/thread/[id].tsx:339-343` | `KeyboardAvoidingView` uses `behavior='padding'` **only on iOS**; on Android the default window mode plus a `maxHeight: 120` input has no landscape budget |
| L5 | fixed widths/heights: `width: 52, height: 44` (send), `width: 160/90/…` (settings labels `:1281`, `:1336`), `height: 38` (search, `components.tsx:653`), `width: 22/28` | `app/thread/[id].tsx:509-510`, `app/settings.tsx:1216-1217`,`:1281`,`:1336`, `src/roster/components.tsx:653`, `:755` | square-ish assumptions and fixed label columns steal width a short, wide canvas needs |
| L6 | `numberOfLines={1}` on titles/previews/labels | `components.tsx:149,199,211,227,401,405,477,502`; `app/settings.tsx:539,542`; `ConnectivityBanner.tsx:28,41` | fine in portrait; in landscape a 1-line clamp on a wide-but-short row wastes the extra width |
| L7 | the roster geometry is dp-based (`src/roster/geometry.ts` — `ROW_WIDTH = 360`, `rosterRowGeometry(width)`) | `src/roster/geometry.ts:85-112` | **this one is fine, and it is why the roster is the easy half**: nothing in it is a fraction of the screen's height, so a wider/shorter canvas only changes `titleMaxWidth` (for the better). Prove it, do not assume it. |

**Conclusion.** L1 is the switch; L2 and L3 are the two that a user will *see* on the first rotation;
L4 is the one that makes typing impossible in landscape; L5/L6 are cosmetic but cheap; L7 must be
*proved* rather than asserted. All get a fix or an honest not-verified note.

---

## 6. Which recorder, and how does the build behave?

**Command** `node -p "require('./package.json').dependencies.expo"` → **`^57.0.27`**; `npx expo --version`
→ **57.0.28**.

**Command** `npm view expo-audio version` → **`57.0.5`** (the line that tracks SDK 57 — `npm view
expo-audio versions --json` ends at `58.0.x`, the next SDK). `npm view expo-av version` → **`16.0.8`**:
`expo-av` is the old SDK's media package and is published for the pre-57 line (its highest published
version is still 16.x while the SDK is at 57), so it is the wrong package for this app.

**Decision: `expo-audio`, installed with `npx expo install expo-audio`** so the version is resolved by
the SDK against `expo@57`, never hand-pinned (§2.6 of the goal says exactly this, and it is the one new
dependency this release needs).

**The build, from `PROGRESS.md` "Pitfalls worth keeping" (0.8.0, read before the first build as
instructed):**

* `expo prebuild` cannot clear a root-owned `android/` → *`docker run --rm -v $PWD:/work alpine:latest
  sh -c "rm -rf /work/android"`* before every prebuild, no sudo.
* Gradle must run as a **background job** (`setsid nohup docker run … &`) and be polled for
  `GRADLE_EXIT`, because a 5-minute tool-call cap makes a foreground wait impossible.
* 0.8.0's build took **11m 42s**; 0.7.0 took 4m 36s. The delta was three added native libraries.
* `npx expo install` re-resolves the tree and autolinks transitive native deps (114.3 MB → 128.5 MB
  across 0.6.0 → 0.7.0 → 0.8.0). **Expect `expo-audio` to cost more again — named here, not hidden.**

**Command** `docker images | grep personae` → `personae-android:1  579b79f9b479  7.03GB`.
**Command** `ls -la ~/.personae-android/` → `personae-release.keystore`, `keystore-password.txt`,
`build.env`, `Dockerfile`, `gradle/`. The key is outside the repo and unchanged, which is what lets
0.9.0 install straight over 0.8.0.

---

## 7. What this recon changes about the plan

* **Items 8 and 9 need no server change.** §6's "smallest additive change that makes an attachment
  reachable by the agent" already exists as `image.attach_bytes` / `file.attach`. The plan's conditional
  Phase A(iii) is therefore **not taken**.
* **The one new dependency is `expo-audio`**, installed by the SDK, for recording *and* playback.
* **Phase A's real content** is (i) the archive/delete verbs and (ii) the preference document — because
  the document is what Phase I reads, and the verbs are what Phase C/D/E act through.
* **Landscape (item 11) is a seven-suspect list**, not a mystery, and the roster's dp geometry is
  expected to survive it — and is proved statically rather than claimed.
