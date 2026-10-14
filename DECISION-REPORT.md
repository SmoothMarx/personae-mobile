# Personae Mobile — Decision Report

**Status:** decisions made, nothing built. This document is the artifact; no app code, no scaffolding, no dependencies installed.
**Date:** 2026-10-11
**Scope:** port the Personae desktop plug-in (`~/Projects/hermes-desktop-plugins/personae`) to a phone app for **Android and iOS**.

---

## 1. Recommended mobile framework: **React Native + Expo (TypeScript)**

| Option | Verdict | Why |
| --- | --- | --- |
| **React Native + Expo** | ✅ **Chosen** | One codebase → both stores. Expo's **EAS Build** compiles iOS in the cloud — **no Mac required**. The portable half of Personae is *state logic in JS* (rollups, status-dot priority, unread counts, preview/age), so it lifts into TS as tested pure functions instead of being rewritten. |
| Flutter | ❌ Rejected | Comparable quality, but Dart would force a rewrite of that logic and its 770-assertion harness for zero gain. Kept only as a fallback if RN proves pathological. |
| Two native apps (Kotlin + Swift) | ❌ Rejected | Two codebases, two release trains, one developer. No. |

**The one real cost to accept up front:** an Apple Developer account (**$99/yr**) is needed for iOS device installs / TestFlight. Android can sideload a free APK.

## 2. Scaffold: **neither Hermes Relay nor open-source Telegram**

The app is a **native client of the Hermes Dashboard/Gateway API** — the same surface the desktop app's remote mode and every existing phone client already use.

| Candidate | Verdict | Why |
| --- | --- | --- |
| **Hermes Relay** | ❌ Rejected as a base | Real and well-built, but it is an **Android-only companion** (Kotlin, Play Store, Android 8.0+), and its relay fronts *external platforms into* Hermes — the opposite direction from an app shell. Forking it buys Android only. **MIT-licensed, so we still lift its QR/pairing flow as reference.** |
| **Open-source Telegram** | ❌ Rejected | Wrong shape on every axis: **two separate native codebases** (Kotlin + Swift/ObjC) with no shared UI, and it puts **MTProto + Telegram's servers in the middle of a private agent roster**. Fork branding restrictions apply too. |
| **Dashboard/Gateway API** | ✅ **Chosen** | Already running on the box, already the proven path, zero forked code to maintain. |

**Correction to my earlier reasoning:** I had counted Telegram's GPL as a strike against it. That was wrong-headed — **Personae itself is `GPL-3.0-or-later`** (`package.json`, `LICENSE`), so the mobile app is copyleft either way. GPL is a neutral factor; the architecture is what kills Telegram.

**Verified, not assumed** (this box, today): Hermes Agent **v0.21.5**, `hermes dashboard` live on `0.0.0.0:9119`; `/api/status` public; `/api/sessions`, `/api/profiles`, `/api/bots` return **401 — not 404**, i.e. the endpoints exist behind real auth. Prior art doing exactly this: `hermex` (SwiftUI), `Vory` (iPhone/TestFlight), `Conduit` (native iOS), `hermes-webui`.

⚠️ **Fix before a phone points at it:** `9119` is bound to **all** interfaces. Bind it to the Tailscale interface or firewall it; transport security is Tailscale, not app-level E2EE.

## 3. Execution approach

**Kanban board as the spine, one frontier-model planning pass, sub-agents for the parallel work.** Not a fleet.

- **Frontier-model planning pass (once):** author the Phase-0 spec and the API contract. Brainstorming architecture is the one place a big model pays for itself.
- **Kanban board (Hermes kanban):** every workstream is a card with an assignee and acceptance criteria; children gate on parents, so the pipeline is auditable rather than a chat log.
- **Sub-agents (2, not 10):** only the two genuinely independent streams — *API transport client* and *UI components* — run in parallel. Everything else is sequential.
- **Reference-driven replication:** the desktop plug-in stays the spec. Logic ports with its tests; only the render layer is rewritten.

## 4. Plan

| Phase | Deliverable |
| --- | --- |
| **0 — API spike** *(do first)* | Confirm the **roster + live-status endpoints and push channel**. The only thing I could not verify (they sit behind auth). Everything else hangs off it. |
| **1 — Transport** | Auth, profile/session fetch, streaming chat over WebSocket. |
| **2 — Logic port** | Rollups, status-dot priority (amber > emerald > neutral), unread counts, preview/age — as tested TS modules lifted from `plugin.js`. |
| **3 — UI** | Contacts rail → expanded sessions → profile detail. The messenger metaphor *is* the product. |
| **4 — Ship** | EAS build; Android APK + iOS TestFlight. |

