# DESIGN-0.12.0 — rich text and tables

Decisions locked 2026-10-13. the user's four answers: parity = *"your recommendation"* (share, below);
tables = *"Tables, horizontal-scroll grid"*; plugin = **roster only, previews stripped of markers**;
mobile scope = **structure + code blocks + tables, code monochrome, math as typed**. **This is not the
brief** — the 0.12.0 brief is written after 0.11.0 is built and verified (§Sequencing), so its anchors are
checked against the file they will actually be edited in. This file exists so those decisions are not
re-litigated in between.

## The parity target is the desktop CORE, not the plugin (found 2026-10-13)

The first pass got this wrong, and checking it changed the recommendation. The desktop app **already renders
rich text**, with a settled pipeline and its own test suite. The plugin can touch none of it.

**What core has** (`~/.hermes/hermes-agent/apps/desktop`):

| Layer | Implementation |
|---|---|
| Renderer | `streamdown 2.5.0` + `@assistant-ui/react-streamdown`, `@streamdown/code`, `@streamdown/math` — a **streaming-aware** markdown renderer, i.e. the in-flight-text problem is already solved in-house |
| Highlighting / math | `shiki 4.3.1` + `react-shiki`; `katex 0.16.47` + `remark-math 6.0.0` |
| Parsing | `unified 11.0.5`, `hast-util-*`, `remark-soft-breaks.ts` |
| Components | `components/assistant-ui/markdown-text.tsx`, `markdown-table.tsx`, `shiki-highlighter.tsx`, `artifact-card.tsx` |
| Policy libs | `markdown-preprocess.ts`; `markdown-blocks.ts` (`parseMarkdownIntoBlocksCached`); `markdown-table-widths.ts` (`readTableWidths`/`writeTableWidths`/`markdownTableKey` — **persisted column widths**); `markdown-code.ts` (fence-language normalisation, `codiconForLanguage`, `isLikelyProseCodeBlock`); `markdown-html-depth.ts` |
| Tests = free spec | `markdown-preprocess.{fences,autolink,directives,citation,file-preview,reasoning}.test.ts`, `markdown-blocks.test.ts`, `markdown-whitespace.test.ts`, `markdown-code.test.ts`, `markdown-html-depth.test.ts`, `file-preview-math.render.test.tsx` |

**The plugin cannot reuse any of it.** A plugin resolves only `@hermes/plugin-sdk`, `react` and
`react/jsx-runtime` (`plugin.js:87`); the SDK export list (`tests/sdk/index.js`) carries UI primitives
(`Button`, `RowButton`, `EmptyState`, `SessionStatusDot`, `usePluginI18n`, …) and **no markdown or
message-body renderer**.

**And the plugin has no transcript surface to render into.** Its panes are `id: 'pane'` — the Personae roster
(`plugin.js:8874-8877`) — and Scheduled jobs (`:8893-8896`); it deliberately delegates *reading* to core (the
activity toast says *"Open the session to see it."*, `:2352`). Its only text surfaces are one-line previews
(`:2308`, clipped `row.preview.slice(0, 140)` at `:2352`) and search snippets (`:2634`). No `messages.map`,
no bubble component, 0 hits for `markdown` / `tokenize`.

**Consequence:** "build it into the desktop plugin first" would mean writing, inside a roster pane, a
renderer core already owns twenty centimetres away — in a surface that never displays a transcript. The
useful desktop-first work is reading **core's** pipeline and tests as the spec.

## What the rest of the surface is today (verified)

- **The gateway sends markdown SOURCE, not styled spans.** `MessageCompletePayload.text: str` and the delta
  frames carry text (`tui_gateway/contracts/events.py:189-203`). No entities, no offset/length ranges —
  Telegram's model — so nothing to "receive": the client renders it. The easier position, because React
  Native's **nested `<Text>` is the same primitive** Telegram uses internally, and it is native.
- **The mobile app renders raw text today.** Sealed bubble `app/thread/[id].tsx:474`, live bubble `:559`,
  reasoning `:463`; no markdown library in `package.json`.
- **The seam already exists.** `src/logic/thread.ts` already splits a message into parts
  (`parseMessageContent`, the 0.9.0 G work, beside `attachments: InboundAttachment[]`) — a markdown
  renderer slots in at the same place.
- **A desktop plugin is ONE file with no build step** (`hermes-desktop-plugins`: *"a plugin is a single
  plain-JavaScript ESM file the app loads at runtime — no build step"*; heading: *"a plugin ships as ONE
  file"*), importing only `@hermes/plugin-sdk` + react (`plugin.js:87-136`). It **cannot** import a sibling
  file or an npm package.

## Decisions

1. **Parity shares the SEMANTICS and a pure token tree — not a renderer.** The element mapping cannot be
   shared (RN `<Text>` tree vs `jsx`/DOM) and core's own renderer is DOM/Streamdown-based, so mobile cannot
   import it. Shareable: the input→structure contract, plus the policy decisions core has already settled.
2. **Parser family: `micromark` / `remark-parse` + `mdast` — not `marked`.** *Supersedes the earlier
   suggestion.* Core parses with the `unified 11` family; the same family maximises the chance that one
   source string yields the same structure on both surfaces, and it is pure JS, so it is RN-safe.
3. **Canonical tokenizer, vendored by copy — never by package.** A plugin is ONE plain-JS ESM file with no
   build step, so it can import neither a sibling nor an npm dep. Drift is prevented by a **sha256
   assertion in each harness**, not by discipline; mobile's copy must live in-project (Metro bundles
   in-root).
