# GOAL-0.10.1 — Personae Mobile: the tailnet list scrolls, the address fields show `http://`, "1 · Service" stops asking twice, and Gateway Settings loses its clutter and gains a delete

Binding brief. This file, not your memory of any other brief, is the contract. Where this file is silent,
the existing repo conventions win. Where this file and the repo disagree, this file wins and you say so in
`PROGRESS.md`.

0.10.0 is shipped and signed (`logs/verify-0.10.0.txt` ends `RESULT: PASS — 0.10.0 verified`,
`dist/personae-0.10.0.apk`). This batch is **the user's review of the shipped 0.10.0 APK**, sent 2026-10-13
while looking at the shipped app on a real screen. He sent it in three messages — three points on the wizard,
then four on Gateway Settings, then two on the settings screens — and **all nine are quoted unedited at the
bottom of this file**.

This is a **fix batch, not a feature batch**: **eight items (S1–S8)** covering his **nine review points** —
two of his bullets are one item (S4), because they are the same kind of change on the same screen. Three
surfaces: the connection wizard, the Gateway Settings page, the settings screens. No new screen, no new step,
no new dependency, **no new string**, no server change.

Four of the eight are pure copy or order edits with **no new behaviour at all** (S4, S6, S7, S8). The other
four (S1, S2, S3, S5) each land on a module that already exists, is already pure, and is already covered —
except one new helper beside `connectionRows()` (S5), which is the batch's only new **exported** function.

## 0. What "done" means

- `dist/personae-0.10.1.apk` exists, `versionName 0.10.1`, `versionCode 13`, signed with the **same release
  key** as 0.1.0–0.10.0 (so it installs straight over 0.10.0, and over any 0.9.x).
- `logs/verify-0.10.1.sh` + `logs/verify-0.10.1.txt`, and the last line of the `.txt` reads
  `RESULT: PASS — 0.10.1 verified`. The verifier keeps the 0.10.0 **and** 0.9.1 named-test lists, the same
  way 0.10.0 kept 0.9.1's and 0.9.0's.
- `logs/red-0.10.1.sh` + `logs/red-0.10.1-S1.txt` … `-S8.txt` — one adversarial pass per **behavioural**
  item (S1–S8), the 0.10.0 lane. S9 is the version/record item and has nothing of its own to attack.
- Every item in §2 has a test that **names it** (`"0.10.1 S<n>: <what it asserts>"`), and each one fails
  **before** its change and passes **after**. A test that never went red proves nothing — say in
  `PROGRESS.md` how you saw it fail.
- App suite **≥ the 0.10.0 floor of 261** with the new named tests on top, 0 failed; server `77 passed`;
  `npx tsc --noEmit` rc 0.
- `PROGRESS.md` has a `## 0.10.1` section: what landed per item, every test count, the APK's
  path/bytes/sha256/signer beside 0.10.0's, §3's decisions one line each, and what could not be verified
  with the reason.

**Do not stop before that.** A failing item is a fix-and-retry, not a stopping point.

Baseline to beat, read from `logs/verify-0.10.0.txt` and `PROGRESS.md`'s `## 0.10.0` (do **not** re-derive
it from memory — if these numbers disagree with the files, the files win and say so):

```
app tests   261/261 passed, 0 failed          (floor 250 before 0.10.0)
server      server/run-tests.sh tests  ->  77 passed
verifier    103 PASS / 0 FAIL, RESULT: PASS — 0.10.0 verified
apk         dist/personae-0.10.0.apk  116979706 bytes
            sha256 3b231c830f154c5c3af64f9043297aa804430a343be23afe9e4e30286c464c2f
            com.personae.mobile / 12 / 0.10.0
min-sdk / target-sdk  24 / 36
signer      SHA-256 bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26
```

## 1. Standing rules

1. **One commit per item**, message prefixed `0.10.1 S<n>:` and naming the item it closes.
2. **Never print, echo or paste a credential.** Secrets live in `~/.hermes/.env`. The
   verifier asserts *zero* live bearer occurrences and zero host literals in the shipped bundle — keep it
   that way. Any value you ever see is `[REDACTED]` in anything you write.
3. **Do not restart `hermes-serve`.** It serves the live dashboard on `:9119`. Read from it, never bounce it.
4. **English only.** New strings need an EN entry. Leave the PT table in place, unreachable. This batch
   should add **no** new string at all (§3).
5. **Tests are the argument.** Follow the convention exactly: `"0.10.1 S<n>: <what it asserts>"`.
6. **No new dependency, native or JS, without saying so out loud** in `PROGRESS.md` with the reason. This
   batch needs none — every control it touches already exists.
7. **Nothing is verified visually.** No `adb`, no renderer for `app/*.tsx`. Specify every item as a claim
   the suite can prove — plan-as-data, style-array inspection, source-inspection — and put anything that is
   genuinely only visible on a phone in `PROGRESS.md` under **Not verified**, with that reason.
8. **The push work stays parked.** No `google-services.json`, no sender, no Firebase, nothing named "push".
9. **`~/Projects/hermes-desktop-plugins/personae` stays untouched.** The repo still has **no git remote** —
   do not add one, do not push; park it.
10. **Build with a leash.** `--max-workers=4`, `org.gradle.daemon=false`, long output to `logs/`, sequence
    it: code, then typecheck, then tests, then **one** build at the end.
