# GOAL-0.12.0 — rich formatting in text and tables, the way Telegram does it

**Batch:** one release, one build, **four halves**. **Half A** is T1 — inline marks and block structure,
plus the renderer and its wiring (the foundation; every other half depends on it). **Half B** is T2 —
fenced code as a monospace block with a language label and a copy button. **Half C** is T3 — tables as a
horizontal-scroll grid. **Half D** is the *other repo*: the shared, dependency-free text module vendored
into both surfaces, and the desktop plugin's one-line previews stripped of their markers so the shared
artifact has a live consumer. C and D sit in their own sections so either can be reverted alone (§10.14).

**Baseline:** `dist/personae-0.11.0.apk` — v `0.11.0`, vc `14`, `130,737,973` B,
sha256 `e98bbbfc1b778480acd16fb93d57144a70a62479b968921053516b7ce5947ea8`, same release key as
0.1.0–0.11.0 (`bd40e005…`, DN `CN=Personae Mobile`).

**Target:** `versionName 0.12.0` / `versionCode 15` (`app.json:5`, `app.json:22`), signed with the SAME
release key, so it installs over 0.11.0 with nothing to re-enter.

**Read first, in this order:** `DESIGN-0.12.0.md` (locked decisions; this brief implements them and
departs from two of them, both stated in §12) → this file → the actual `app/thread/[id].tsx`.

**This brief's anchors were re-derived against the POST-0.11.0 tree on purpose.** 0.11.0's R1/R5/R7/R8 all
edit `app/thread/[id].tsx`; the anchors the design doc quotes for it (`:474`, `:559`, `:463`) are now
`:913`, `:1016`, `:902`. `GOAL-0.11.0.md` and `DESIGN-0.12.0.md` are history; **the line numbers below are
the ones to trust** (verified 2026-10-13, tree at `f95321a`, working tree clean).

---

## §0 — What this batch is, in the user's words

Verbatim, 2026-10-13:

> So is it possible to get that rich-formatting in text and tables, just like in Telegram?

And the go, same day:

> go ahead and build 0120

The four answers that closed the design (`DESIGN-0.12.0.md`, locked):

> **Q: what is "parity" — the plugin, or core?**
> → *"your recommendation"* → **the desktop CORE's markdown semantics, not the plugin's.** The plugin is
> a roster with one-line previews and the plugin SDK ships no renderer; the plugin's whole share is
> stripping markers out of those previews (§9, §12.2).
>
> **Q: how do tables behave on a 360dp phone?**
> → *"Tables, horizontal-scroll grid"* → §8.
>
> **Q: does the plugin get a transcript pane?**
> → **no.** It stays a roster. §9.
>
> **Q: how much of the rich set lands in this batch?**
> → *"structure + code blocks + tables, code monochrome, math as typed"* → §A/§B/§C, and §12.1 for the
> one place this brief narrows that further.

Two hard constraints from the house, unchanged since 0.9.0 and 0.11.0:

1. **Nothing in this batch may be claimed as verified on a phone.** There is no `adb` on this host, no
   renderer for `app/*.tsx`. Every visual claim is a *shape* claim plus a device-only `MANUAL` line (§14).
2. **No secret is ever printed, and no credential literal may reach the bundle** (§15).

---

## §1 — The deliverable, in one sentence

A message that arrives on the phone is rendered as **structured React Native text** — bold, italic,
strike, inline code, links, headings, lists, blockquotes, rules, fenced code with a copy button, and
tables that scroll sideways — parsed with the **same `unified 11` family the desktop core parses with**,
using a **block cache so an in-flight turn stays smooth**, and sharing a **vendored, dependency-free text
module** with the desktop plugin, whose previews are finally stripped of their `**` and backticks.

---

## §2 — The anchored file map

Every path below exists in the tree at `f95321a` unless marked **NEW**.

### The mobile repo — `~/Projects/personae-mobile`

