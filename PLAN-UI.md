# PLAN-UI — Personae Mobile: replicate the messenger pane

**Reference (source of truth):** `~/Projects/hermes-desktop-plugins/personae/`
— `README.md` = the feature spec, `plugin.js` (8,365 lines) = the implementation.
**Target:** `~/Projects/personae-mobile/` (Expo/RN, TypeScript, expo-router).
**Status:** REV 5 — LAN is **not** second-class any more (§0): one gated dashboard, a bearer
provider plugin, both networks at full parity. Session-title bug added (§7 F4).
**Plan for approval; no build started.**

---

## 0. Transport — LAN and Tailscale, both at full parity

### 0.1 What changed from REV 4, and why

REV 4 made the LAN route the narrow `:9222` api_server and called it "degraded". That was a **design
choice, not a limitation** — and the wrong one. The LAN degraded because I picked a narrow API for
it, not because a LAN path is inherently weaker.

The real constraint is narrower than I stated:

- `should_require_auth(host)` (`web_server.py:517-524`) — *"RFC1918 / CGNAT / link-local are
  deliberately PUBLIC — a hostile LAN device is the threat model."* So a dashboard reachable over the
  LAN is **gated by design**.
- In gated mode the cheap credential is refused: `_ws_auth_reason` refuses the in-process
  `_SESSION_TOKEN` outright — *"a leaked `_SESSION_TOKEN` must not grant access"*
  (`web_server_chat.py:260-262`).

That is an *auth* problem, and auth has a sanctioned extension point:

- `PluginContext.register_dashboard_auth_provider(provider)` (`hermes_cli/plugins.py:766`) — any
  plugin, including one from `~/.hermes/plugins/`, can register a `DashboardAuthProvider` with
  `verify_token`.
- `register_token_route(path)` (`dashboard_auth/token_auth.py:31`) opts a path into bearer auth.
  Exact-path, deliberate: *"only registered paths are token-authable, so the auth surface of existing
  routes never widens."*
- The bundled `plugins/dashboard_auth/drain/` is the working template: constant-time compare, a
  fail-closed entropy gate (≥43 chars, ≥16 distinct, ≥128 Shannon bits), audit logging.

### 0.2 Decision: one dashboard, a bearer provider, both networks

**Use the existing gated dashboard — no second instance:**

```
0.0.0.0:9119            # already bound this way, already gated (the browser-login one)
+ personae-mobile-auth  # out-of-tree plugin: bearer provider + token routes for the app's paths
tailscale serve --bg --https=10443 http://127.0.0.1:9119   # live, verified 2026-10-11
```

| Network | Phone dials | Auth | Parity |
|---|---|---|---|
| Home Wi-Fi | `http://10.0.0.15:9119` | `Authorization: Bearer <secret>` | **full** |
| Anywhere | `https://personae-sk.tail0000demo.ts.net:10443` | same secret | **full** |

`:9222` **leaves the design** — no degraded mode, no fallback surface, one protocol.

### 0.3 The credential chain

- **REST:** bearer on the registered paths → `token_auth_middleware` attaches
  `request.state.token_principal` + `token_authenticated`; the cookie gates honour that flag and never
  bounce to `/login` (`token_auth.py` module docstring).
- **WS:** gated mode wants `?ticket=` — a browser-minted, **single-use, 30 s** ticket
  (`web_server_chat.py:299-317`, `dashboard_auth/ws_tickets.py`). Tickets come from
  `POST /api/auth/ws-ticket` (`dashboard_auth/routes.py:485`), which is itself auth-required — so it
  must also be a registered token route. The app then mints a ticket immediately before each
  `wss://` upgrade and never reuses one.

**What the seam offers today (verified, and the honest cost).** Registration is
**exact-path only** — `register_token_route(path)` / `is_token_route(path)` are set membership, there
is no prefix or glob support anywhere in the seam. Exactly **one** bundled provider implements
`verify_token`: `drain` ("Drain Control (service credential)", secret env-only
`HERMES_DASHBOARD_DRAIN_SECRET`, ≥256-bit with an entropy gate) — and it registers **exactly one**
path, `DRAIN_ROUTE_PATH`. The other three providers (`basic` username+password, `nous`, `self_hosted`
OIDC) are browser-login only.