11. **READ BEFORE YOU BUILD — this batch is three small edits inside code that already works.** Nothing here
    is invented. These exist and must be **extended, never re-implemented**:
    - `src/connect/Wizard.tsx` — ONE wizard, TWO hosts (`app/connect.tsx`, `app/settings.tsx`). The three
      step headings come from `src/connect/wizard.ts`; the branch cards are 0.10.0 S3.
    - `src/logic/peers.ts` + `GET /api/plugins/personae-mobile-auth/tailscale/peers` — the host enumerates
      the tailnet; a phone cannot. `peersState()` owns the empty/unavailable vocabulary.
    - `app/settings.tsx` — the Choose-device sheet (`<Modal>` → `Pressable style={styles.sheet}`), the peer
      probe path, and the Gateway page.
    - `src/settingsLayout.ts` — the module that exists so "the screen renders what the plan says" is
      assertable. New constants go here, not into a StyleSheet.
    - `src/i18n.ts` — `EN_ONLY_SETTINGS_KEYS` is the one group the EN-only mechanism narrows. A key that
      leaves the table must leave that list too.
    - `src/gateway/manage.ts::deleteRoute` — **the route deletion already exists and is already tested**
      (`tests/run.ts:5996-6020`: active→next route, last→empty, dead-only→`none-reachable`, and a
      `{routes, baseUrl, decision, empty}` patch that carries no credential field). S5 adds a **call site**,
      never a second implementation.
    - `src/gateway/connections.ts` — `connectionRows()` (each row carries `index`, the **drawn** index),
      `connectionLabel()`, `roleLabel()`. S5's new pure helper goes here, next to them.
    - `src/gateway/plan.ts` — `GATEWAY_SECTION_IDS`, `gatewaySectionIds()`, `gatewaySections()`, `sectionText()`.
      The page's order is a value in this module, not the JSX's order (S6).
    - `src/routes.ts::orderRoutes` — the single ordering rule. `deleteRoute` calls it internally, which is why
      a caller's index must already be in **that** space.
12. **No live probes against the user's real servers from the test suite.** Tests are plan-as-data or
    source-inspection. Nothing in `tests/` opens a socket to `10.0.0.15`, `100.x` or `:9119`.
13. **Index space: pass the DRAWN index.** `deleteRoute(settings, index, …)` orders the routes itself and
    indexes the ordered array — the same space `connectionRows()` returns as `row.index` and the Advanced
    editor gets from `orderRoutes(form.routes).map((route, index) => …)`. A raw `form.routes` index silently
    deletes a **different row** whenever stored priority ≠ display order. Any new call site must pass the
    drawn index, and the suite must prove it (S5).

## 2. The items

### S0 — the reading, written down

Three anchors, so nobody re-derives them and nobody "fixes" the wrong thing:

- **The sheet caps itself and then clips.** `app/settings.tsx:1806` sets `styles.sheet.maxHeight: '80%'`,
  and the body of the sheet renders `(peers?.peers ?? []).map(...)` (`:911-930`) with **no `ScrollView`**.
  So with more devices than fit, the rows are not merely off-screen — they are **clipped and
  unreachable**, and the Retry/Close row at the bottom stays pinned while the devices behind it cannot be
  scrolled to. The cap is there; the scroll is not.
- **The wizard's chip list has the other problem.** `src/connect/Wizard.tsx:605` maps peers unbounded inside
  the branch card. It *does* scroll, because the embedded wizard sits inside Settings' page ScrollView
  (`app/settings.tsx:681-1556`, the wizard at `:832`) — but a long tailnet buries "Or type the device name"
  and the port field a screen or more below the fold.
- **Step 1 asks twice.** `useLanAddress` (`Wizard.tsx:192`), `useRemoteAddress` (`:215`) and `pickPeer`
  (`:221`) each build the URL, `setAddress(url)`, `update({baseUrl, routes})` and `setStep('service')`.
  Step 1 then draws a **second** editable address field (`:655-680`, `t.connect.addressLabel`, placeholder
  `http://host:9119`) pre-filled with that same value, and the probe is **button-only** — no effect probes
  on entry. The user types the same server twice to earn a diagnosis.

### S1 — both tailnet lists are bounded and scrollable

the user: *"The tailscale device list has to be scrollable, in case the user has multiple devices that
surpass the screen view."*

- **The sheet**: wrap **only** the peer rows in a `ScrollView`. `sheetTitle` and the Retry/Close
  `rowButtons` stay **outside** it, pinned. Keep `maxHeight: '80%'` as the sheet's ceiling — the scroller
  lives inside it.
- **The orphaned gap.** The parent's `gap: space.sm` was doing the row spacing, and moving rows into a
  ScrollView loses it: put it back on the scroller via `contentContainerStyle`. Rows that collapse
  together is the classic regression of this exact change, and the suite must catch it.
- **The wizard's branch card**: a **bounded inner scroller** (`maxHeight` from the plan below) with
  `nestedScrollEnabled`. **Not** a second full-height `ScrollView`: `src/connect/Wizard.tsx:22-27` says the
  embedded host is a plain View on purpose — "a ScrollView inside Settings' ScrollView fights it for the
  gesture" — and that stays true for the body. A bounded inner list is how the peers stay reachable without
  burying the manual-entry field.
