# GOAL — Personae Mobile 0.6.0: connection, pairing, and options that sync

**Owner:** cody · **Date:** 2026-10-11 · **Predecessor:** 0.5.0 (shipped, verified — see `PROGRESS.md`)
**Repos:**
- App: `~/Projects/personae-mobile` (React Native + Expo, TypeScript, expo-router)
- Server: `~/.hermes/plugins/personae-mobile-auth/` and `~/.hermes/plugins/messenger/`
**Behaviour reference of record:** `~/Projects/hermes-desktop-plugins/personae/plugin.js` (8 365 lines) — the plugin wins on *behaviour*; this file wins on *scope*.
**Read first:** `PROGRESS.md` (what 0.5.0 did + the two pitfalls), `PLAN-UI.md` REV 5 (transport/auth facts), `~/.hermes/plugins/personae-mobile-auth/__init__.py` (247 lines, the provider you are extending).

the user's ask, verbatim, is the top line of each phase. Deliver all of it.

---

## 0. Measured ground truth — do not re-derive, and do not guess around it

I measured all of this on the live box (`personae-sk`, 10.0.0.15, tailnet 100.64.0.11) today.

**Two different services, and only one of them is the dashboard:**

| | `:9119` | `:9222` |
|---|---|---|
| Unit | `hermes-serve.service` (user) — *"Hermes Agent dashboard backend (browser UI + desktop app remote gateway)"* | `hermes-gateway.service` (user) — *"Messaging Platform Integration"* |
| ExecStart | `hermes dashboard --host 0.0.0.0 --port 9119 --skip-build --no-open` | `hermes gateway run` |
| `GET /api/health` | `{"ok":true,"version":"0.21.5","displayVersion":"0.21.5+5643","auth_required":true}` | 404 |
| `GET /api/profiles` | 401 anon · **200 with the app bearer → 22 profiles** | **404** (`/` is also 404) |

`hermes-serve.service` runs with `EnvironmentFile=~/.hermes/.env`.

**Auth shape of the dashboard (measured):**
- `GET /api/auth/providers` → `{"providers":[{"name":"basic","display_name":"Username & Password","supports_password":true},{"name":"personae-mobile","display_name":"Personae Mobile (app credential)","supports_password":false}]}`
- `GET /api/health` and `GET /api/auth/providers` are **public**. So are `/api/status`, `/api/config/defaults`, `/api/config/schema`, `/api/model/info`, `/api/dashboard/themes`, `/api/dashboard/plugins` (`hermes_cli/dashboard_auth/public_paths.py` `PUBLIC_API_PATHS`). Everything else is gated.
- Browser path: `/` → `302 /login?next=%2F`; `/login` → 200; the form POSTs to `/auth/password-login` (provider `basic`, username `admin`, scrypt hash in `config.yaml`; `session_ttl_seconds: 0`). Sessions are stateless HMAC cookies.
- App path: `Authorization: Bearer $HERMES_PERSONAE_BEARER` → `verify_token` + `verify_session` on the provider below. `GET /api/auth/me` with it returns `{"user_id":"personae-mobile","provider":"personae-mobile"}`. A wrong bearer → 401; the basic-auth secret as a bearer → 401.
- The provider lives at `~/.hermes/plugins/personae-mobile-auth/` (today: a **static env bearer only**, `supports_password:false`, no expiry, no revocation, no per-device identity). It registers exactly one path — `/api/profiles/sessions/sidebar` — into the token seam via `register_token_route` (see the long comment at `__init__.py:188-196`; registering an SPA path would take that route away from the browser — respect that rule).
- Plugin REST mount: `~/.hermes/plugins/<id>/dashboard/plugin_api.py` → FastAPI `APIRouter` at `/api/plugins/<id>/` (the messenger plugin uses it today for `/health`, `/archived`, `/search`).

**Discovery candidates for the app** (Tailnet first — the phone is expected to be on the tailnet): `http://100.64.0.11:9119`, `http://personae-sk:9119` (MagicDNS), `http://10.0.0.15:9119` (LAN).