| what | where | note |
|---|---|---|
| the sealed bubble body | `app/thread/[id].tsx:913` | `<Text style={styles.bubbleText}>{item.text}</Text>` — **the main site** |
| the sealed reasoning body | `app/thread/[id].tsx:902` | `<Text style={styles.reasoningBody}>{item.text}</Text>` (inside the collapsible card) |
| the **live** agent bubble | `app/thread/[id].tsx:1016` | `<Text style={styles.bubbleText}>{live.text \|\| (streaming ? … )}</Text>` — the streaming path |
| the **live** user bubble | `app/thread/[id].tsx:978` | `<Text style={styles.bubbleText}>{live.user}</Text>` |
| the **live** reasoning body | `app/thread/[id].tsx:967` | **stays plain text — see §6.3** |
| the message seam | `src/logic/thread.ts:283` | `buildItems()`; calls `parseMessageContent` at `:301` and `:322` |
| the attachment seam | `src/logic/attachments.ts:230` | `parseMessageContent()` → `{ text, attachments }` (`:216`) |
| the suite | `tests/run.ts` | 7,140 lines today; one file; ends `process.exit(failures === 0 ? 0 : 1)` at `:7137` |
| the version | `app.json:5`, `app.json:22` | `0.11.0` / vc `14` → `0.12.0` / vc `15` |
| **NEW** — the renderer | `src/MessageBody.tsx` | the ONE component; see §6.4 for why it is here and not in `src/ui/` |
| **NEW** — the parse/plan module | `src/logic/markdown.ts` | pure; blocks, cache, node plan |
| **NEW** — the vendored text module | `src/logic/markdown-text.js` | byte-copy, generated (§9) |
| **NEW** — its declarations | `src/logic/markdown-text.d.ts` | hand-written, so the `.js` needs no `allowJs` gymnastics (`allowJs` is already `true` in `tsconfig.json`, so this is belt-and-braces) |
| **NEW** — the verifier | `logs/verify-0.12.0.sh` + `logs/verify-0.12.0.txt` | mirrors `logs/verify-0.11.0.sh` (656 lines) |
| **NEW** — the red team | `logs/red-0.12.0-T1.txt` … `-D.txt` | §13 |

### The plugin repo — `~/Projects/hermes-desktop-plugins/personae`

| what | where | note |
|---|---|---|
| the plugin | `desktop/plugin.js` | **9,198 lines**, one file, no build step, imports only `@hermes/plugin-sdk` + react |
| preview assembly | `desktop/plugin.js:2323` | `preview: last ? String(last.preview \|\| last.title \|\| '') : ''` |
| the toast clip | `desktop/plugin.js:2367` | `row.preview.slice(0, 140) \|\| 'Open the session to see it.'` |
| the search snippet | `desktop/plugin.js:2659` | `preview: snippet` |
| the human preview | `desktop/plugin.js:4750` | `humanPreview()` — pure; strips injected boilerplate |
| the title clip | `desktop/plugin.js:4777` | `preview.slice(0, 96)` |
| the harness | `tests/run.sh` → `run.mjs` + `classes.mjs` + `icons.mjs` + `live-sync.mjs`, sandbox `tests/work/` | `./run.sh` after every edit |
| **NEW** — the canonical module | `shared/markdown-text.js` | the ONE place the text policy is written |
| **NEW** — the vendoring script | `scripts/vendor-markdown-text.sh` | §9.2 |

**Two repos, two commits.** The mobile commit does not contain the plugin's change and vice versa; the
sha256 constant in §9.3 is what binds them.

---

## §3 — What the gateway sends, and therefore what is being built

`MessageCompletePayload.text: str` and the delta frames carry **text** (`tui_gateway/contracts/events.py:189-203`).
No entities, no offset/length ranges — nothing Telegram-like is being *received*. **The client renders it.**
That is the easier position: React Native's nested `<Text>` is the same primitive Telegram uses internally,
and it is native — no WebView, no native module, no new permission.

So this batch is a **renderer plus a parse seam**, not a transport change. **No new RPC, no new stream, no
new socket, no polling** (§14.4). The wire is not touched.

---

## §4 — The parser contract

**Dependencies to add** (all pure JS — verified live against npm on 2026-10-13, with the desktop core's own
pins quoted beside them so the family relationship is visible):

| package | pin | why | core's own pin |
|---|---|---|---|
| `unified` | `^11.0.5` | the pipeline | `11.0.5` |
| `remark-parse` | `^11.0.0` | markdown → mdast | `11.x` (core parses with the same family) |
| `remark-gfm` | `^4.0.1` | tables + strikethrough | core's table width lib is its own |

`remark-gfm` pulls `remark-parse` + `unified` transitively, but declare all three: the pin is a promise
the verify script can check, and a transitive pin is not a promise.

**`src/logic/markdown.ts` exports, and nothing else:**