4. **Tables: horizontal-scroll grid** — the user: *"Tables, horizontal-scroll grid"*. Min column width,
   horizontal scroll on overflow, cells own their wrapping. **Monospace pre-block only for degenerate
   input**, never as the default. *New input:* core's precedent is `markdown-table-widths.ts` — **persisted
   column widths**, not scroll. The decision stands for a 360dp phone, but mobile may want widths remembered
   too.
5. **Streaming is already the house pattern, not a new idea.** `parseMarkdownIntoBlocksCached` parses per
   block with a cache, and Streamdown exists precisely to render incomplete markdown. The mobile equivalent
   is a ported block cache: parse the sealed message once; while streaming, style only **closed** blocks and
   paint the in-flight tail as text. R7's live deltas are what make this mandatory.
6. **Tiers.** T1 inline + blocks (bold, italic, strike, inline code, links, headings, lists, blockquote,
   hr), T2 fenced code (monospace, no wrap, language label, copy via the existing `expo-clipboard`),
   T3 tables. **T1+T2 in one build; T3 a separately revertable half** — the Half C shape the user already chose.
7. **Soft breaks are a semantic decision, not a nicety.** Core turns single newlines in prose into line
   breaks (`remark-soft-breaks.ts`) so replies read as written. Mobile must match, or the same message reads
   differently on the two surfaces.
8. **Mobile scope in 0.12.0: structure + code blocks + tables — code painted monochrome, math painted as
   typed.** the user's pick, from the pricing below. **Parse fences and math into distinct node types from day
   one even while painting them plainly**, so an upgrade later swaps one node renderer instead of
   re-tokenizing anything.
9. **The plugin stays a roster.** Personae gets no transcript pane. Its only change is that its one-line
   previews get markdown markers stripped via the shared tokenizer — small, real, current, and it gives the
   shared artifact a live consumer and proves the sync machinery.

## Why mobile paints plainly in this batch (the pricing that decided it)

| Route | Library | Latest | Last published | Verdict |
|---|---|---|---|---|
| shiki's engine, no WASM | `@shikijs/engine-javascript` | 4.5.0 | 2026-10-01 | alive — what makes RN highlighting possible at all |
| shiki (core's highlighter) | `shiki` | 4.5.0 | 2026-10-01 | alive (core runs 4.3.1) |
| RN highlighter, lighter | `react-native-code-highlighter` | 1.3.1 | 2026-09-03 | alive, Prism-based, less accurate |
| RN highlighter, old | `react-native-syntax-highlighter` | 2.1.0 | 2019-09-16 | dead — out |
| RN math, "native" | `react-native-math-view` | 3.9.5 | 2021-08-28 | ~5 years stale |
| RN math, maintained | `react-native-katex` | 1.3.0 | 2025-01-31 | alive — but **it is a WebView** with KaTeX inside |

- **Highlighting (deferred).** Viable only because the pure-JS engine exists — shiki's DOM-only reputation
  came from its Oniguruma WASM engine. Cost is **bundle weight, not risk**: the engine is small, the
  TextMate grammars are the load (full set ~10 MB of JSON; a curated 15–25 languages is low single-digit MB
  lazily loaded), plus per-block tokenize time on the JS thread (absorbed by the ported block cache) and a
  theme→RN colour table. **Honest caveat: "pure-JS engine" ≠ "runs clean under Hermes + Metro" — no WASM is
  necessary, not sufficient. A spike precedes any commitment; do not promise it.** Highest value of the two,
  because code is frequent in agent work (commands, diffs, tool output).
- **Math (deferred).** The native module is ~5 years stale, so the maintained route is a **WebView** — which
  brings a layout problem (a WebView needs a measured height or it collapses/clips inside a scrolling list),
  per-instance memory and scroll interaction. Solvable (batch a block's formulas into one WebView, report
  height via `onMessage`), but real engineering with real jank potential. Its value depends on how often
  LaTeX actually appears in the user's sessions — **an unmeasured number, and reading message bodies to measure
  it needs his explicit say-so.**
- **Cost of deferring is near zero** precisely because decision 8 parses both node types now: the upgrade is
  one renderer swap, not a re-architecture. Parity gap while deferred, stated plainly: the desktop shows
  coloured code and typeset math; the phone shows monochrome code and raw math source.

## When the plugin gets its copy — decided (a)

Vendor now, with a real consumer: flatten the token tree to plain text and strip markdown markers out of the
one-line previews (`plugin.js:2308`, clipped at `:2352`). The **mechanism (sync script + sha256 assertion)
belongs to the 0.12.0 batch**. What must not happen is a *second* markdown implementation growing inside
`plugin.js` later, written from scratch by whoever touches it next — that is the drift the assertion exists
to prevent.

## Sequencing

- **Separate releases — decided by the user 2026-10-13.** Asked whether 0.11.0 could be joined with 0.12.0, he
  chose to keep them apart: 0.11.0 (the fixes — file ref, picker, mic, slash, live wiring, keyboard) ships
  and verifies first, because a joined build holds live-bug fixes behind a rewrite of every message render
  path, and a bad device check could not be attributed to one half. **0.12.0 follows after 0.11.0 verifies.**
  Closed question; do not re-open it.
- **The 0.12.0 brief is written after 0.11.0 is built and verified.** R1 (wire text), R5 (the `/` menu),
  R7 (live wiring) and R8 (the composer lift) all edit `app/thread/[id].tsx`, and every render-path anchor a
  0.12.0 brief would cite (`:474`, `:559`, `:463`) can move under them.
- **Design is locked here so the batches do not fight:** 0.11.0 needs to know nothing about markdown, and
  0.12.0 re-opens none of 0.11.0's decisions.