**App-side facts (measured today):**
- `src/settings.ts` — connection model; `src/i18n.ts` — 332 lines / 276 keys, **no language switch**; 15 Portuguese strings hardcoded outside the table: `src/logging.ts:123,135,155`, `src/connectivity.ts:310,322`, `src/ConnectivityContext.tsx:211-215`, `src/api/client.ts:320`, `src/api/backend.ts:244,403,409,426`, `app/settings.tsx:419` (+ inline `'Bearer do dashboard'` / `'API_SERVER_KEY'` at `app/settings.tsx:362`).
- `src/ConnectivityContext.tsx:209` — `autoConnect` gates **only** the Tailscale broadcast trigger; `:247` — `openTailscaleOnFailure` gates **only** opening the Tailscale app. The route probing (`connectThrough`) runs regardless. So flipping both defaults is safe.
- `app/settings.tsx:277` — the two-choice `['dashboard','gateway']` segment is the "why are there two options?" that confuses the user; `:329-331` already prints a warning when `gateway` is selected.
- The registo (`personae-registo.txt`) shows the disease in one line: `Ligação: Dashboard (:9119) · http://10.0.0.15:9222` — a **Dashboard surface pointed at the gateway port**, i.e. 401s on the dashboard then 404s forever on the gateway.

**Never** put a secret in the repo, a log, a report, or a commit. Refer to credentials as `[REDACTED]`. Don't print the bearer, the device tokens, or the pairing codes.

---

## Phase 0 — Server side (do this FIRST; the app needs it to test against)

### 0.1 `personae-mobile-auth`: pairing + per-device credentials

> the user's ask: *"when needing to connect to the dashboard, open a browser view on the dashboard, so that the user can login and the app can use its credentials."*

Today the app's only credential is a static env bearer that someone must **copy by hand onto the phone**. Replace that with a browser-mediated device pairing, keeping the env bearer working as the legacy/static credential.

- **State:** `~/.hermes/plugins/personae-mobile-auth/state/credentials.json`, mode `0600`, atomic write (temp + `os.replace`), `fcntl.flock` on write. Shape:
  `{"version":1,"devices":[{"id","label","token_sha256","token_prefix","created_at","last_seen_at","revoked_at","minted_by"}],"pending":[{"code_sha256","label","created_at","expires_at","redeemed_at"}]}`
  Store **only** `sha256(token)` and a short display prefix. Never plaintext. A corrupt/missing file must fail closed (no devices) without breaking load.
- **Verification:** `verify_token` / `verify_session` accept, in order: (a) the env bearer (unchanged, constant-time, same audit lines), (b) any non-revoked device token — compare `hmac.compare_digest(sha256(presented), stored_sha256)` and update `last_seen_at` (throttle the write to ≤1/min per device), (c) a **pending, unexpired, unredeemed pairing code** → `TokenPrincipal(principal="personae-pairing", scopes=("personae-pair",))`, honoured **only** on the redeem path (see below). Never mint a cookie from (b)/(c). Keep the ≥256-bit fail-closed entropy gate for the env bearer and apply the same bar to minted device tokens.
- **`POST /api/plugins/personae-mobile-auth/pair/start`** — requires a browser **cookie** session (it is *not* public). Body `{"label":"the user's Pixel 8"}` (optional; default "Personae Mobile"). Mints `code = secrets.token_urlsafe(32)`, TTL **300 s**, single use, stores `code_sha256`. Returns `{"code","expires_at","deep_link","qr_svg_url","poll_url"}` where `deep_link = "personae://connect?base=<urlencoded http://host:9119>&code=<code>&label=<urlencoded>&expires=<epoch>"`. Cap the number of live `pending` entries (e.g. 5; oldest evicted).
- **`POST /api/plugins/personae-mobile-auth/pair/redeem`** — the phone has no cookie, so this path must reach the handler **without** a session. Preferred: register this exact path with `register_token_route(...)` and have `verify_token` accept the pairing code (capability (c) above), so the handler sees `token_principal` for a code and *nothing* to a code-less request. If the token seam cannot reach a newly-added plugin route, fall back to adding the literal path to `hermes_cli/dashboard_auth/public_paths.py` → `PUBLIC_API_PATHS` and **say so explicitly in the report** (that is a core-file edit; it must be listed).
  Behaviour: valid code → mint a device token (`secrets.token_urlsafe(32)`), store it hashed with `label` + `minted_by="pairing"`, mark the code redeemed, return `{"base_url","token","device_id","label","created_at"}` — **exactly once**. Second use → 410. Expired → 410. Unknown/absent → 401. Rate limit ~5 requests/min/IP with a clear 429. Log an audit line per outcome (no code, no token in the log).