- **One source for the numbers**, so they are assertable: export `PEER_LIST_MAX_HEIGHT` (suggested: `260`)
  and `PEER_LIST_SCROLLS = true` from `src/settingsLayout.ts`, and have **both** call sites read them. A
  magic number inside a `StyleSheet.create` is not a testable claim.
- **Unchanged**: the empty/unavailable branches (one sentence, no scroller), `peerRow` / `chip` shapes,
  the probe-before-write path (`peerRoute` refuses a duplicate), `peersState()`'s vocabulary.

Tests (`0.10.1 S1: …`):

- the two constants exist and are positive, and `PEER_LIST_MAX_HEIGHT` is bounded below a phone screen;
- both call sites read them (source assertion — a hand-typed `260` in either file is a fail);
- in `app/settings.tsx`, the peers `.map(` sits inside a `<ScrollView` that sits inside `styles.sheet`,
  with the title and the action row **outside** it (source assertion over a bounded window);
- that ScrollView carries a `contentContainerStyle` with a `gap` (the orphaned-gap guard);
- the wizard's peers scroller carries `nestedScrollEnabled`, and the embedded path still does **not** wrap
  the whole body in a ScrollView.

### S2 — `http://` is a visible prefix, and the "numbers and dots" sentence goes

the user: *"In the IP fields, put `http://` to the left of them, and that way, you can remove the text
"numbers and dots only…" since it's implied."* — and his pick: **both** the LAN IP field and the remote
device-name field.

This refines 0.10.0 §2 rule 2 rather than reversing it: the prefix is still **the app's**, never typed and
never stored; it is now **shown**, which is what removes the sentence that had to explain it.

- Anchors: `wizIpHelp: 'Numbers and dots only, for example 192.168.1.50. The app adds http:// itself.'`
  (`src/i18n.ts:416`), rendered at `src/connect/Wizard.tsx:562` under the LAN IPv4 field (`:558`,
  `keyboardType="numbers-and-punctuation"`). The remote device-name field (`Wizard.tsx:614-623`, placeholder
  `my-desktop.tailnet.ts.net`) takes the same treatment — `remoteUrl()` (`src/connect/address.ts:104`) also
  always builds `http://`, so the prefix is true there too, and `wizHostHelp` (`src/i18n.ts:420`) is about
  the **name** only and needs no edit.
- **One compound field**: a row that carries the border and background (`inputRow`), a static `http://`
  (`inputPrefix`) at its left, and the `TextInput` inside with **no** border/background of its own and
  `flex: 1`. Two nested borders is the classic regression here.
- The prefix is **scheme-only**: four characters of literal text. No host, no port, no example address —
  0.10.0's first artifact was rejected by the verifier's own host-literal check for using the user's real LAN
  address as an example, and this change must not reintroduce that class.
- **The input law is untouched**: `ipInput` (digits and periods only), `pasteAddress`'s splitting,
  `keyboardType` per field, the placeholders, `portInput` on both port fields. The stored value stays the
  bare IPv4 / hostname; `lanUrl()` and `remoteUrl()` keep building the scheme.
- **`wizIpHelp` is DELETED**: the render site (`Wizard.tsx:562`), the key (`src/i18n.ts:416`) and its entry
  in `EN_ONLY_SETTINGS_KEYS` (`src/i18n.ts:809`). No file may reference the name afterwards.
- `wizPortHelp` **stays** (`'The port the dashboard listens on. Usually 9119.'`) — nothing on screen
  implies a port.
- **Not touched**: the four `keyboardType="url"` fields (`app/settings.tsx:1176`, `:1344`, `:1369`;
  `Wizard.tsx:666`). They legitimately hold `https://…` or a URL with a path, so a hardcoded `http://`
  there would be a lie.

Tests (`0.10.1 S2: …`):

- the literal `http://` is rendered immediately before each of the two inputs, inside the same bordered row
  (source assertion — a string-table key would not be a visible prefix);
- neither input carries the bordered `styles.input` inside that row (no double border);
- across `app/` + `src/`, `/wizIpHelp/` matches **zero** files, and `EN_ONLY_SETTINGS_KEYS` no longer lists
  it;
- `wizHostHelp` is still rendered under the remote field (nothing was dropped along with the sentence);
- the scheme is still the app's, not the user's: `lanUrl('192.168.1.50', 9119)` and
  `remoteUrl('x.tailnet.ts.net', 9119)` both still return `http://…` — the proof the prefix is display-only.

### S3 — "1 · Service" reports; it does not ask again

the user: *"Does the '1. Service' have to exist or has it become redundant?"* — and his pick, verbatim:
**"Result, not input: auto-probe the address the branch already set, keep the field read-only-ish for
correction, keep the wrong-service diagnosis (smallest change — wizard stays 3 steps)"**.

The step's **diagnosis** is not redundant: nothing else catches "you pointed at hermes-gateway.service — no
profiles, no sessions, the dashboard is `:9119`" and offers the one-tap correction (`t.connect.isGateway` +
`t.connect.useDashboardPort`). The **input** is redundant, and S0's third anchor is why.

- **The step opens as a result.** On entering `step === 'service'` with an address in hand, the probe runs
  **once, by itself**. Guard it with a ref holding the last probed address (the `scannedRef` style already
  in the file) so a re-render cannot re-probe and a **changed** address does probe again.
