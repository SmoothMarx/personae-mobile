# PLAN 0.7.0 — five fixes on top of 0.6.1

_Written 2026-10-11. Reference document. The binding contract for the build run is `GOAL-0.7.0.md` —
where the two disagree, the goal file wins._

0.6.1 was branding only. 0.7.0 is five product changes the user asked for after using 0.6.1 on the
phone. No server-side feature is being removed and nothing in 0.6.x regresses.

## 0 · Where 0.6.1 actually is (measured 2026-10-11, in this session)

| Fact | Command | Value |
|---|---|---|
| app tests | `npm test` | **145/145 passed, 0 failed** |
| typecheck | `npx tsc --noEmit` | **rc 0** |
| server tests | `~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q` | **43 passed in 1.77s** |
| shipped artifact | `ls dist/` | `personae-0.6.1.apk` · versionCode 7 · 114 272 009 B |
| dashboard backend | `systemctl --user cat hermes-serve.service` | `hermes dashboard --host 0.0.0.0 --port 9119`, v0.21.5 |
| addresses that answer | `hostname -I`, `tailscale ip -4` | `10.0.0.15` (LAN) · `100.64.0.11` (tailnet) |
| the app's surfaces | `wc -l app/*.tsx src/*.ts` | `app/settings.tsx` 965 · `app/index.tsx` 656 · `app/connect.tsx` 362 · `src/roster/*` |

## 1 · Settings: the wizard becomes "Connection", the list moves under "Advanced"

**Today.** `app/settings.tsx` (965 lines) is one flat `ScrollView` of ~15 field blocks in this
order: heal note → **Connection** (`:283` — a title plus a *button* that pushes to `/connect`) →
language → surface → address/bearer → … → **Ligação** (`:621`) → diagnostics → test → log. The
actual wizard lives on another route (`app/connect.tsx`, 362 lines, three steps documented at
`:8-12`: **Service** → **Sign in** → **Check**).

**Target.** The Connection section *is* the wizard — its three steps inline, in place, as the first
thing on the screen. Everything else (surface, address, bearer, deadlines, package name,
diagnostics, log) collapses under an **Advanced** disclosure, closed by default.

**How, without two copies of the wizard.** `app/connect.tsx` must keep existing: it is the landing
route for `personae://connect?base=…&code=…` (deep link, QR scan, in-app-browser redirect all
arrive there). So extract the three steps into shared components (`src/connect/steps.tsx`) and have
**both** the route and the Settings section render them. One implementation, two hosts.
`app/connect.tsx` becomes a thin route wrapper.

**Acceptance:** on a fresh install, Settings opens on a Connection section that shows Service state,
the three sign-in affordances and the Check result without navigating anywhere; the raw field list
is reachable but not visible until Advanced is opened; the deep link still lands on a working
wizard.

## 2 · Tailscale: three options, not five knobs

**Today** (`app/settings.tsx:621-679`): an `autoConnect` switch, a **free-text package name**
(`tailscalePackage`, default `com.tailscale.ipn`), a connect deadline in seconds, a probe timeout in
seconds, and an "open on failure" switch. Four of those five are internals a user cannot reason
about.

**Target** — the whole section reduces to:

| Option | Behaviour |
|---|---|
| **Log in** | Opens the Tailscale app (`openPackage`) with copy that says sign in there and come back. State shown is honest: installed? (`isPackageInstalled`) · tunnel answering? (`probeTcp` to a known route) |
| **Choose device** | A picker of the machines you can connect to. Choosing one derives its address and writes it as a route |
| **Automatically start Tailscale with the app** | The existing `autoConnect`, promoted to the section's primary switch |

Package name and both timeouts move under Advanced. Nothing is deleted.

**The one hard part — where the device list comes from.** The phone *cannot* enumerate a tailnet:
`src/native/tailscale.ts` exposes exactly `isPackageInstalled`, `triggerConnect`,
`triggerDisconnect`, `openApp`, `vpnTransportActive`, `probeTcp` — no status, no peer list, and
Android has no public API for one. The **host** can, and already does:

```
$ tailscale status --json            # on the Hermes host
self: personae-sk   100.64.0.11   online: True
peers: 33            # hostname + IPv4 + OS + online, e.g. Personae-DS 100.64.0.13 linux True
```

So the picker's source of truth is a **new endpoint on the pairing plugin**
(`server/personae-mobile-auth/`), owner-gated like its siblings, returning `{self, peers:[{name,
ip, os, online}]}` filtered to IPv4. The app materialises the pick from
`src/routes.ts`'s existing route model (`role: 'tailscale'`) and probes it before trusting it.

**Chicken-and-egg, stated plainly:** before any route works the phone has nothing to ask. The
picker therefore populates **after** a first successful pairing/connection, and when the pairing
link's own host is already a `100.x` address that one is offered first. Manual entry stays under
Advanced as the escape hatch.

**Acceptance:** the section shows three affordances and no package-name field; the picker lists the
host's tailnet peers with IPs; picking one writes a route that a probe confirms; the numeric knobs
are intact under Advanced.

## 3 · Avatars much bigger — Telegram as the reference

**Measured from the file the user linked** (Figma fileKey `bbuc1DU76urt0JmakirYAd`, page `0:1`;
the Chats frame is 360 wide, so 1 px = 1 dp):

| Element | Node | Size |
|---|---|---|
| Chat row | `8:4771` | **360 × 70** (content box 62, 4 px top inset) |
| Avatar slot | `8:4775` | **58 × 58** holding ellipse `8:4776` **54 × 54** |
| Text column starts | `8:4778` @ x=70 | = 16 inset + 54 avatar + **16 gap** |
| Title / preview | `8:4780` / `8:4786` | 19 dp / 18 dp, 27 dp line pitch |
| Divider | `8:4806` | inset to **x=78** (clears the avatar) |
| Unread counter | `8:4804` | 24 × 24 |
| Stories rail circles | `9:4807…` | 54 × 74 · search icon 24 |

**Today in the app:** `AVATAR_SIZE = 28` (`src/logic/avatars.ts:23`) and `Face`'s default
`size ?? 32` (`src/roster/components.tsx:58`). The reference is **54 dp** — about **1.9×**.