```ts
export type InlineNode =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: InlineNode[] }
  | { t: 'em'; c: InlineNode[] }
  | { t: 'strike'; c: InlineNode[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: InlineNode[] }
  | { t: 'break' };            // a hard break, and (see below) a soft break in prose

export type BlockNode =
  | { t: 'p'; c: InlineNode[] }
  | { t: 'h'; depth: 1|2|3|4|5|6; c: InlineNode[] }
  | { t: 'ul' | 'ol'; start?: number; items: BlockNode[][] }
  | { t: 'quote'; c: BlockNode[] }
  | { t: 'hr' }
  | { t: 'code'; lang: string; v: string }
  | { t: 'table'; align: (('l'|'c'|'r')|null)[]; head: InlineNode[][]; rows: InlineNode[][][] };

export function parseBlocks(src: string): BlockNode[];   // cached, see §7
export function plainText(src: string): string;          // via the vendored module (§9) — one definition
```

**Rules that are part of the contract, not taste:**

1. **Soft breaks become line breaks in prose.** Core turns a single newline inside a paragraph into a line
   break (`remark-soft-breaks.ts`) so a reply reads as it was written. Mobile must match, or the same
   message reads differently on the two surfaces. This is `DESIGN-0.12.0.md` decision 7 and it is the
   easiest thing in this batch to get subtly wrong — there is a named test for it.
2. **Raw HTML is NOT rendered.** RN has no DOM. An `html` node (and any inline html) is painted as its
   **literal source text**, which is what a client without an HTML renderer must do. **This is a stated
   parity gap, not a bug** (§14.2): core's `markdown-html-depth.ts` policy does not apply to a phone.
3. **Unknown node types degrade to their text**, never to nothing and never to a crash. `unknown → text`.
4. **Math is not parsed in this batch.** `$x$` stays literal text — which is exactly what the user chose
   ("math as typed"). See §12.1 for the departure this is from `DESIGN-0.12.0.md` §8, and why.