So the phone's credential requires our own provider **and** a registered path per endpoint the app
uses: `/api/profiles`, `/api/profiles/sessions/sidebar`, `/api/sessions`, `/api/sessions/{id}`,
`/api/sessions/{id}/messages`, the chat/stream pair, `/api/cron/jobs*`, `/api/auth/ws-ticket`. That
list is the maintenance tail named in §0.5, and it is why P0.1 is a spike rather than an assumption.
Two shortcuts if it proves tedious: register the paths from one plugin constant next to the app's
route table (single source), or ask upstream for generic prefix support — a widening of the *generic*
surface, which the plugin policy prefers over plugin-specific core logic.

**Live posture (measured 2026-10-11):** the dashboard on `0.0.0.0:9119` runs gated with the bundled
`basic` provider (`HERMES_DASHBOARD_BASIC_AUTH_USERNAME`/`_SECRET` in env,
`dashboard.basic_auth.username`/`password_hash` in config). `--insecure`/`allow_public` is dead — the
gate *always* engages on a non-loopback bind and refuses to start without a provider
(`web_server.py:1170-1183`): *"There is no unauthenticated public-dashboard option."* And `/api/*`
JSON routes carry their own cookie gate: `http://127.0.0.1:9119/api/profiles` answers
`401 {"reason":"no_cookie"}` even from loopback. Bearer registration is what opens them, per route.

### 0.4 What is verified and what is not

**Read in source (verified):** the gate's loopback rule and its LAN-hostile rationale; the gated WS
arms and what each rejects; `register_dashboard_auth_provider` on `PluginContext`; exact-path token
routes; the drain provider as a working template; `GET /api/sessions/{id}`; `PATCH` rename returning
the new title.

**Also verified live (2026-10-11):** the tailnet route reaches the full-parity surface —
`https://personae-sk.tail0000demo.ts.net:10443/api/profiles` answers `401 no_cookie` (the dashboard's
gate), where `:9222` answers `404`. The hop is proven; only the bearer and ticket legs are not.

**And the Host layer needs no config:** `_is_accepted_host` (`web_server.py:597-621`) accepts *any*
Host header when the bind is `0.0.0.0` — *"no protection possible at this layer"* — so both the LAN IP
and the tailnet hostname pass Host and WS-Origin validation **without** `dashboard.public_url`. That
also means we do **not** have to set `public_url`, which would otherwise be the one value that can
engage the gate on an otherwise-loopback bind.

**Designed, not yet executed (spike first):** the end-to-end chain — bearer on a registered path, and
bearer → `POST /api/auth/ws-ticket` → `wss://…?ticket=`. The seam is documented as satisfying the
cookie gates, but I have not run it. **P0 starts with that spike.**

**Fallback if the ticket chain will not verify:** REV 4's option C — a *second* dashboard bound to
`127.0.0.1:9118` (gate off, plain prompt `?token=` on the WS) published with
`tailscale serve --https=10443 http://127.0.0.1:9118`, with `adb reverse tcp:9118 tcp:9118` for
device testing. Full parity too, but Tailscale becomes mandatory. Kept in the back pocket, not built.

### 0.5 Honest costs and risks

1. **We are widening the auth surface on purpose**, on the browser-login dashboard. Keep the
   registered path list minimal and explicit; each added route is a new bearer-reachable door.
   *"Root-equivalent"* is the right mental model for that secret.
2. **Exact-path registration has a maintenance tail:** a route added later (or renamed) 403s until
   registered. If that bites, the clean ask is generic prefix support in `register_token_route` — a
   widening of the generic surface, which is exactly the trade the plugin policy prefers over
   plugin-specific core logic.
3. **`:9119` on `0.0.0.0` is LAN-exposed to guessing:** constant-time compare, entropy gate, audit
   log, plus — recommended — a host firewall rule limiting `9119` to the LAN subnet.
4. **The dashboard can also chat** (`/api/ws` → `tui_gateway.ws.handle_ws`, `chat_ws.py:595`, in-code
   *"the same `tui_gateway.dispatch` surface Ink uses over stdio"*). That is what makes full parity
   possible at all: `profiles.list`, `profiles.get_asset`, `session.*`, `cron.manage`, `projects.list`.

---

## 1. What the app has today (the delta)