**Both platforms in lockstep** — that is the point of one RN codebase; no Android-first detour.

---

## 5. Summary of what I want to do

Build **Personae Mobile** as a **React Native + Expo** app for **Android and iOS from one codebase**, talking to the **Hermes Dashboard/Gateway API** — **not** forked from Hermes Relay (Android-only) or Telegram (wrong shape entirely). Ship it in four phases on a **kanban board**, opening with a single frontier-model planning pass and a Phase-0 API spike to pin the roster and live-status endpoints behind auth. Port Personae's state logic and tests; rewrite only the UI. Add one security fix: stop `9119` listening on all interfaces.

**Assumptions I'm making** (correct me and the plan changes): single user — you; self-hosted over LAN/Tailscale; **no** E2EE requirement beyond Tailscale; no offline mode. A multi-user / public-release requirement would invalidate the transport choice, so I've left it out of scope rather than guessed at.

---

## 6. Explicitly out of scope

App code, build configs, CI, store assets, and any change to the Personae plug-in. **Nothing has been built, scaffolded, or installed** — this document is the only artifact.

---

## 7. 0.12.0 — decisions taken DURING the work, with the evidence that decided each

This section is the running log the brief asks for (§16.2): one entry per decision, the evidence that
decided it, and how it could be reversed. The lock-step decisions are in `DESIGN-0.12.0.md`; what
follows is what changed once the code met the tree.