- **The probe becomes injectable**, so the suite can pin that: add `probe?: (url: string) =>
  Promise<ProbeVerdict>` to `WizardProps` (`Wizard.tsx:104`), defaulting to `probeService` from `../pairing`.
  Tests inject; they never open a socket (rule 12).
- **The address stops being the step's first ask.** Keep the current address visible as a plain line, keep
  the verdict card and the `use :9119 instead` correction, keep the suggestion chips (each is a one-tap
  correction) — and demote the editable input behind a "Change address" disclosure that is **closed by
  default when the wizard arrived with an address** from the branch card or a picked device. Entered with an
  **empty** address (resume, standalone, nothing stored), it is **open** — there the user genuinely has to
  type one.
- **Untouched**: `2 · Sign in`, `3 · Check` and its staged test, the deep-link/QR/paste paths,
  `wizardSession`'s resume state, the support-log share, both branch cards.
- **`WIZARD_STEP_IDS` stays `['service', 'sign-in', 'check']`.** `tests/run.ts:3624` and `:3631` must still
  pass **unmodified** — that is the "smallest change, wizard stays 3 steps" half of his pick, and editing
  those two assertions is exactly how this item would go wrong.

Tests (`0.10.1 S3: …`):

- a known address entering `service` probes **exactly once** and renders the verdict;
- a re-render with the same address does **not** probe again; a **changed** address does;
- the disclosure's initial state: closed when the address came from the branch/pick, open when the wizard
  opened with none;
- source assertion: the editable input sits inside the disclosure, and the step still shows
  `t.connect.addressLabel`'s value as text;
- `tests/run.ts:3624` / `:3631` unchanged and passing.

### S4 — the two sentences of chrome go

the user, on the Gateway Settings screen: *"Remove \"each field saves itself\" text"* and *"Remove \"Saved
MM:SS\" text"*.

Both are the same kind of thing — a line of self-explanation the screen does not need — so they are one item
with two deletions:

- **`t.settings.autoSave`** (`src/i18n.ts:340`, PT `:1146`) rendered at `app/settings.tsx:690` inside a
  `styles.hint` `Text`. The node and the EN key both go.
- **`t.settings.saved`** (`src/i18n.ts:332`) rendered at `app/settings.tsx:691-694` as
  `{t.settings.saved} · {formatTime(savedAt)}` — that is the "Saved MM:SS" he means. The whole conditional
  node and the EN key both go.
- **Neither is Gateway-specific.** They are page chrome: they render below the page `ScrollView`'s close and
  above the `page === 'gateway'` block, so they are on **every** settings page. He read them while reviewing
  Gateway Settings; there is no page that wants them, so the removal is **global**. If you find a page guard
  around either node, still remove it globally and record the finding in `PROGRESS.md`.
- **The orphans are what makes this more than two lines, and they are where the typecheck goes red.**
  `formatTime`'s import (`app/settings.tsx:45`) and the `savedAt` entry in the context destructure (`:90`)
  have **no other consumer in this file** — they must go with the node or `tsc --noEmit` fails. `styles.hint`
  (`:690`) and `styles.savedLine` (`:1640`) also become unused; unused style keys are **not** a typecheck
  error, so delete them if nothing else references them and otherwise leave them — say which you did.
- **`savedAt` stays in `SettingsContext`.** It is provider API, not this screen's property, and the
  instruction is about text, not about the mechanism. Remove the render, not the plumbing. (If you find
  another consumer of `savedAt`, keep it for that consumer and record it.)
- **The decoy — read this twice.** `src/i18n.ts:324` is `apiKeySet: 'saved'`: a **different key** whose
  *value* is the word "saved". It must still read `saved`. `savedKey: 'Key saved'`, `clearKey` and
  `clearKeyConfirm` are untouched. A zero-match test written as `/saved/` flags all four and invites exactly
  the wrong deletion — the tests below use `t\.settings\.saved\b` and `/autoSave/` on purpose.

Tests (`0.10.1 S4: …`):

- `'saved' in t.settings` is **false** and `'autoSave' in t.settings` is **false** — *and* `apiKeySet` still
  equals `'saved'` (the decoy guard, in the same test so they can never drift apart);
- `/autoSave/` and `/t\.settings\.saved\b/` match **zero** files across `app/` + `src/`;
- `formatTime` is **not** imported in `app/settings.tsx`, and neither `savedAt` nor `savedLine` is
  referenced there (the orphan guard — without it this item passes while the typecheck is red);
- the PT table keeps its own entries, untouched (it is unreachable copy; if the type system demands parity,
  remove there too and say so in `PROGRESS.md`).

### S5 — a connection can be removed from Gateway Settings

the user: *"The user should be able to remove the route they created."*

**The capability already exists, is already pure, and is already tested. It is simply somewhere he did not
look.** `deleteRoute()` (`src/gateway/manage.ts:104`) orders the routes, drops the drawn row, renumbers,
re-selects and returns `{routes, baseUrl, decision, empty}`; `tests/run.ts:5996-6020` already prove the
active-→-next case, the last-→-empty case, the dead-only `none-reachable` case, and that the patch carries no
credential field. Its **only** call site today is the Advanced page's route editor
(`app/settings.tsx:1298-1310`). This item adds a **second call site on the Gateway page**. It does not
re-implement the operation, and it does not change `deleteRoute`.