- **`GET /api/plugins/personae-mobile-auth/devices`** (cookie session) → `{"devices":[{id,label,created_at,last_seen_at,revoked_at}]}` — no secrets, no hashes. **`POST /api/plugins/personae-mobile-auth/devices/{id}/revoke`** → sets `revoked_at`; a revoked token must 401 immediately. Also accept revocation by the app itself for its own device.
- **Browser page `/pair`** (server-rendered by the plugin, styled like the dashboard's login page): shows "Autorizar Personae Mobile", the label field, the **QR**, a copyable deep link, and a "Continuar" link that navigates to the deep link (this is the in-app-browser path: after login the phone's WebView lands here and the app intercepts the `personae://` navigation). It must work when reached as `http://<host>:9119/login?next=/pair`.
- **QR:** render it **offline with a vendored dependency-free encoder** (MIT/public-domain ~2 KB of JS or a small pure-Python encoder you write) in the plugin's dashboard assets — `segno`/`qrcode` are **not** installed in the dashboard venv (PIL 12.3.0 is, if you want PNG). No network fetch, no new pip dependency required at runtime. Expose it as a same-origin URL the page can `<img>` (e.g. `GET /api/plugins/personae-mobile-auth/pair/qr.svg?code=…`, cookie-gated like start).
- Preserve the current fail-closed behaviour: with no env bearer **and** no devices, registration is skipped exactly as today (same `SkipRegistration` path and reason string).

### 0.2 `messenger` plugin: the sync store — server half

> the user's ask: *"Also include plugin-side sync store."*