| # | decision | the evidence that decided it |
|---|---|---|
| 1 | The renderer is `src/MessageBody.tsx`, flat at `src/` | `DESIGN-0.12.0.md` predicted `src/ui/MessageBody.tsx`; that directory has never existed (`ls src/*.tsx` = Avatar, ConnectivityBanner, ConnectivityContext). The house is flat, and logic lives under `src/logic/`. |
| 2 | `src/logic/markdown.ts` exports EXACTLY `parseBlocks` and `plainText` | The contract says "exports, and nothing else". The block splitter is therefore module-private: its fence-awareness is observable through the plan it produces (a fence containing a blank line comes back as ONE `code` block), so a test pins it without widening the surface. Asserted by introspecting the module namespace, not by grepping: `Object.keys(await import(...)) === ['parseBlocks','plainText']`. |
| 3 | `languageLabel()` was ADDED to the shared module's exports | §9.4's list is a list, not a closed set, and without this one table the same fence would be labelled `javascript` in a preview and `js` in a code header — two names for one thing, in two surfaces. One table now serves both. |
| 4 | `stripMarkdown` does NOT strip raw HTML tags | The phone paints an `html` node as its literal source (§4.2). A preview that dropped `<b>` would disagree with the bubble it previews, on the same screen. Both surfaces now keep the tags, and D3 asserts it on both. |
| 5 | A degenerate table falls back in the PLAN, carrying the BLOCK'S SOURCE | The plan module is the only place that holds the source string (§8.2 asks the fallback to "keep the source text"); the renderer never sees it. So the renderer never receives a degenerate table at all, and `{t:'table'}` always means a grid it can draw. |
| 6 | **The brief's premise about GFM pipes is the other way round, and T3(a) was rewritten around the property that matters** | MEASURED: `remark-gfm@4.0.1` gives THREE cells for `\| a \`b\|c\` d \| e \|` — an unescaped pipe inside a code span really does split the row, and GFM's own spec escapes it (`\|`) *"including inside other inline spans"*. So the claim asserted is the one the brief is protecting: the grid renders the cells the parser produced and never re-splits a cell's text on a pipe, and an ESCAPED pipe stays inside its cell. The unescaped case is asserted beside it as the boundary. Not reversed later anyway — this is what the parser in use does. |
| 7 | **§12.1 stands: math is NOT parsed in this batch** | The measurement the brief demanded: `npm view remark-math@6.0.0 dependencies` → `micromark-extension-math@^3.0.0`; `npm view micromark-extension-math@3.1.0 dependencies` → **`katex ^0.16.0`** and `@types/katex@^0.16.0`, i.e. a full typesetting engine, pulled in to produce a node this batch would paint as raw source text. `$x$` stays as typed (the user's choice). Reversing it later costs one pipeline line **if** a spike ever shows katex does not reach the Metro bundle; the artifact probe here asserts `katex`/`shiki` are not in this one. |
| 8 | Table geometry: fixed 140dp columns; code surface `colors.bg`; code text at `font.small + 1` | 140dp is over the §8.2 floor of 96 and FIXED, so a long cell wraps inside its column instead of widening the grid — which is what keeps the horizontal scroll predictable. The code block needs a surface "slightly darker than the bubble"; `colors.bg` is the app's own darkest colour, so no new colour was introduced (the bubble colours are `bubbleUser`/`bubbleAgent`, and `bubbleAgent` is already `panelAlt`). |
| 9 | The incoming text style is applied to every LEAF, and a container-ish prop on it therefore applies per block | RN cannot pass `color`/`fontSize` from a wrapper `View` into nested `Text`, so the alternative is not available. For the single-paragraph bodies this batch touches (a bubble, a reasoning blob) the result is IDENTICAL; a multi-paragraph body gets the style's bottom padding per paragraph instead of once. Documented rather than hidden, and it is the sort of thing a device check would see first. |
| 10 | The copy button's confirmation is ONE `setTimeout`, cleared on unmount | Not a poll: nothing is fetched, and the thread's own "exactly one `setInterval` on this screen" test still passes (count 1). A UI timer is the only thing in this batch that outlives its render, and it dies with it. |
| 11 | **The npm install pruned 19 peer-only packages, and the tree was RESTORED rather than shipped smaller** | The lockfile diff after `npm install --save --legacy-peer-deps unified/remark-parse/remark-gfm` names 19 removed entries — `react-native-reanimated`, `react-native-worklets`, `react-native-gesture-handler`, `react-dom`, `scheduler`, `@react-native/babel-preset` and 13 more — all present only as *satisfied peers* of `expo-router` / `expo-modules-core` / `react-native-drawer-layout`, because an earlier plain `npm install` had pulled them in. Nothing in the JS imports any of them (0 occurrences of `reanimated`/`gesture-handler` in the 0.11.0 bundle TOO), but the native libraries they autolink were in 0.11.0's artifact: the first assembly of this release came out **117,752,117 B (−13.2 MB)**. An unexplained 13 MB delta in a formatting release is exactly what nobody can attribute later, so the tree was restored with `npm install --no-save --legacy-peer-deps` at the versions the 0.11.0 lockfile pins, and the project rebuilt: **605 tasks / 605 executed** (the same shape as 0.11.0) → 131,042,013 B. The smaller artifact would have been *defensible*; the restored one is *attributable*, and that is worth 8 minutes. |
| 12 | The lockfile carries BOTH sets: 689 entries = 0.11.0's peers + npm's own 67 entries for the three new packages | `npm ci` on npm 11 will NOT install peer-only entries (`--legacy-peer-deps` drops them from the lock; merging them back in does not make `ci` install them — both measured). So reproduction of this tree needs the explicit `npm install --no-save --legacy-peer-deps` with the 19 specs at their locked versions, and that is written down here because the lockfile alone no longer says it. Recorded in `PROGRESS.md`'s 0.12.0 section too, with the exact route. |
| 13 | The verifier GENERATES the 0.12.0 item contract out of `tests/run.ts`, and its apostrophe guard needs a positive control | 0.11.0's lesson: a hand-typed contract goes stale the first time a test is renamed. The first draft of the apostrophe guard was itself the bug — it reported a false positive on a name with no apostrophe — so the check is now "does any 0.12.0 name line contain an ESCAPED apostrophe" plus a count proving there were names to check (a guard with nothing to guard proves nothing). |
| 14 | Every older gate is kept in `logs/verify-0.12.0.sh` | The 0.11.0, 0.10.1, 0.10.0, 0.9.0 and 0.9.1 named lists, the push park, the deployment measurements and the live-dashboard questions are all still there, and the script grew from 656 to 835 lines rather than being rewritten. No test was deleted to make room. |
| 15 | The desktop plugin's body-search matcher was LEFT matching the RAW preview, with a comment | Stripping before matching would change which rows answer a query — a search-semantics change smuggled into a formatting batch. The four DISPLAY call sites strip; the matcher deliberately does not, and the comment says which is which and why. |