- **Where it goes: the Connection Status block**, which describes the selected connection and *already*
  hosts the one destructive verb about it — `revokeSelf`, "Revoke this device". A "Remove this connection"
  secondary/destructive action sits beside it and acts on the **selected** row. (The alternative — a
  destructive control inside each Connections row — was rejected: those rows' primary action is *select*, and
  a mis-tap in a picker list is a silent data loss with no undo. That judgement is recorded in §3.)
- **Reuse the three lines the Advanced editor already uses**, nothing more:
  `deleteRoute(form, selectedIndex, (candidate) => dotStateOf(dots, candidate.url) !== 'down')`, then
  `saveRoutes(patch.routes)` and `update({ baseUrl: patch.baseUrl })`. The predicate is the same one the dots
  supply, and `checking` is deliberately **not** `down` — an unprobed route stays eligible.
- **The index space is the trap (rule 13).** `selectedIndex` must be the **drawn** index that
  `connectionRows()` hands back as `row.index` — the space `deleteRoute` indexes after its own
  `orderRoutes()`. A raw `form.routes` index deletes a **different row** whenever stored priority ≠ display
  order. Prove it with a list whose stored order is not its display order.
- **Confirm before the write**, with the copy that already exists:
  `Alert.alert(t.routes.title, t.routes.removeConfirm(route.url), [t.roster.cancel, {text: t.routes.remove,
  style: 'destructive'}])` — the same shape and strings as the Advanced editor, so this batch still adds
  **no new string** (rule 4).
- **Selection after the delete is re-derived, never decremented.** After the patch, select the row whose url
  is `patch.baseUrl` (i.e. the newly active route); if there is none, `-1`, and the status block draws
  `t.settings.gwPickOne`. `selectedIndex - 1` is wrong when the deleted row sat **below** the selection and
  wrong again when it was the last one. Put the derivation in a **pure helper** in
  `src/gateway/connections.ts`, next to `connectionRows()`, so the suite can pin it — UI state is not
  testable on this host (rule 7).
- **The empty end state is the feature, not an edge case.** Removing the last route yields `baseUrl: ''` and
  `empty: true`; the page then draws `t.routes.empty` in the list and the Connection Wizard button is
  already right there (0.10.0 S1.4). Nothing new to build — assert it.