Extend `~/.hermes/plugins/messenger/dashboard/plugin_api.py` (keep it a `mounted router`; don't disturb `/health`, `/archived`, `/search`):

- **`GET /api/plugins/messenger/state`** → `{"version":1,"keys":{<key>:{"value":<any>,"rev":<int>,"updated_at":<iso>}}}`
- **`PUT /api/plugins/messenger/state`** body `{"keys":{<key>:{"value":…,"rev":…}},"tombstones":[{"key":…,"entry":…,"rev":…}]}` → merge per key, **per-entry LWW by `rev`** (a higher `rev` wins; equal `rev` keeps the server value and does not churn), return the merged `keys` view. For multi-valued keys, merge entry-wise so two devices adding different entries both survive; a tombstone removes one entry and must not be resurrected by a lower-rev write.
- Limits: reject payloads > 256 KB (413) or > 64 keys (400); validate key names against the allow-list below; reject unknown shapes with 400 rather than storing junk.
- **Storage:** `~/.hermes/plugins/messenger/state/ui-state.json`, `0600`, atomic write, `flock`. Missing file → empty state (not an error). Corrupt file → back it up to `.bad-<ts>` and start empty, loudly logged.
- **Key classification** (enforce it server-side):
  - *shared* — `session-sort-v1`, `session-order-v1`, `sections-v1`, `session-groups-v1`, `session-colors-v1`, `hidden-v1`, `apropos-v1`
  - *device-local* — `expanded-v1`, `search`, toasts, scroll, pane width: **never** accepted by this endpoint (400 with the key named).

### 0.3 `plugin.js`: the desktop writer (no behaviour change offline)

In `~/Projects/hermes-desktop-plugins/personae/plugin.js`, interpose the existing local storage seam (`ctxRef.storage`, around lines 364 / 1194):

- Write local **immediately** (today's behaviour), then push the changed shared keys **debounced** (~1.5 s idle) to `PUT /state` through `ctx.rest` (namespaced `/api/plugins/messenger/`).
- Offline/failure: queue and retry with backoff; flush on reconnect/visibility. An unreachable server must never block or degrade the pane.
- **Seed-then-authoritative migration:** first run per key — if the server has no value → push local (seed); if the server has one → adopt it and mark local as seeded. Never silently overwrite a server value with a stale local one.
- Per-key `rev` counters that only ever increase for a given writer. Device-local keys are never pushed and never read back.
- Bump the plugin's own version/README to state the sync contract. If the plugin has a test harness, extend it; if it doesn't, say so and document the manual check you ran.

### 0.4 Tests + Gate 0

Pytest for 0.1/0.2 (pairing lifecycle: start → redeem once → reused 410 → expired 410 → revoked 401; entropy gate; state-file corruption; `/state` merge/LWW/tombstone/limits). Paste the pytest summary line in `PROGRESS.md`.

**Gate 0 evidence** (write it to `logs/060-server.txt`, and paste the commands + status codes in `PROGRESS.md`):
1. `curl /api/health` + `/api/auth/providers` → the JSON above.
2. `/api/profiles` anon → 401; with the env bearer → 200 and **22** profiles.
3. `pair/start` → note in the report that a *real cookie-session* test needs the user (you cannot log in as `admin`); exercise it with the env bearer instead and say so.
4. `pair/redeem` with the code → device token; then `/api/profiles` and `/api/auth/me` with **that** token → 200; revoke it → 401.
5. `PUT /state` then `GET /state` round-trip, including one tombstone and one conflicting-rev case.

---

## Phase 1 — The app (`~/Projects/personae-mobile`)

> the user's ask: *"set up the connection settings and wizard to ask for a connection to the hermes-serve.service, so that the user gets what he's looking for"* · *"make 'OFF' the default option to turn on tailscale automatically"* · *"I don't understand the difference between using 9119 or 9222 and why are there both options?"* · *"make the default app language English"* · *"include the deep link and QR code."*

**1.1 First-run / re-connect wizard** (`Definições → Reconfigurar ligação`, and automatically on first launch or whenever no route is reachable):
- **Step 1 — Serviço.** Pick from the candidates (§0), or type an address. Probe `GET /api/health` (fall back to `/api/status`). Name the thing explicitly: **`hermes-serve.service` — o dashboard do Hermes (perfis, sessões, plugins)**, port 9119, and say what it gives the user ("os 22 perfis e as sessões"). Show the live answer (`version`, `auth_required`) so success is visible.
- **Step 2 — Not-a-dashboard correction.** If the probe fails or answers wrongly, say exactly what it is: for `:9222` → *"esse endereço é o `hermes-gateway.service` (bridges de mensagens: Telegram/WhatsApp) — não tem perfis nem sessões. O dashboard é o `:9119`."* Offer the one-tap fix. Also handle: nothing listening (connection refused), TLS-required, and a 401-if-anonymous-only case.
- **Step 3 — systemd help** (only when nothing answers): copyable lines — `systemctl --user status hermes-serve.service`, `systemctl --user enable --now hermes-serve.service`, plus the note that the service must be reachable (tailnet route, or `--host 0.0.0.0`). Copyable text in a code block, not a wall of prose.
- **Step 4 — Auth.** `GET /api/auth/providers` → if `personae-mobile` is present: **"Emparelhar este telefone"** (browser, 1.3) or **"Ler código QR"** (1.4). If only `basic`: in-app browser login (capture the session cookie) *or* paste the bearer (advanced). If `auth_required` is false: nothing needed.
- **Step 5 — Verificar.** `GET /api/auth/me` (only when a credential exists — it 401s anonymously) then `GET /api/profiles` → *"22 perfis encontrados"* → land on the roster. A failure here names the surface that answered and what it wanted (the 401 vs 404 distinction must be explicit, no bare "erro").

**1.2 Connect settings restructure** (`app/settings.tsx`): three blocks — **Ligação** (address → credential → Testar ligação) / **Avançado** (collapsed: surface override, multiplexed profiles, model, routes, timeouts, Tailscale package) / **Diagnóstico** (the registo + copy/share button). Keep every existing field reachable; nothing gets deleted. Make the pair coherent by construction:
- Derive the surface from the port: `9119` → dashboard, `9222` → gateway (with the warning), anything else → keep the manual override in Avançado.
- On load, detect an incoherent stored pair (dashboard surface + 9222, or gateway + 9119) and **heal it with a visible one-line note** (the user's phone is currently in exactly this state — if you don't heal it, 0.6.0 will 404 again and he will rightly call it broken).
- `Testar ligação` reports the surface that answered, the profile count, and the version.

**1.3 Browser pairing** (the ask): open `http://<host>:9119/login?next=/pair` in an in-app browser — `expo-web-browser` `openAuthSessionAsync` with the `personae://connect` redirect — with a WebView fallback (there is no `react-native-webview` dependency today; adding it is allowed if the auth session cannot intercept the custom scheme on both platforms). Intercept the `personae://connect?base=…&code=…&label=…` navigation, `POST pair/redeem` with the code, store the device token in secure storage (Keychain/Keystore via `expo-secure-store`), verify with `/api/auth/me` + `/api/profiles`, done. **No typing.** Show the device label and a "Revogar este dispositivo" action. Handle: user cancels, code expired, code reused (410), single-use race.

**1.4 Deep link + QR**: register the `personae://` scheme (`app.json` + the Android intent-filter; a rebuild is expected), handle `personae://connect` on cold start and on foreground, and add **"Ler código QR"** using `expo-camera`'s barcode scanner reading the same deep-link payload. Also accept a pasted deep link / a link opened from Telegram. Old link format for reference: the QR carries the same string the browser flow redirects to.

**1.5 English by default**: `src/i18n.ts` becomes `en` (source of truth, default) + `pt`; expose a live `t` (a getter/proxy or a context hook) so the ~30 call sites keep compiling unchanged; add a **Language / Língua** row in Definições; default `en` for a fresh install. Sweep the 15 hardcoded strings in §0 into the table (including the registo header lines, so a support log follows the chosen language). Existing installs keep their language if one was stored; only the default changes.

**1.6 Tailscale auto-start defaults OFF**: `autoConnect: false` and `openTailscaleOnFailure: false` in `DEFAULT_SETTINGS`. Keep the manual "abrir Tailscale" and "voltar a verificar" affordances. Verify on a LAN-only path that a direct route still connects with both off (that's the point of the change).

**1.7 Options sync, client half**: on connect, `GET /api/plugins/messenger/state` and apply the *shared* keys to the roster (sort, sections, groups, colours, hidden, apropos), then `PUT` debounced on change with the same `rev`/LWW rules. A 404 (older plugin) must degrade silently to local-only. Device-local keys stay in AsyncStorage. This is the payoff of 0.2/0.3: sort and grouping set on the desktop show up on the phone.

**1.8 Ship**: version `0.6.0` / `versionCode 6`, **same Personae release keystore** as 0.4.0/0.5.0, tests ≥125 passing + new ones for the wizard/heal/i18n/pairing/state client, `npm run typecheck` exit 0, `expo-doctor` no regression, and — before you claim it — grep the built bundle for the bearer value and confirm **0 occurrences**. Write `logs/verify-0.6.0.sh` so the whole check is one command.

---

## Constraints

- **Secrets:** env-only, never logged, committed, or printed; `[REDACTED]` in every artifact. Do not weaken the entropy gate. Device tokens are stored hashed.
- **Do not** delete `build/` directories under `node_modules` (it is published code for many packages — this broke 0.5.0's tree; restore is `npm ci --legacy-peer-deps`).
- **Do not** run against real contacts; self-chat only. No batch operations on the user's accounts.
- **Do not** modify another profile's skills/plugins/cron. Anything you touch outside the two app/server repos (e.g. a core `hermes_cli` file) must be listed explicitly in the report.
- Commit per phase, plain messages. Update `PROGRESS.md` per phase with the evidence line, and record any correction to a stated assumption the way 0.5.0 did.
- If a spec detail turns out to be wrong against reality, **follow reality and disclose the deviation** — a documented correction is worth more than a silent fit.

## Acceptance (all checkable, no prose)

1. `logs/060-server.txt` holds the Gate-0 curls with real status codes; a minted device token gets 200 on `/api/profiles`, a revoked one 401, a reused code 410.
2. `/api/plugins/messenger/state` round-trips, merges by rev, honours a tombstone, rejects device-local keys, 413s a >256 KB body.
3. `plugin.js` pushes shared keys when online and is a no-op offline; seeding never overwrites a newer server value.
4. The wizard exists, names `hermes-serve.service`, and its `:9222` branch produces the gateway-not-dashboard sentence.
5. An incoherent stored pair is healed on load, visibly.
6. Browser pairing completes end-to-end on the phone with **zero typing** (or, if you cannot test on hardware, the flow + the interception point are proven by a documented harness/log and the gap is stated).
7. QR scan and deep-link cold start both reach `pair/redeem`.
8. Fresh install defaults to **English**; PT selectable; the 15 hardcoded strings are in the table.
9. `autoConnect` and `openTailscaleOnFailure` default to false, and LAN still connects.
10. Shared sort/groups/colours round-trip between the desktop pane and the app.
11. `npm run typecheck` exit 0; tests ≥125 + new; `expo-doctor` 21/21 or better.
12. APK `0.6.0` / versionCode 6, same keystore cert, bearer occurrences in the bundle = 0, `logs/verify-0.6.0.sh` reruns the whole check.

**Order:** Phase 0 (0.1 → 0.2 → 0.3 → 0.4 + Gate 0) before Phase 1, because the app's pairing and sync code has nothing to call until the server half exists. Push server changes onto the live box and restart the affected services (`systemctl --user restart hermes-serve.service`; the messenger plugin hot-loads or needs the same restart — say which you did).

**Report back:** one table per phase (what / where / evidence), the deviations, and the exact commands the user can run to see it himself.