5. Fence languages are normalised by a small table (`js→javascript`, `ts→typescript`, `py→python`, …) and
   displayed **lowercased**; an unknown language is displayed **as typed**. No `codiconForLanguage`
   (that is a desktop font's business, `markdown-code.ts`).

---

## §5 — T1: inline marks and block structure (Half A)

The smallest set that makes a real reply readable, and the whole of what a phone needs for prose.

**Inline:** `**strong**`, `*em*`, `_em_`, `~~strike~~`, `` `code` ``, `[text](url)`, hard break (two
trailing spaces or `\`), soft break (see §4.1), autolinks (`<https://…>` and bare URLs **only if they are
already a link node** — do not add autolink detection; core has a preprocess step for that and matching it
is not this batch).

**Blocks:** paragraphs, ATX headings `#`–`######`, unordered lists (`-`, `*`, `+`), ordered lists with a
non-1 start, nested lists (one level of nesting must be visibly indented), blockquotes (including a quote
containing a list), horizontal rules, and fenced code (whose *rendering* is Half B).

**Style, concretely — state these as the contract so the device check has something to look at:**

| mark | where it lands |
|---|---|
| strong | `fontWeight: '700'` on the run |
| em | `fontStyle: 'italic'` on the run |
| strike | `textDecorationLine: 'line-through'` |
| inline code | same line, monospace family, 0.9× the size, a subtly raised background, 4dp horizontal padding, 2dp radius |
| link | the accent colour + `textDecorationLine: 'underline'`; **tapping opens the URL** via `expo-linking`/`Linking` — but see §14.3, the tap itself is device-only |
| heading | bold + size ramp by depth (1.35×/1.2×/1.1×/1.0× body, 1 and 2 also get top spacing) |
| list item | a bullet/number column of fixed width, the content in a flex column; hanging indent, not a wrapped bullet |
| blockquote | a 3dp left rule in the border colour + 8dp left padding |
| hr | a 1dp full-width line |

**Nested inline marks must compose** (`**bold with `code` inside**`), which is the whole reason the plan is a
tree and not a regex pass.

---

## §6 — The renderer and its four call sites

### §6.1 The component

`src/MessageBody.tsx`:

```tsx
export function MessageBody(props: {
  text: string;
  streaming?: boolean;     // paint the in-flight tail as text (§7)
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
})
```

It takes **a string**, parses it (through the cached block parser), and renders the plan. It owns no
network, no state beyond the parse, and no colours that are not already in `styles`/theme.

### §6.2 The four sites to change

| site | line | change |
|---|---|---|
| sealed bubble | `app/thread/[id].tsx:913` | `<Text style={styles.bubbleText}>{item.text}</Text>` → `<MessageBody text={item.text} style={styles.bubbleText} />` |
| sealed reasoning | `app/thread/[id].tsx:902` | same, with `styles.reasoningBody` |
| live agent bubble | `app/thread/[id].tsx:1016` | `<MessageBody text={live.text \|\| (streaming ? t.thread.thinking : '')} streaming={streaming} style={styles.bubbleText} />` — **the `t.thread.thinking` placeholder and the empty-string case must survive verbatim** |
| live user bubble | `app/thread/[id].tsx:978` | `<MessageBody text={live.user} style={styles.bubbleText} />` |

The `bubbleRole` `<Text>` above each body (`:912`, `:977`, `:1013`) and the timestamp (`:948`) stay exactly
as they are — they are not message text and must not be swallowed by the renderer.

### §6.3 The one site that does NOT change

`app/thread/[id].tsx:967` — the **live** reasoning body — carries `numberOfLines={10}`, and a `View` tree
cannot be line-clamped. Rendering it through `MessageBody` would silently delete the clamp and let a
reasoning stream push the thread off the screen. **It stays a single `<Text>`.** This is a deliberate
exemption and there is a test that names it (§11).

### §6.4 Why `src/MessageBody.tsx` and not `src/ui/MessageBody.tsx`

`DESIGN-0.12.0.md` predicted `src/ui/MessageBody.tsx`. **That directory does not exist** in this repo and
never has: every component in this codebase sits flat at `src/` (`Avatar.tsx`, `ConnectivityBanner.tsx`,
`ConnectivityContext.tsx`). Follow the house: `src/MessageBody.tsx`. Logic stays under `src/logic/`.

### §6.5 What must NOT happen in this batch

No new bubble chrome, no avatar, no timestamp change, no bubble-colour change, no shadow, no animation, no
change to the composer, no change to the roster, no new screen. A message that arrives looking *different*
in three places at once is a batch nobody can attribute on a phone.

---

## §7 — Streaming: the block cache (mandatory, not an optimisation)

R7 made the thread watch its own session live; the in-flight bubble now repaints on every delta. If the
renderer re-parses the whole turn on every frame it will drop frames on a long reply, on a phone, on a
Snapdragon — and the symptom will look like "the markdown broke" rather than "the parser is running 40
times a second".

**Port the shape of core's `parseMarkdownIntoBlocksCached` (`markdown-blocks.ts`), not its code:**

1. **Split** the source into blocks on blank lines, **fence-aware** (a blank line inside an open ``` fence
   is not a boundary) and **table-aware** (a table's rows are contiguous and must not be split).
2. **Parse each block independently** and cache by the block's own string. A block already seen parses
   once. Use a bounded `Map` (evict oldest past ~200 entries) so a 500-message thread cannot leak.
3. **While `streaming` is true, the LAST block is not trusted**: it may be half-typed (an unclosed fence, a
   half-written table, a `**` with no partner). Paint the last block **as plain text** and every *closed*
   block above it through the renderer. When the turn closes, the last block goes through the normal path
   and gets its marks. This is exactly why the tail of a live reply may show `**` for a moment and the
   sealed bubble never does — **that behaviour is correct and should be asserted, not "fixed".**
4. `streaming` is already in scope at `:1016` (0.11.0's R7 state) — pass it; do not invent a second flag.

**Assert the cost, do not assume it.** The red team counts parses: a 200-delta stream over a 6-block reply
must parse each *closed* block once and the tail as text (§13 T2). A run that parses 200 times is a FAIL.

---

## §8 — T2 fenced code, and T3 tables (Half B, Half C)

### §8.1 Half B — a fenced code block

- **Monospace, no wrap, horizontal scroll.** `fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' })`,
  a `ScrollView horizontal` (or `Text` with `numberOfLines` unset inside a horizontal scroller — pick what
  the tree allows and record it), a slightly darker surface than the bubble, 6–8dp padding, 4dp radius.
- **A header row**: the normalised language label (§4.5) on the left, **a copy button on the right** using
  `expo-clipboard` (`~57.0.2`, already a dependency — `setStringAsync`). The button's a11y label lives in
  `src/i18n.ts` under the existing `thread` namespace (both language tables, no hard-coded English).
- **No syntax colouring.** Code is painted monochrome in this batch — the user's pick. §12.1 keeps the door
  open: the node is already `{t:'code', lang}`, so a later batch swaps the *renderer* and re-tokenizes
  nothing.
- **An unlabelled fence** renders a header with no language and keeps the copy button.
- **A very long single line** must scroll, not wrap, and must not blow the bubble's width.

### §8.2 Half C — a GFM table, as a horizontal-scroll grid

- Table = `ScrollView horizontal` inside the bubble; the table is the only thing that scrolls, never the
  thread. **The thread's vertical scroll must be untouched** — this is the item most likely to break the
  screen, and §13 T3 targets it.
- **Min column width ~96dp**; a cell wraps inside its column instead of widening it; the header row is
  bold; `align` from the mdast node (`:---`, `:---:`, `---:`) is honoured per column; row separators are
  1dp in the border colour.
- **Degenerate input falls back to the monospace pre-block, never to a broken grid**: a table with one
  column, a table whose only row is the delimiter, a table wider than ~12 columns, or a table whose cells
  are all empty. Fall back to the code-block rendering (§8.1) and keep the source text.
- **A pipe inside inline code must not split a row** — `| a \`b|c\` d |` is two cells, and GFM's own
  parser handles it; the *grid* is what must not re-split on `|`. §13 T3 asserts this by name.
- **Never** a "Table" placeholder, never a link out, never a truncation.

---

## §9 — Half D: the shared text module, and the plugin's previews

### §9.1 The problem being solved

A plugin is **ONE plain-JavaScript ESM file with no build step**; it can import neither a sibling file nor
an npm package (`desktop/plugin.js` imports only `@hermes/plugin-sdk` and react). Mobile's module must live
in-root or Metro will not bundle it. So "share the code" cannot mean "one import" — it means **one authored
file, two byte-identical copies, and a hash that fails the build on drift.** The failure this prevents is
concrete: six months from now somebody rewrites `stripMarkdown` from scratch inside `plugin.js` because
importing was impossible, and the phone and the roster disagree about what `**bold**` means.

### §9.2 The mechanism

- **Canonical:** `~/Projects/hermes-desktop-plugins/personae/shared/markdown-text.js` — plain ESM, **zero
  imports**, no build step, runs as-is under node, Metro and the app's plugin loader.
- **`scripts/vendor-markdown-text.sh`** (in the plugin repo) does exactly two things, in this order:
  1. copies the canonical file to `${PERSONAE_MOBILE_DIR:-$HOME/Projects/personae-mobile}/src/logic/markdown-text.js`;
  2. re-writes the block in `desktop/plugin.js` **between these two sentinel lines**:

     ```js
     // ── BEGIN vendored markdown-text.js (sha256 <hash>) — edit shared/markdown-text.js, then run scripts/vendor-markdown-text.sh ──
     …
     // ── END vendored markdown-text.js ──
     ```
  The script prints **all three** hashes (canonical, mobile copy, inlined block) and exits non-zero if they
  disagree. Re-running it on a clean tree is a no-op (assert that in the red team — a "sync" that always
  rewrites is a sync that will be run once and never trusted).

### §9.3 The hash is asserted in BOTH harnesses

One constant, `MARKDOWN_TEXT_SHA256`, written into **both** harnesses:

- plugin side, `tests/run.mjs`: extract the bytes between the sentinels from `../desktop/plugin.js`, hash
  them, and require **== the constant** and **== the sha256 written in the sentinel comment** and, when
  `$PERSONAE_MOBILE_DIR` resolves, **== the sha256 of the mobile copy**.
- mobile side, `tests/run.ts`: hash `src/logic/markdown-text.js` from disk and require **== the constant**.
- **The rule:** editing either copy without running the script turns at least one harness red. A new suite
  in the plugin's `run.mjs` is where this lives — it is a suite, it tallies, and `run.sh` already fails on a
  bad tally.

### §9.4 What the module exports, and the preview rule it enforces

```js
export const MARKDOWN_TEXT_VERSION = '1';
export const MATH_DELIMITERS = ['$', '$$'];          // shared policy; not parsed in this batch (§12.1)
export const FENCE = /(^|\n)(```|~~~)/;
export function looksMarkdown(text)                  // cheap gate; false → return the input untouched
export function stripMarkdown(text, limit)           // markers OUT, whitespace collapsed to single spaces,
                                                     // code-fence bodies dropped to their language label,
                                                     // links flattened to their text, truncated at `limit`
export function flattenInline(nodes)                 // mdast inline[] → text (used by mobile for parity)
export function flattenBlocks(nodes, opts)           // mdast root → text (paragraphs joined by ' ')
```

**The plugin side is four call sites, all of them preview-shaped** — no rendering, no new pane, no new
state, no transcript:

| site | line | what changes |
|---|---|---|
| the row's preview string | `desktop/plugin.js:2323` | wrap in `stripMarkdown(p, 0)` — markers gone from the roster's second line |
| the activity toast | `desktop/plugin.js:2367` | `stripMarkdown(row.preview, 140)` before the existing `.slice(0,140)`/fallback (the fallback string must remain reachable) |
| the search snippet | `desktop/plugin.js:2659` | `stripMarkdown(snippet, 0)` on the way in, not on the way out |
| the human preview / title clip | `desktop/plugin.js:4750`, `:4777` | `humanPreview()` keeps its job (boilerplate) and then strips markers; the title clip stays at 96 |
| the body-search matcher | `desktop/plugin.js:2742` | **leave it alone.** It matches on the raw preview; stripping first would change which rows match a query, and that is a search-semantics change smuggled into a formatting batch. Record the decision in a comment. |

Nothing else in a 9,198-line file is touched. The plugin's own harness (`tests/run.sh`: render + class
tokens + codicons + live-sync) must be **green and taller** than before, with new assertions that a
`**bold**` preview renders as `bold` and that a fenced preview does not leak backticks.

---

## §10 — Scope, ordering, and what is deliberately NOT here

### §10.1 The halves, in order

**A (T1) → B (T2) → C (T3) → D (plugin + vendoring).** A is load-bearing: without the renderer and the plan
types, nothing else can be tested. B and C are each revertable on their own. D touches a second repo and is
last, so a plugin-side problem can never hold the APK.

### §10.14 Revertability, stated so it can be exercised

- **Reverting C** = the table node renders through the §8.1 code-block path. One branch, one test flip.
- **Reverting D** = `plugin.js` loses the sentinels and the four `stripMarkdown` calls, the vendored file
  and both hash assertions go, and mobile keeps its (now unshared) copy. The plugin must be green again
  after that revert, by its own harness, with no mobile build.
- **Reverting A or B** is not offered: everything else stands on them.

### §10.2 Not in this batch — name them so they are not smuggled in

1. **Syntax highlighting** (shiki's pure-JS engine). Deferred by `DESIGN-0.12.0.md` with a spike required
   first: *"no WASM is necessary, not sufficient"* — do not promise it, do not add it.
2. **Typeset math** (KaTeX; the maintained RN route is a WebView). §12.1.
3. **A plugin transcript pane.** The plugin stays a roster. Decision 9, locked.
4. **Repointing the phone off `/api/plugins/messenger/`.** the user renamed the plugin to `personae` and left
   a **legacy-mount shim** at `~/.hermes/plugins/messenger/` (795-byte `__init__.py` + `plugin.yaml`, a
   `state → ../personae/state` symlink) precisely because this app still pins the old prefix
   (`src/sync/uiSync.ts:224` `/api/plugins/messenger/state`, `src/api/dashboard.ts:526`
   `/api/plugins/messenger/search`). Retiring those two strings and deleting the shim is real, small, and
   **is not this batch** — for the same reason 0.11.0 and 0.12.0 are not joined: a phone that cannot reach
   its state plugin is a failure nobody could attribute between a markdown rewrite and a path rename.
   Flag it in PROGRESS.md as its own micro-batch.
5. **Autolink preprocessing, footnotes, definition lists, task-list checkboxes as taps, images.** A `![alt](url)`
   in a message body renders as its **link text** (`alt`), not as an image: no remote-image policy exists in
   this app and inventing one mid-batch is how a formatting release becomes a privacy review.

---

## §11 — The verifier

`logs/verify-0.12.0.sh` — one command, PASS/FAIL per check, non-zero exit on any failure, safe to re-run,
changes nothing. It mirrors `logs/verify-0.11.0.sh` (656 lines) and **keeps every older gate**:

1. **App suite** `npm test` → the floor moves with measured reality (294 at 0.11.0 plus this batch's new
   cases; the header states the count and the reason, not a guess) and must report `, 0 failed`.
2. **Typecheck** `npm run typecheck` → `tsc --noEmit` rc 0.
3. **The named-test contract** — one line per item: `T1`, `T2`, `T3`, `D1…D5`, each satisfied by a test in
   `tests/run.ts` **whose name contains the item id**. Generate the list from `tests/run.ts` when the
   release is cut (0.11.0's lesson: a hand-typed contract goes stale on the first rename). **No apostrophes
   in any test name** — `grep -F` cannot match what TypeScript escapes.
4. **Dependency assertions from `package.json`**: `unified`/`remark-parse`/`remark-gfm` declared at the §4
   pins; and **absence probes** — no `marked`, no `react-native-markdown-display`, no
   `react-native-syntax-highlighter`, no math renderer, no WebView markdown package.
5. **The artifact probes, ASCII only**, with a positive control for every absence (0.11.0's rule: *an empty
   grep is not a proof*). Include the vendored hash as a checker script, not as a printed value.
6. **The desktop half**: run the plugin's `tests/run.sh` and print its three tallies, plus the vendored
   hash assertions (§9.3). A red plugin harness is a FAIL of this script — one build, one verifier.
7. **Secrets**: `scripts/verify-secrets.sh`, and the bearer read from `$HERMES_HOME/.env` **by name, never
   printed** — only its occurrence count.
8. **The APK**: exists, `aapt`-reported `versionName 0.12.0` / `versionCode 15`, same signer
   `bd40e005…`, sha256 recorded in the txt beside the artifact. **Byte count is NOT pinned** (a feature
   release legitimately changes it); it is recorded.
9. Ending: `RESULT: PASS — 0.12.0 verified` on success, with every device-only item printed as `MANUAL`
   and **never** as PASS (§14).

`logs/verify-0.12.0.txt` is the record. It is one file, it is re-runnable, and the last line is the verdict.

---

## §12 — The two departures from the design doc, and why

### §12.1 Math is not parsed in this batch (narrows `DESIGN-0.12.0.md` §8)

The design says: *"parse fences and math into distinct node types from day one even while painting them
plainly, so an upgrade later swaps one node renderer instead of re-tokenizing anything."* The fences half is
implemented (§8.1). **The math half is not, and the reason is a measured dependency:** every maintained
route to a math *node* is `remark-math`, and `remark-math@6.0.0` → `micromark-extension-math@3.1.0`, whose
declared dependencies include **`katex ^0.16`** — a full typesetting engine's worth of JavaScript, pulled
in to produce a node that this batch would paint as raw source text anyway.

The cost of deferring is one pipeline line: the parse stays `unified().use(remarkParse).use(remarkGfm)`, and
the math batch appends `.use(remarkMath)` and adds a node renderer. **`$…$` stays literal text**, which is
the user's choice ("math as typed") — visually identical to what the design asked for. The shared module keeps
`MATH_DELIMITERS` so the policy is still written once.

**If the spike shows `katex` is not actually pulled into the Metro bundle** (measure it: build with and
without and diff), say so in `DECISION-REPORT.md` and this departure can be reversed in the next batch for
the price of one plugin line. Do not reverse it by adding the dependency on a hunch.

### §12.2 The renderer is mobile-only, and the plugin keeps no renderer

`DESIGN-0.12.0.md` decision 1 rules out sharing a *renderer* (RN `<Text>` tree vs `jsx`/DOM); §9 above is the
part that *is* shared (semantics, policy, the flattener). Nothing in `plugin.js` may grow a message-body
renderer, a second markdown implementation, or a transcript pane. If a future task wants one, it adds an
import-free module to `shared/` and an assertion to the harness — the same mechanism, not a new one.

---

## §13 — The red team (falsification, one file per claim)

A PASS means a check ran. A red-team file means the check **would have failed if the claim were false**.
Each file: the claim, the command, the observed output, and the mutation that turned it red. The mutations
are run on a scratch copy of the tree, never on the committed one, and the tree must be clean at the end.

- **`logs/red-0.12.0-T1.txt`** — *"the sealed bubble really renders structure."* Mutate
  `app/thread/[id].tsx:913` back to a bare `<Text>{item.text}</Text>` → the named T1 tests must go red.
  Proves the wiring, not just the parser. Include the streaming-tail claim: with `streaming` force-true on a
  sealed bubble, `**x**` must appear literally in the plan (that is the correct behaviour, §7.3).
- **`logs/red-0.12.0-T2.txt`** — *"a live turn does not re-parse the whole reply."* Count `parseBlocks`
  calls across a scripted 200-delta stream over a 6-block reply: each closed block parses once, the tail
  renders as text. Show the count, and show it exploding above the cache's bound.
- **`logs/red-0.12.0-T3.txt`** — *"a table does not break the thread."* (a) `| a \`b|c\` d |` stays two
  cells; (b) a 40-column table falls back rather than rendering; (c) a table inside a blockquote; (d) the
  thread's vertical scroll is not the table's scroll — assert the tree shape, since the gesture is device-only.
- **`logs/red-0.12.0-D.txt`** — *"drift fails the build."* (a) edit `src/logic/markdown-text.js` by one byte
  → mobile suite red; (b) edit the inlined block in `plugin.js` by one byte → plugin suite red;
  (c) `vendor-markdown-text.sh` on a clean tree is a no-op, and its printed hashes agree; (d) the same
  sample string goes through `stripMarkdown` on both sides and comes out **byte-equal** — that equality, not
  the hash, is what "parity" means to a user.
- **`logs/red-0.12.0-guards.txt`** — the scope guards: `git diff --stat` shows **no** change outside the
  files in §2; `grep -c markdown` in `plugin.js` did not grow a second implementation; no new RPC/route/
  socket; `package.json` gained exactly three dependencies; the live reasoning body at `:967` still carries
  `numberOfLines={10}`.

---

## §14 — What CANNOT be verified here, and must not be written as PASS

1. **Anything visual, on a phone.** The table's horizontal scroll, whether bold *looks* bold, whether the
   code block's horizontal scroll fights the thread's vertical scroll, whether the copy button is reachable
   with a thumb — all device-only. They are printed `MANUAL` (§11.9).
2. **Raw-HTML parity with core.** Mobile paints literal text by design (§4.2). Stated, not fixed.
3. **Link taps.** Opening a URL is an OS intent; assert the plan carries `href` and the props wire it, and
   put the tap in the MANUAL list.
4. **Nothing new on the wire.** No RPC, no route, no socket, no polling, no background work — assert the
   absences by count, the way 0.11.0 did (§10.11/§10.13 there).
5. **The iOS half is still config, not an exercised build** — no Mac, no EAS run. Nothing in this batch
   changes the iOS surface beyond the renderer being shared React Native code.
6. **A rendered sentence under Hermes bytecode** is still unverifiable by `grep` (2-byte UTF-16 storage);
   every bundle probe stays ASCII, with a positive control.

**If a device check contradicts a static proof, the device wins.** the user tests every version on his Pixel 8
— that is the feedback loop this project runs on — and a MANUAL line that comes back wrong is a bug report,
not a rounding error.

---

## §15 — Identity, secrets, and the environment

- All secrets live in `~/.hermes/.env` and are loaded by the unit's `EnvironmentFile`.
- cody's config reads `access_token_env: BWS_ACCESS_TOKEN`. **The name is fine to write down. The value is
  never written, printed, echoed, committed or summarised — [REDACTED], always.**
- No API key, token, password, bearer, or connection string may appear in `logs/`, in `PROGRESS.md`, in a
  commit message, or in the verify output. The verify script reads the bearer **by name** and prints **only
  a count**.
- The dashboard's session token is generated in-process and never hits disk. Do not start persisting it to
  make a check easier.
- **No device, no emulator, no `adb`, no GUI.** Do not attempt to install one.
- The build environment is the container image `personae-android:1` (already present, 7.03 GB) — the same
  one 0.11.0 used. **Known wart:** it runs as root and writes into the bind mount, so `dist/personae-0.12.0.apk`
  and anything under `android/app/build/` come out `root:root`. Either `chown -R personae:personae` the
  build output when the build finishes, or state plainly in `PROGRESS.md` that it is still root-owned.
  Do not leave it silent.

---

## §16 — Close-out

1. `PROGRESS.md` gains a `## 0.12.0` section in the shape of the 0.11.0 one: what was built, the artifact
   table, **what could not be verified and why**, and the flagged-not-fixed items (§10.2's legacy-mount
   shim belongs there).
2. `DECISION-REPORT.md` gains an entry per decision taken *during* the work, with the evidence that decided
   it — including §12.1's bundle measurement, whatever it says.
3. **Every older named-test gate stays** in the verify script. No test is deleted to make room.
4. Commits: one for the mobile halves (A/B/C, with D's vendored file), one for the plugin repo (canonical +
   inline + harness). Messages state the *why*, not the file list.
5. **Finish line, stated as an artifact and a verdict:**
   `dist/personae-0.12.0.apk` (`0.12.0` / vc `15`, same release key so it installs over 0.11.0)
   **and** `logs/verify-0.12.0.txt` ending `RESULT: PASS — 0.12.0 verified`, with every device-only item
   printed `MANUAL` and the red-team files beside it.
6. If a half cannot be finished honestly, **stop at the last green half, leave the tree clean, and say so.**
   A half-finished Half D with a green A/B/C is a good outcome; a silent FAIL is not.