**Change:** `AVATAR_SIZE 28 → 54`; `Face` default 32 → 54; roster row ≈70 dp tall; 16 dp between
avatar and text; dividers inset to clear the avatar; monogram scaling already `0.42 × size`
(→ 23 dp at 54 — check it against a 2-character monogram, Telegram's own is ~20-22 dp).
`avatarKey()` includes the size, so a size change fetches fresh art instead of serving a 28 px blob
from the AsyncStorage cache. `AVATAR_VERSION` needs no bump.

**Note, once:** Telegram's compose action is a 53 × 53 **bottom-right FAB** (`59:1953`). Item 5 asks
for a "+" **at the top** instead. That is a deliberate departure from the reference, not an
oversight.

## 4 · Multiselect and session grouping (parity with the desktop pane)

**Today in the app: nothing.** `grep -rn 'multiselect|selectionMode|groupSessions|createGroup' src app`
returns zero. Sessions can only be acted on one at a time through `sessionMenuEntries`
(`src/roster/menus.ts:53`).

**The semantics already exist on the desktop** (`~/.hermes/desktop-plugins/messenger/plugin.js`,
8 365 lines) and should be copied, not reinvented:

- groups are **per profile** (`profileSessionGroups`, `:944-946`);
- a group **holds members; it is never a parent** — children keep **no** `parent_session_id`, so a
  session released from a group cannot fall back into it (`:747`, `:786`);
- the group renders as a box (diamond + name) with its members drawn inside it
  (`sessionGroupShell`, `:845`);
- moving a session into/out of a group goes through one target resolver
  (`sessionGroupMoveTargets`, `:1110`).

**In the app:** long-press a session → selection mode; tap to extend the selection; a selection bar
carries the batch verbs (group, archive, delete behind the existing confirm) alongside the actions
that make sense for one item. "Group" on a selection creates a group containing those sessions.

**The real risk in this item is not the UI, it is the store.** `src/sync/uiSync.ts` already syncs
the phone's groups with the desktop's (seed once, monotonic `rev`, tombstones — tests 140-145). The
new grouping must ride **that** store. Two sources of truth for "which sessions are in group X" is
a data-loss bug wearing a UI costume.

**Acceptance:** two or more sessions can be selected, grouped, and the group survives a sync round
trip through `uiSync` with the desktop's rules; a group emptied of members does not linger.

## 5 · One "+" at the top: new group / new profile / new session

**Today:** creation verbs are scattered. `profileMenuEntries` has `new-session` per profile
(`menus.ts:33`), `sectionMenuEntries` has rename/delete only, and group creation is a `'group'`
prompt in `app/index.tsx` (`:571`).

**Target:** a single **"+"** in the roster header opening a small dropdown:

| Entry | Behaviour |
|---|---|
| **New group** | the existing group-name prompt |
| **New profile** | **new call**: `POST /api/profiles` — verified present in the *installed* dashboard (`~/.hermes/hermes-agent/hermes_cli/web_routers/profiles.py:803`), body `ProfileCreate` (name, clone_from / clone_from_default, description, provider, model, …), returns `{ok, name, path, model_set, model_error, …}` |
| **New session** | a **modal listing existing profiles** → pick the owner → then the existing title prompt |

The session modal exists because a session is meaningless without an owner, and today that choice is
implicit in *which profile row you long-pressed*.

**Acceptance:** "+" opens a three-entry dropdown; New session shows every profile from `/api/profiles`
and creates the session under the chosen one; New profile creates a real profile that appears in the
roster after refresh; New group behaves as today.

## 6 · Phases and the budget cut

Ordered so the cheap, visible, zero-backend work banks first and the largest item can be deferred
without breaking the release:

| Phase | Items | Backend work | Why here |
|---|---|---|---|
| **A** | 3 (avatars + geometry) | none | highest visual payoff per line, no server risk |
| **B** | 1 + 2 (settings + Tailscale) | one owner-gated endpoint | the risky unknown sits here and is pre-approved below |
| **C** | 5 ("+" menu) | none new — `POST /api/profiles` already exists | recomposes existing pieces |
| **D** | 4 (multiselect + groups) | none, but touches the sync store | largest; **deferred by name** if the run budget runs out |

Version: **0.7.0 / versionCode 8** — feature changes, so a minor bump; the 0.6.1 leatherette stays
as the branding release. The release key must be unchanged (`bd40e005…dd37f26`) or the APK will not
install over 0.6.1.

## 7 · Models: frontier for the plan and the gates, cheap for the passes

Ground truth, fetched live 2026-10-11T19:43Z (Nous catalog,
`https://portal.nousresearch.com/api/nous/recommended-models` — public, no auth), plus the lab's
own ledger (`~/Projects/model-fit/ROUTING.md`, generated 2026-09-30, fresh at 11 days):

| Role | Candidate | Cost | Evidence |
|---|---|---|---|
| Every implementation pass | `deepseek-flash@deepseek` | **$0.002/call** in-session (measured, run #4: 10 calls $0.02) | tier-A: 7/7 stages routed to it |
| Reviewer at every gate | `z-ai/glm-5.2@nous` | $0.0073/success | tier-A `dev-review`; **different family — required** |
| Plan + goal review (once) | `stepfun/step-5-preview:free` | **$0.00/1M** inside the plan | listed free *and* paid; **unprobed** |
| Plan review, paid backstop | `x-ai/grok-4.7` | $0.31 per 120k-in/12k-out call | $2/$6 per 1M |
| …if you want the top shelf | `openai/gpt-6-astra-flex` | $0.90 same call | $5/$25 per 1M |

Two facts that decide this:

1. **Opus is not on the menu any more.** The catalog today carries no Opus and no Fable. Opus was
   withdrawn on measurement anyway: the same probe costs **$0.215 vs $0.0041 — 52.4×**.
2. **The cheap model already cleared the planning stages.** `ROUTING.md` routes stage 1 (spec →
   plan) and stage 2 (architecture) to `deepseek-flash` at $0.0029 and $0.0006 per success. But the
   skill is explicit that stages 0-2 grade against an answer key, not by execution — so that is a
   filter against constraint-blind models, not proof of good judgement, and `dev-arch` is its
   weakest probe. Planning is where being wrong is expensive and invisible, which is exactly the
   case the user is making.

So the honest recommendation is not "pick a frontier model", it is **probe first, then pin** — the
lab's own rule that an unprobed model is a candidate, never a default. The runner lives in the
skill, not this repo (the workspace is data-only):

```bash
LAB=~/.hermes/shared-skills/model-selection-lab
python3 $LAB/scripts/run_probes.py \
  --models stepfun/step-5-preview:free@nous,x-ai/grok-4.7@nous,deepseek-flash@deepseek \
  --probes dev-spec,dev-arch --budget 1.0 --dry-run     # then drop --dry-run
```

**Run 2026-10-11 19:52Z.** Dry run: 4 cells to run, **2 already fresh and skipped** — the
incumbent's two cells, so `deepseek-flash` is not re-billed — projected $0.20 against a $1.00 cap.
Preflight, no spend: `nous` credential present, pool = 1, `active_provider=nous`, device-code token
obtained 19:06Z, expiry 20:06Z, `inference_base_url=https://inference-api.nousresearch.com/v1`;
`deepseek` and `gemini` structure ok. (The lab's README still records "credential pool empty on
`default`; OAuth relogin required" as a tier-0 fact — that is **stale as of today**, corrected in
place.)

Two cells per model, one of the three free to run, ceiling $1. If `step-5-preview` clears the bar,
plan review costs **$0** and it is worth adding `stepfun` to `recommend_roster` (one line in
`config.json` — a deliberate human edit, not a side effect of a run). If it does not, `grok-4.7` at
$0.31 a call is still 30× cheaper than an Opus pass and 5.8× cheaper than astra-pro.

**One caveat kept honest:** `z-ai/glm-5.3:US` exists in the catalog and is newer than the probed
`glm-5.2`. Newer is a candidate, not a promotion — keep `glm-5.2` as the reviewer so the ledger's
evidence still applies, and probe 5.3 before switching.

## 8 · What could still bite

| Risk | Shape | Pre-approved response |
|---|---|---|
| The Tailscale endpoint | `tailscale status --json` needs the Tailscale CLI on the host; output shape is a version-dependent JSON blob | endpoint returns `{available:false, reason}` if the CLI is missing or the output is unparseable; the app then falls back to manual entry, and that is a pass, not a failure |
| Group sync (item 4) | phone and desktop disagreeing over group membership | land item 4 in its own commit with its own sync test; if it cannot be proven, ship A-C and defer D by name |
| Avatar size | 54 dp avatars break the row layout on a narrow phone | the row is measured, not eyeballed: title/preview must not truncate, and the test asserts geometry |
| `POST /api/profiles` | the phone's device token may lack the scope to create profiles | if it 403s, item 5's New-profile entry renders disabled with the reason shown, and the run reports it — never a silent no-op |

## 9 · What only the phone can prove

Still no `adb` on either host and the Pixel 8 is offline. Everything here is verifiable by test,
typecheck, and inspection of the built bundle; **nothing is verifiable by eye**. The install and
"does it look like Telegram" verdict stay with the user, and the goal file says so rather than
pretending otherwise.