`app/index.tsx` roster (547 lines) · `app/thread/[id].tsx` thread (377) · `app/settings.tsx` (697) ·
connectivity layer (`src/connectivity.ts`, `src/routes.ts`, `src/native/tailscale.ts`) · PT-PT
throughout (`src/i18n.ts`) · 60 offline tests (`tsx tests/run.ts`) + `mock/server.mjs`.
Shipped: `dist/personae-0.3.0.apk` (98.9 MB), versionCode 3, same release key.

---

## 2. Parity matrix

### Bucket A — served; mobile renders/acts

| Plugin feature | Endpoint |
|---|---|
| Profile → its sessions, newest first | `GET /api/sessions` (or `/p/<profile>/`) |
| Open session, full history | `GET /api/sessions/{id}/messages` |
| Session row incl. **title** | `GET /api/sessions/{id}` · `GET /api/sessions` |
| Compose + streamed reply, **Stop** | `POST .../chat/stream` · `/chat` · `POST /v1/runs/{id}/stop` |
| New session · rename · pin · archive · hide | `POST /api/sessions` · `PATCH /api/sessions/{id}` |
| Delete · Fork / branch | `DELETE /api/sessions/{id}` · `POST .../fork` |
| Parent↔child links, ↳ / ↩ | `parent_session_id`, `_lineage_root_id` |
| Mark read/unread (**write**) | `PATCH {unread}` → `db.set_session_read` |
| Row body: preview, age, counts, tokens, cost | `preview`, `last_active`, `message_count`, `tool_call_count`, cost fields |
| Per-session model lock | `POST /api/sessions/{id}/model` · `GET /api/model/options` |
| Bell / cron | `/api/cron/jobs*` · `/api/cron/fire` |

### Bucket B — gaps, re-sized

| Feature | Was | Now |
|---|---|---|
| Profiles list | no route | ✅ `profiles.list` / `GET /api/profiles` |
| Cross-profile rail | hand-typed | ✅ `GET /api/profiles/sessions/sidebar` (batched, with `profile_totals`) |
| **Avatars** | RPC-only | ✅ `profiles.get_asset` → `{found, mime, size, data:"data:image/png;base64,…"}` (`methods_profiles.py:446-460`) |
| Unread read-back | write-only | ✅ dashboard rows carry `last_read_at` |
| Amber "blocked on you" | unclear | ✅ open server→client requests on `/api/ws` (§2.1) |
| Groups / colours / order / hidden / Apropos | renderer store | ❌ phone-local — needs the layout blob (§6) |

### 2.1 Status dots — the pane's real semantics

From `plugin.js:1791-1893` and `README.md:108-124`. One dot per session, priority order:

| Dot | Means | Phone source |
|---|---|---|
| **amber** `needs-input` | blocked on you — clarify/approval **pending** | open server→client request on `/api/ws` (replayable via `session.events.since`) |
| **blue** `working` | mid-turn now | `session.active_list` |
| **emerald** `unread` | activity you have not read | the dashboard row's `last_read_at` — **the RPC `session.list` projection drops `unread`** (`plugin.js:47-52`) |
| **none** | nothing waiting | — |

Badge = `needs-input + unread`, shown at 2+. A profile's dot is the **aggregate of its sessions**
(`plugin.js:1841-1844`). Emerald stays quiet on a profile never read through — the pane is honest
about that; so is the app.

### Bucket C — mobile builds it

Expand/collapse a face · row geometry · long-press menus (Open, Rename, Colour, File into group,
Sort, Copy id, Apropos, Delete) · multi-select + selection bar · groups as drop targets · toolbar
(bell, **+**, folder, search, filters) · day grouping + 25/page · dot aggregation · PT-PT · theme.

**Search trap:** the pane searches server-side over profiles *and* sessions; REST takes only
`source`, exact `title`, `include_children`, `include_hidden`. Filter client-side over the fetched
page and say so, or add one RPC method.

---

## 3. Touch mapping (mouse-shaped affordances)

| Plugin (mouse) | Phone |
|---|---|
| Right-click context menu | Long-press → action sheet |
| Hover states | Always-visible affordance |
| Drag between groups / reorder | Long-press to lift, drop targets highlight |
| Ctrl/Cmd-click multi-select | "Selecionar" in the toolbar; tap rows to tick |
| Scroll + pagination | `FlatList` (virtualised) |

---

## 4. Decisions

**Answered:** D1 (a) phone-local pane state · D2 `/api/profiles` · D3 close the gaps · **D4 transport
= §0.2** · **D5 take avatars** · **no API-key rotation**.