- **Untouched**: the device/credential path (`revokeSelf`, the per-server device token, "forget the device on
  the server" stays its own explicit action — deleting a route touches the route list and nothing else), the
  Advanced editor's own delete, `moveRoute`, `renameRoute`, `manualAdd`, `checkRoute`.

Tests (`0.10.1 S5: …`):

- **the drawn-index proof**: from a route list whose stored order is **not** its display order, deleting drawn
  row *n* removes the URL the user saw — and the paired assertion that a raw-index call would not;
- `selectionAfterDelete(rows, baseUrl)` returns the new active row's index, returns `-1` when nothing is
  left, and (the regression) is **not** `selectedIndex - 1` when the deleted row is below the selection;
- deleting the last route leaves `baseUrl === ''`, `empty === true`, `decision.reason === 'no-routes'`, and
  the wizard button is what the page draws in that state (source assertion);
- source assertion: the Gateway page calls `deleteRoute(` and reuses `t.routes.removeConfirm` /
  `t.roster.cancel` — no new key appears;
- `tests/run.ts:6003`'s credential-free `Object.keys(patch)` assertion still passes unedited.

### S6 — the page's order is status, then connections, then the pills

the user: *"Put \"Connection status\" section on top, \"Connections\" below, \"Local\" and \"Remote\" pills
underneath for prioritization."*

This **supersedes** 0.10.0's reading of his own §4 list, which drew the dropdown first (his item 1: "a
dropdown that lists all created connections") and the status panel second — even though his item 2 in the
same message said "put it on the top". The later message resolves the contradiction: **status first**.

- `GATEWAY_SECTION_IDS` (`src/gateway/plan.ts:39`) becomes
  `['status', 'connections', 'pills', 'wizard', 'link', 'advanced']`, and the two JSX blocks swap in
  `app/settings.tsx` (the status block, currently `:748-786`, moves above the connections block, currently
  `:710-746`). Their `0.10.0 S1.x` comments get updated to record the reorder **and the new instruction**.
- **The Advanced page's cross-reference goes stale with this move and must be fixed in the same commit.**
  `app/settings.tsx:1389` reads `0.10.0 S1.3 — the preferred-kind pills MOVED to the top of Gateway Settings`.
  After S6 the pills are not at the top; that comment becomes a false statement about the screen it describes.
  Rewrite it to say where they are (third, below the connections list) — comment only, no code change there.
- `plan.ts`'s doc header must record this instruction **with the date**, so a later reader cannot "restore"
  the old order from the earlier list. This module exists precisely so the reason lives next to the value
  (`WHY THIS IS DATA AND NOT JSX`).
- **The invariant that changes is pinned inside a 0.10.0-named test.** `tests/run.ts:5428`
  (`'0.10.0 S1: the gateway page is a plan — connections, status, pills, wizard, Advanced last'`) asserts the
  old order at `:5432` (`deepEqual`) and `:5433` (`at('connections') < at('status')`, message *"the dropdown
  is first"*). This batch **rewrites those three lines and the test's name** to the 0.10.1 shape:
  `assert.deepEqual(gatewaySectionIds(), ['status','connections','pills','wizard','link','advanced'])`,
  `assert.ok(at('status') < at('connections'), 'the status panel is first')`, and a new name —
  `'0.10.1 S6: the gateway page is a plan — status on top, connections below, pills, wizard, Advanced last'`.
  This is the batch's one deliberate **cross-batch** edit: declare it in `PROGRESS.md` as a superseded
  assertion so a reviewer does not read it as a weakened invariant. Every *other* assertion in that test stays
  exactly as it is — status < pills, pills < wizard, wizard < advanced, Advanced last (`:5437`), the
  titleKey/helpKey loop (`:5438-5445`), and the source assertions at `:5506-5509`.
- **Unchanged**: what each section contains, the pills' visibility rule (a single kind draws no pills at
  all), `wizardButtonAction()`, and the selection starting on the first drawn row (`useState(0)`, `:5509`).

Tests (`0.10.1 S6: …`):

- the rewritten order block above (deepEqual + the inverted pair + Advanced still last);
- source assertion over a bounded window of `app/settings.tsx` that the **status** block precedes the
  **connections** block in the file — the plan's order and the screen's order must not be allowed to drift
  apart.

### S7 — Agent Preferences: the help sentence sits directly under the heading

the user: *"Move the 'What the session list...' text to underneath 'Display Session Types'"*.

- The sentence is `t.settings.sessionTypesHelp` (`src/i18n.ts:294-296`): *"What the session list shows. This is
  a display filter: nothing is turned off or changed by it, and each kind can be shown or hidden on its own."*
  It already exists. **Nothing is added, deleted or reworded — this is a pure render-order move.**
- Today it renders at `app/settings.tsx:1009`, **below** the four checkbox rows (`:988-1008`). "Underneath
  Display Session Types" means directly under the heading (`:987`): the sentence moves between the label and
  the checkbox map.
- **The block's own comment already describes the intended layout.** `app/settings.tsx:979-984` says *"the
  help text under the title says plainly that nothing is switched off by any of this"* — the render drifted
  below the boxes, so the comment describes a screen the code does not have. Fix the render and the comment
  becomes true again; do not "fix" the comment to match the old layout. (Same class as 0.10.0's session-order
  bug: a docstring stating an intent the code had abandoned.)
- **Stays exactly where it is:** the label first, the per-type label + help pair inside each checkbox row, and
  `t.settings.typeNoneWarning` **last**. That warning is about the *current state* ("no type is checked, so the
  session list is empty"), not an explanation of the section, so it must remain **after** the choices it talks
  about. Dragging it up with the help sentence is this item's regression.
- No key changes, no `EN_ONLY_SETTINGS_KEYS` change, no PT change.

Tests (`0.10.1 S7: …`):

- one ordered source assertion over a **bounded window** of the session-types block (`app/settings.tsx`, the
  `<View style={styles.field}>` that opens at `:986`): the index of `t.settings.sessionTypes}` (the label) <
  `t.settings.sessionTypesHelp` < `sessionTypeChoices(` < `t.settings.typeNoneWarning`. Four positions, one
  assertion — that is the whole item;
- `tests/run.ts:5195-5196` (the copy is still a display-filter sentence), `:5207`, `:5209` and
  `:5242` pass **unedited** — the words did not change, only their position;
- `visibleFieldIds(false).indexOf('sessionTypes') === 1` (`tests/run.ts:3605`) still passes: this touched no
  plan.

### S8 — the main Settings page loses its "Each row opens…" sentence

the user: *"remove 'Each row opens...' text"*.

- The string is `t.settings.pagesHelp` (`src/i18n.ts:365`): *"Each row opens its own page. Everything below it
  is unchanged."*, rendered at `app/settings.tsx:649`, directly under the page title.
- Remove the render node (`:649`) **and** the EN key (`:365`). `t.settings.pagesTitle` (`:648`) **stays** — the
  screen keeps its title, it just stops explaining itself.
- **Two decoys, and both must survive.** (1) `t.settings.pages[row.help]` — the **per-row** help sentences
  (`agentHelp`, `notificationsHelp`, `gatewayHelp`, `advancedHelp`) live on the rows in the
  `src/settingsPages.ts` plan and are a different thing entirely; the index is *made of* those, and the
  accessibility label at `:655` reads them. (2) `pagesTitle` is a different key. A zero-match test must name
  the exact key (`/pagesHelp/`, and `'pagesHelp' in t.settings === false`) and never `/pages/`.
- No test references `pagesHelp` anywhere in `tests/` (checked), so this item **adds** an assertion rather than
  rewriting one — unlike S6. PT `:1171` follows the usual rule: leave it, unless the type system demands
  parity, in which case remove there too and say so.

Tests (`0.10.1 S8: …`):

- `'pagesHelp' in t.settings` is **false** — *and*, in the same test, `pagesTitle` plus all four
  `t.settings.pages.*Help` keys are still present and non-empty (the decoy guard, kept together so the two can
  never drift);
- `/pagesHelp/` matches **zero** files across `app/` + `src/`;
- source assertion: the index page still renders each row's own help (the `t.settings.pages[row.help]`
  accessibility label, `app/settings.tsx:655`) — the rows' sentences were not collateral.

### S9 — version, verifier, record

- `app.json` (`:5` version, `:21` versionCode) and `package.json` (`:3`) → `0.10.1` / `13`.
- `logs/verify-0.10.1.sh` + `.txt` copied from the 0.10.0 shape with the numbers bumped, keeping 0.10.0's
  and 0.9.1's named-test lists.
- One leashed build to `logs/gradle-v0101.log`; artifact copied to `dist/personae-0.10.1.apk`; bytes /
  sha256 / signer SHA-256 printed beside 0.10.0's values in `PROGRESS.md`, and `app.json`'s version pair
  confirmed against the APK's own summary.

## 3. Decisions taken on the user's behalf (one line each in `PROGRESS.md`)

- **One constant pair for both lists**, in `src/settingsLayout.ts`, because a literal inside a StyleSheet is
  not an assertable claim.
- **The sheet keeps `maxHeight: '80%'` and gains the inner scroller**; the wizard's list is **bounded**, not
  full-height, because the embedded host is deliberately not a scroller (`Wizard.tsx:22-27`).
- **The prefix is a plain `Text`**, not a typed or masked character: the value stays the bare
  IPv4 / hostname and the scheme stays the app's.
- **Step 1's disclosure defaults by origin** — branch/pick → closed; no address → open.
- **The probe goes injectable as an optional prop**, not a module mock, matching
  `stagedConnectionTest`'s injected-deps style.
- **No new string is added.** The prefix is a literal; the one sentence is deleted; nothing else changes
  wording, so the PT table stays untouched and `EN_ONLY_SETTINGS_KEYS` only shrinks. This stays true after
  S4–S6: the two deleted sentences are deletions, and the remove action reuses `t.routes.remove` /
  `t.routes.removeConfirm` / `t.roster.cancel`, which the Advanced editor already renders. **Two keys leave
  the EN table (`saved`, `autoSave`) and nothing is added.**
- **The remove verb lives in the Connection Status block**, beside `revokeSelf` — the panel that already owns
  the destructive verbs about the *selected* connection — rather than inside each Connections row, where the
  row's primary action is *select* and a mis-tap loses a connection with nothing to undo. His words ("remove
  the route they created") do not name a placement; **this is the one call in the batch worth second-guessing
  if he wants it on the rows instead.**
- **`deleteRoute` is reused and unchanged** (rule 11). If it turns out to need a change to serve the second
  call site, that is a finding — stop and say so rather than growing it.
- **The selection after a delete is derived from the patch** (`patch.baseUrl`'s row, else `-1`), never
  `selectedIndex - 1`: a raw decrement is wrong for a delete below the selection and for the last row.
- **Both chrome sentences are removed globally**, not only on Gateway Settings: they render on every settings
  page, and there is no page that wants them.
- **`savedAt` stays in `SettingsContext`**; only the render and its now-orphaned `formatTime` import go. The
  instruction was about text, and the provider is not this screen's property.
- **S6 supersedes a passing 0.10.0 assertion inside a 0.10.0-named test** — the batch's only rewritten test.
  Deliberate: the order is the user's, the old assertion now contradicts it, and the test's **name** changes with
  the assertion so the supersession is legible in the diff instead of looking like a weakened invariant.
- **S7 is a move, not a rewrite.** The sentence was already the right sentence; only its position was wrong, so
  no key, no list and no copy changes — and the block's own comment already documented the intended position,
  which means the render was what drifted from the intent, not the comment.
- **`typeNoneWarning` stays last on purpose.** It reports a state the user just created by unchecking
  everything; it is not part of the section's explanation, so it does not travel up with it. Promoting it
  alongside the help sentence is the regression S7's assertion exists to catch.
- **S8 removes the node *and* the key**, the same rule as S4: a node-only deletion leaves an orphaned string in
  the table for someone to re-render later, and the zero-match test cannot tell the difference.
- **The index's rows keep their own help sentences** (`t.settings.pages[row.help]`): the screen still explains
  every row. It only stops explaining *itself*.

Noticed while reading, **not in scope**, do not "fix" it in this batch: the header comment at
`src/connect/Wizard.tsx:10` reads `(:9222 = hermes-gateway.service, …)` while no user-visible string names
a gateway port. If you touch that comment at all, verify the port against the live services first — a wrong
port in a comment is how a wrong port reaches the screen.

## 4. Verification and the build

Run, in this order, and keep the output:

```bash
npx tsc --noEmit                                    # rc 0
npm test                                            # >= 261 + the new 0.10.1 tests, 0 failed
server/run-tests.sh tests                           # >= 77 passed
```

Then the verifier (§S9), then the one build, leashed:

```bash
cd android && ./gradlew assembleRelease --max-workers=4 -Dorg.gradle.daemon=false > ../logs/gradle-v0101.log 2>&1
```

## 5. Where everything is

| thing | file |
|---|---|
| the sheet that clips | `app/settings.tsx` — `styles.sheet` `:1798` (`maxHeight: '80%'` `:1806`), the peers `.map(` `:911-930`, the pinned action row `:932-940` |
| the page scroll the wizard sits in | `app/settings.tsx:681` (ScrollView), `<ConnectWizard embedded …>` `:832` |
| the wizard's chip list | `src/connect/Wizard.tsx` — the remote branch card `:594-650`, the peers `.map(` `:605` |
| the two address inputs | `src/connect/Wizard.tsx:558` (LAN IPv4), `:614-623` (remote device name), step 1's field `:655-680` |
| the sentences | `src/i18n.ts` — `wizIpHelp` `:416`, `wizPortHelp` `:418`, `wizHostHelp` `:420`, `EN_ONLY_SETTINGS_KEYS` `:766` (entry `:809`) |
| the schemes | `src/connect/address.ts` — `lanUrl` `:80`, `remoteUrl` `:104`, `ipInput`, `portInput`, `portOr`, `splitAddress` |
| the branch that writes the address | `src/connect/Wizard.tsx` — `useLanAddress` `:192`, `useRemoteAddress` `:215`, `pickPeer` `:221` |
| the probe | `src/pairing.ts` (`probeService`, `ProbeVerdict`), rendered in `Wizard.tsx:682-700` |
| the plan module for the new constants | `src/settingsLayout.ts` |
| the step ids (must not change) | `src/connect/wizard.ts` — `WIZARD_STEP_IDS` `:20`, `wizardSteps` `:30` |
| the assertions that must stay unedited | `tests/run.ts:3624`, `:3631` |
| the Gateway page's sections | `app/settings.tsx` — connections `:710-746` (comment `:709`), status `:748-786` (`:747`), pills `:788-816` (`:787`), wizard button `:818-847` (`:817`), connectivity `:849`; the order value is `src/gateway/plan.ts:39` |
| the order's pinned assertion (rewritten by S6) | `tests/run.ts:5428` (name), `:5432` (deepEqual), `:5433` (`at()` pair); the rest of the test `:5434-5445`, `:5506-5509` stays |
| the two sentences to delete | `src/i18n.ts` — `saved` `:332`, `autoSave` `:340` (PT `:1146`); rendered `app/settings.tsx:690` and `:691-694`; orphans `formatTime` import `:45`, `savedAt` destructure `:90`, `styles.hint` `:690`, `styles.savedLine` `:1640` |
| the decoy string (must survive) | `src/i18n.ts:324` — `apiKeySet: 'saved'`, a different key |
| route deletion (reuse, never rebuild) | `src/gateway/manage.ts:104` (`deleteRoute`), tests `tests/run.ts:5996-6020`; existing call site `app/settings.tsx:1298-1310` |
| the rows' reader and the new selection helper | `src/gateway/connections.ts` — `connectionLabel` `:60`, `connectionRows` `:72` |
| the ordering rule the index must match | `src/routes.ts:211` (`orderRoutes`) |
| the session-types block (S7) | `app/settings.tsx` — label `:987`, checkboxes `:988-1008`, help `:1009`, warning `:1010`; keys `src/i18n.ts:294-296` (`sessionTypes`, `sessionTypesHelp`), `:311` (`typeNoneWarning`) |
| the main page's sentence (S8) | `src/i18n.ts:365` (`pagesHelp`), rendered `app/settings.tsx:649`; next to it `pagesTitle` `:648` (stays) and the per-row help label `:655` (stays) |
| the settings-pages plan (per-row help must survive) | `src/settingsPages.ts` — the rows and their `title`/`help` keys |
| package version | `app.json:5`, `app.json:21`, `package.json:3` |
| verifier | `logs/verify-0.10.0.sh` + `.txt` — copy the shape, bump the numbers |

## 6. Report

`PROGRESS.md` gets a `## 0.10.1` section in the shape of 0.10.0's: what landed per item, every test count,
the APK's path/bytes/sha256/signer, §3's decisions one line each, and what could not be verified with the
reason. Then stop — that is the finish line.

---

the user's own words for this batch, kept so nobody paraphrases them later:

> - The tailscale device list has to be scrollable, in case the user has multiple devices that surpass the
>   screen view.
> - In the IP fields, put "http://" to the left of them, and that way, you can remove the text "numbers and
>   dots only..." since it's implied.
> - Does the "1. Service" have to exist or has it become redundant?

His follow-up message, same screen, same day — "Add the following: In the Gateway Settings":

> - The user should be able to remove the route they created.
> - Remove "each field saves itself" text
> - Remove "Saved MM:SS" text
> - Put "Connection status" section on top, "Connections" below, "Local" and "Remote" pills underneath for
>   prioritization

That fourth bullet is the later word on the order and **supersedes** the order his 0.10.0 §4 list implied
(dropdown first). S6 records it with the date in `plan.ts`, where the ordering value lives.

His third message, the settings screens:

> In Agent Preferences
> - Move the "What the session list..." text to underneath "Display Session Types"
>
> In Main Settings page:
> - remove "Each row opens..." text

Both are copy positions, not copy changes: S7 moves a sentence that already exists, S8 deletes one. Neither
alters a word.

His answer to his own third question, and the two follow-ups I asked, verbatim:

> Result, not input: auto-probe the address the branch already set, keep the field read-only-ish for
> correction, keep the wrong-service diagnosis (smallest change — wizard stays 3 steps)
> Both the LAN IP field and the remote device-name field (the app builds http:// in either case;
> wizHostHelp needs no edit)
> Hold — write the brief and let me read it first