- **D6 — `:9222`:** out of the design. Any other machine dialling it is the only reason it still binds
  `0.0.0.0` (open item 1).
- **D7 — iOS tailscale trigger:** the local tunnel module is Android-only; iOS gets the honest
  "liga o Tailscale" note + deep link.
- **D8 — details vocabulary:** reuse the gateway's own — sections `thinking · tools · subagents ·
  activity`, modes `hidden · collapsed · expanded` (`server.py:160-161`,
  `methods_config_set.py:347-383`). One global default, per-section override. Do not invent a second
  vocabulary.

---

## 5. Connections — two networks, one credential, no degraded mode

### 5.1 The model

```ts
type Connection = {
  id: string;            // stable uuid — tokens key on it, so reordering never loses auth
  label: string;         // "Casa (Wi-Fi)" | "Fora (Tailscale)" | "Dev (adb reverse)"
  kind: 'lan' | 'tailscale' | 'dev';
  baseUrl: string;       // http://10.0.0.15:9119 | https://personae-sk.tail0000demo.ts.net:10443
  priority: number;      // 0 = tried first; drag to reorder
  enabled: boolean;
  tokenRef: string;      // expo-secure-store key — the secret never enters this JSON
  health: { lastOkAt?: string; lastErrorAt?: string; lastError?: string; lastLatencyMs?: number };
};
```

List in AsyncStorage (non-secret); secrets in `expo-secure-store`, one key per connection id. Add,
rename, reorder, disable, test, delete — all in the manager.

### 5.2 Selection, retries, no silent surprises

1. Walk enabled connections in `priority` order; first success wins and is remembered for the current
   network signature (netinfo type + Tailscale up/down) so calls don't re-probe.
2. Hard failures (401/403) skip that connection for the session — and say so, with the fix
   (re-enter the secret). Soft failures (timeout, DNS) retry after a cooldown; never a tight loop.
3. Re-probe on network change (`expo-network`), on foreground after N minutes, or on user pull — not
   on a timer.
4. **Both routes are full parity**, so no degraded tag is needed. The tag stays available in the UI
   for a genuinely partial surface (it is the honest way to show one), but nothing in the plan
   produces one.

### 5.3 The state card (plain PT-PT, four steps)

`Sem ligação` / `A ligar…` / `Ligado a <label>`. Four actionable rows — **Rede** → **Tailscale** →
**Gateway** → **Autorização** — the first failing one carrying its fix (deep link, retry, or the
secret prompt). "Testar ligação" runs all four and prints a copyable result — the same payload the
export log carries. Engineer details (URLs, timeouts, route list) collapse under *Avançado*; a fresh
install is one connection + one secret.

---

## 6. Sync — what already works, and what needs building

**Already shared, free.** Both clients read the same `state.db` and the same profile homes: sessions,
messages, titles, forks, lineage, models, cron jobs, project links, **read/unread watermarks**, and
profile assets/avatars. Open the phone mid-conversation and it is the same conversation.

**Per-device by design.** Connections and their secrets — a secret in a phone's secure store must
never be a synced object.

**Not shared: the pane's own layout** — groups, colours, manual order, sort, hidden set, expanded set,
Apropos. It lives in the renderer's `messenger-*-v1` keys with no network route.

| | Mechanism | Cost | Verdict |
|---|---|---|---|
| **S2. Export / import** | one `personae-layout.json` through the log's share sheet; the plugin gains "Importar layout" | ~0 server work, small `plugin.js` change | **ship in this phase** — also seeds the phone from the desktop in one tap |
| **S1. Layout blob on the gateway** | contract-declared RPC pair persisting `~/.hermes/state/…`, read by plugin **and** phone, per-key `{value, updated_at, device}`, last-write-wins + `since` cursor | new method file + contract regen + `tsc` + plugin change | **the real answer — own phase after parity** |
| S3. CRDT | — | — | rejected: overkill for a handful of keyed lists |

Recommendation: **S2 now, S1 as its own goal.** If we touch core, prefer a generic
`plugin.state.get/set` over a Personae-specific method — other plugins have the same problem.

---

## 7. Defects from the device round

### F1 — profile pictures

Source: `profiles.get_asset` returns a **data URL**
`{found, mime, size, data:"data:image/png;base64,…"}` (`methods_profiles.py:446-460`) — the phone
renders it directly, no new route. `profiles.list` carries a cheap existence flag so rosters skip the
probe (`methods_profiles.py:276`).
**Spec:** 28 px circular avatar in the profile row, fetched once per profile per session, cached in
memory + AsyncStorage keyed by `profile + size`; fallback = the existing initial monogram. Assets can
reach 2 MB — never block the rail on them.

### F2 — icon-based buttons

`@expo/vector-icons` is **not installed** (checked `node_modules`) → add it
(`npx expo install @expo/vector-icons`, Ionicons) and rebuild; verify glyphs survive **release**
bundling (font assets are a known release-mode footgun).
**Spec:** replace the text buttons in the thread composer, the roster toolbar and the row affordances
with icons; keep a label where an icon is ambiguous; every icon gets a PT-PT `accessibilityLabel` —
an icon-only button is unusable with a screen reader otherwise.

### F3 — "Ver detalhes" shows nothing ← bug, diagnosed

**Root cause, in the app, three places:**

1. `app/thread/[id].tsx:175-184` — the `kind === 'tools'` branch renders a `Pressable` whose only
   effect is `setShowTools(v => !v)`, which changes **the label**. There is no expanded body, so
   pressing it can never reveal anything.
2. `showTools` is **one global boolean** — every collapsed run would toggle together.
3. `src/logic/thread.ts:43-67` (`textOf`) reads only `message.content` — `reasoning`/
   `reasoning_content` are dropped before rendering.

**The data is already on the wire.** `_message_response`
(`gateway/platforms/api_server.py:3046-3052`) allow-lists `tool_call_id, tool_calls, tool_name,
reasoning, reasoning_content, display_kind, finish_reason, token_count` alongside the plain fields.

**Fix spec:**

- `ThreadItem` grows real payloads: `{kind:'tools', count, calls:[{name, args, result, ok}]}` and
  `{kind:'reasoning', text}`.
- Expansion state per run — a `Set<string>` keyed by item key, not one global boolean.
- Tool rendering: `tool_calls[].function.{name,arguments}` (pretty-printed, truncated) with the
  matching `role:'tool'` row joined by `tool_call_id` as its result. `display_kind === 'hidden'`
  scaffolding stays hidden.
- Reasoning as its own collapsed block ("Pensamento"), honouring D8's vocabulary.
- **Live half:** REST+SSE carries text only. Tool/reasoning activity *during* a turn arrives on the
  WS event channel (`tool.start` / `tool.complete`) — another reason P0's WS adapter lands first.
- Tests: `buildItems` cases for a tool run with calls+results, reasoning-only, an orphan tool result,
  and a hidden scaffolding row. All offline against `mock/`.

### F4 — the top bar shows the session **id**, not its name ← bug

- `app/index.tsx:151` and `:216` — `router.push({ pathname: '/thread/[id]', params: { id: session.id, profile } })`
  — the title is not passed, even though the roster row has it (`app/index.tsx:226` renders
  `item.title`).
- `app/thread/[id].tsx:231` — `<Stack.Screen options={{ title: sessionId }} />`.

**Spec:** pass the title as a route param for instant paint (no blank bar on cold open), then treat
`GET /api/sessions/{id}` (`web_routers/sessions.py:524`) as authoritative once loaded — it is also how
a rename lands while the screen is open (`PATCH` returns the new title, `sessions.py:864-876`).
Fallback chain: title → id. Never render a raw id while a title exists.

---

## 8. Phases (each ends in a verifiable artifact)

- **P0 — transport, spike first.**
  - **P0.1 (gate):** register the bearer provider + one probe path, `curl` it from another machine on
    the LAN → 200; then mint a WS ticket with the bearer and open `/api/ws` → accepted. **If either
    leg fails, stop and fall back to §0.4's option C before any UI work.**
  - P0.2: dashboard adapter (REST + `/api/ws`) behind the existing `src/api` interface; secret in
    `expo-secure-store`; ticket minting per WS connection; the plugin + Serve entry documented as
    setup. Extend `mock/` with the dashboard routes **and** a fake WS dispatch.
  - `verify:` rail renders from `/api/profiles` + `/sidebar`; a scripted RPC returns an asset data URL;
    with the LAN connection disabled the Tailscale connection takes over.
- **P1 — roster parity + F1 + F2:** faces with avatars, expand/collapse into sessions, day grouping,
  25/page, dots (§2.1), icon chrome and toolbar.
- **P2 — thread parity + F3 + F4:** details expansion (tools/reasoning), session name in the top bar,
  live activity over WS, long-press session actions, model lock.
- **P3** search/scope filters with the honest client-side boundary.
- **P4** groups + colours + manual sort (phone-local, D1a).
- **P5** multi-select bulk actions.
- **P6** Apropos (scoped).
- **P7** connections manager (§5) + state card + export log (§9).
- **P8** layout export/import (S2).
- **P9** iOS parity via EAS.
- **P10 (separate goal)** gateway layout blob (S1).

Every phase: git commit, `npm test` green, `tsc --noEmit` clean. Android first, then iOS.

---

## 9. Export log — one file, log + your description

- Capped ring buffer (≈500): UTC timestamp, level, category (`net|auth|api|ws|ui|error`), message;
  per call: method, path, status, duration, chosen connection, attempt #.
- Header: app version + versionCode, build id, device + OS, active connection + candidates with
  priorities, dashboard host (host only), Tailscale state, last 3 failures.
- **A description box on the export screen** — what you type lands at the top of the file, so one file
  *is* "log + what went wrong".
- Share, don't upload: `.txt` to the app cache dir → OS share sheet (`expo-sharing`) + clipboard.
  Reachable from Settings **and** the failure banner.
- **Redaction mandatory and unit-tested:** strip auth headers, the bearer secret, access/refresh
  tokens, ws tickets, `token`/`ticket` query values → `[REDACTED]`; never log credential-bearing
  bodies. A test must assert a known secret cannot appear in an exported log.
- Local only. No telemetry, no auto-send.

---

## 10. Open items

1. **`:9222`** — with §0.2 it is unused. Bind it to loopback, or leave it for other machines? It is
   the last plaintext-key listener on `0.0.0.0`.
2. **Firewall `9119` to the LAN subnet** — the bearer provider makes LAN exposure deliberate; restrict
   the source range as well.
3. **Q10** — seed first-run connection templates (this host's LAN IP + tailnet URL, same secret), or
   keep the default-empty rule? (My vote: seed both, secret still asked once.)
4. **Q11/Q12** — per-connection probe-by-IP override; keep any no-TLS consent OFF by default. (Both
   now low-stakes: the design has no insecure route.)
5. **Q13 — nothing has ever been device-tested.** No device, no emulator; 0.3.0 was never installed.
   **Closing acceptance test:** install on the Pixel 8 → rail renders → avatar loads → a tool-call
   expands → the top bar shows the session **name** → the export log shares.
6. **Serve state — done (2026-10-11).** `:10443` was proxying `:9222` (partial parity); it now
   proxies `127.0.0.1:9119` — the dashboard, full parity — for both LAN and tailnet, so there is no
   second port to remember. Verified: through `https://personae-sk.tail0000demo.ts.net:10443`,
   `/api/profiles` → `401 {"reason":"no_cookie","login_url":"/login"}` (the dashboard's own gate,
   which is where the bearer provider plugs in) while the same path on `:9222` → `404` (that surface
   never had it). `/` → `302` to login; Funnel `:443 → :8100` untouched, still `200`.
   Requires root: `sudo tailscale serve --bg --https=10443 http://127.0.0.1:9119` (or
   `sudo tailscale set --operator=$USER` once to drop the sudo). Original mapping:
   `~/.hermes/cache/scratch/serve-before-*.txt`.
7. **Security sitting:** the new bearer secret (≥256-bit), the token-route list, the firewall rule,
   Funnel's Pharmacy entry confirmed untouched. (API-key rotation declined — leave it.)
8. **Versioning:** UI work ships as **0.4.0**, same release key.
9. **Scope discipline for Cody:** one goal doc, phases in order, per-phase `verify:` commands, no
   regression of the existing suite, no hardcoded IPs in source, no secrets in the repo.

---

## 11. Sequencing and gates

- No collision: Cody's remote-access run finished (48m 8s, `logs/CODY-DONE.txt`), tree free → build
  **in place** (warm toolchain, keystore, gradle cache).
- **This document is the gate artifact** — it can go to Step5/Opus before Cody builds; Cody builds on
  deepseek-flash.
- Android first, then iOS via EAS. Deliverable = a working APK **installed on the Pixel 8**, not
  "ships".
