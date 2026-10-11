# QUESTIONS — genuinely undecidable from the brief + source

Per SPEC §9: nothing here stopped the build. Each item has the **safest reversible default that was
implemented**, so changing the answer is a small edit, not a rewrite.

## Q1 — No server-side unread count exists on this API

`PATCH /api/sessions/{id}` accepts `unread` (`api_server.py:3232,3254`) but `_session_response`
(:3011-3043) **never returns it** — the client-safe allow-list has no `unread` key. So the API cannot
answer "how many messages are unread".

**Implemented instead:** "new since your last visit on this phone" — the app stores a last-seen
timestamp per profile in secure store and marks sessions whose `last_active` is newer, showing the
count on the contact pill and a `nova` tag on the row. The badge stays for the whole visit and only
resets on the next one.

**The question for you:** is "new since you last looked" the right notion, or do you want a real
unread/read flag driven by `PATCH {"unread":true}` and tracked in the app? The second needs a
locally-stored per-session read marker.

## Q2 — There is no way to list profiles from this server

`SPEC.md` §2 maps "profile → a Hermes profile", but the gateway API has **no profiles route** (the
35-route table at :1745-1792 has none, and `GET /api/profiles` 404s here). A profile is only
addressable as the `/p/<profile>/` URL prefix, and an unknown prefix is a hard 404
(`{"error":"Unknown or unconfigured profile"}`, :1726).

**Implemented instead:** the roster's contact list = the gateway's own profile ("Principal") plus
whatever names you type into Settings → *Perfis extra* (one per line). A mistyped name shows a
status dot that is red and the gateway's own message, never a silent return to the default profile.

**The question for you:** should the app ship with a fixed list of your profile names as the
default, or is typing them once in Settings fine? (The list could also be read from
`hermes_cli.profiles` — but that is the gateway host's filesystem, not something the phone can see.)

## Q3 — Streaming transport is not testable off-device

`react-native-sse` is installed but **not wired**; the app streams over `XMLHttpRequest`
(`readyState 3`) with the same SSE parser the offline tests exercise against the mock gateway.
`XMLHttpRequest` streaming is the technique RN SSE clients use internally, but it could not be
verified on real hardware from here (no device, no emulator).

**Implemented instead:** if the stream fails for any reason, the app falls back to the non-streaming
`POST /api/sessions/{id}/chat`, appends the reply, and says so on screen ("O modo em direto falhou;
a resposta foi pedida novamente em bloco") — never a silent swap.

**What to check on the phone:** whether the reply appears token-by-token. If it arrives all at once
with that notice, the fix is one line in `src/api/transport.ts` (swap in the `react-native-sse`
transport, already installed).

## Q4 — Interface language: PT-PT

`pedro-app-defaults` says the interface is written in the end user's language, in plain language,
for a non-technical user; the end user of this build is you. So the whole UI, including errors and
status text, is **PT-PT**, in one table (`src/i18n.ts`).

**The question for you:** keep PT-PT, or switch to English? Technical tokens (`API_SERVER_KEY`,
`/p/<profile>/`) stay literal in either case.

## Q5 — Roster: does a contact mean a profile or a conversation?

The brief says both ("every profile as a contact row" *and* "Roster renders the session list"). The
screen shows **both layers**: a contact pill row for profiles, and below it the session list for the
selected profile. Long-press on a pill (or on a session row) creates a new session in that profile,
with a confirmation naming the profile first; the `Nova sessão` button does the same inline.

**The question for you:** if you would rather have one flat list of conversations without the
profile rail, that is a layout change in `app/index.tsx` only.

## Q6 — Session row fallback when a session has no title

`_handle_create_session` allows `title` to be absent, and `PATCH {"title":null}` clears it. A title
less row shows **its session id** rather than a made-up name (never invent a display value). If you
would rather show the first line of the session preview, that is a change in
`sessionTitle()` (`src/logic/roster.ts:78`).

## Q7 — Keystore custody

The APK is signed with `~/.personae-android/personae-release.keystore` (password in the same folder,
mode 600). **Any future build must use this same file**, or Android will refuse the upgrade and the
app will have to be uninstalled first. This folder is not in the repo and not backed up anywhere
else — say the word and it can be copied somewhere durable.

## Q8 — The brief says the gateway is on `:9119`; the API Personae speaks is on `:9222`

**Measured, not guessed.** `:9119` is `hermes dashboard --host 0.0.0.0 --port 9119` and authenticates
with a **session cookie** (`401 {"error":"unauthenticated","reason":"no_cookie","login_url":"/login"}`).
That is the desktop app's backend, not the REST API. Personae speaks the **API server** — bearer
`Authorization`, `GET /api/sessions → {"object":"list","data":[…]}` — which `config.yaml` under
`gateway.api_server` puts on **port 9222** (`"enabled": true`, `"host": "0.0.0.0"`).

**What was implemented:** `tailscale serve --bg --https=10443` was pointed at the real API
(`http://127.0.0.1:9222`), after running the brief's literal command (target 9119) and capturing its
output. Evidence and both curl results: `logs/serve-evidence.txt`. Nothing about the existing
`:443` Funnel entry was touched — verified before and after.

**The question for you:** was 9119 in the brief a typo for 9222, or did you intend the *dashboard*
to be reachable from the phone as well? If you want the dashboard too, the clean way is a second
path mount on the same host, not a second port.

## Q9 — Bind `:9222` to loopback? (proposed, NOT applied)

Now that Serve publishes a tailnet-only HTTPS listener on `:10443`, nothing outside this host needs
the raw port, so the standing "bind it to Tailscale or firewall it" item can be closed by restricting
the API server to `127.0.0.1`. **Not applied deliberately**: `host: 0.0.0.0` is in
`config.yaml → gateway.api_server`, so changing it is a config edit that affects every client of that
port — including anything on `personae-ds` / `personae-hq` that may be dialling it remotely
today. Tell me to do it and it is a one-line change plus a restart; confirm no other machine uses
`9222` first.

## Q10 — Should the app ship with pre-filled route templates?

`NOT DONE IF the tailnet IP is hardcoded` is obeyed: **nothing** in `src/` or `app/` contains
`100.64.0.11`, and there is no default route list — a fresh install has an empty list and derives one
candidate from whatever is typed in Settings. The cost is that the routes must be typed once by hand.

**The question for you:** do you want the first-run screen seeded with *templates* (a placeholder
LAN address, plus this host's own `*.ts.net` name on `:10443`), which the user then adjusts? Seeding
the MagicDNS name would put your hostname into shipped defaults — harmless, but it is an environment
fact in the product, so I did not do it without asking.

## Q11 — MagicDNS name vs literal tailnet IP for the probe

A `host.tailnet.ts.net` name **does not resolve until the tunnel is already up**, so a readiness
probe by name simply fails until Tailscale connects and then starts answering — which is correct
behaviour for a poll, but it means the Serve route cannot be the one that *proves* the tunnel came
up; the raw `100.x.y.z` route does that faster.

**Implemented:** both routes are kept, the Serve HTTPS one at higher priority. **The question:** if
the name-based probe proves slower to settle on a real phone, the fix is a small one — add an explicit
"probe by IP" override per route. Say the word after a device test.

## Q12 — `insecureRouteAck` defaults to OFF, which disables the plain-http fallback route

A `http://100.x.y.z:9222` route is permitted only with the explicit opt-in, because it has no
application-layer TLS (it *is* still WireGuard-encrypted — the code and the UI say so, and never call
it "public plaintext"). With the default, a tailnet user who adds only the raw-IP route sees
"needs consent" until they flip the switch.

**The question for you:** keep the opt-in (explicit consent for a no-TLS route), or trust private
overlay routes by default and reserve the switch for something else? The safest reversible default is
what is shipped; changing it is one boolean.

## Q13 — No Android device was available, so the end-to-end path is UNVERIFIED

There is no Android device and no emulator on this host, so the release APK has never been installed
or launched here, and the app has never talked to the real gateway. What is verified is the release
build and `apksigner`, the offline suite, and the tailnet route from this host's shell. A device test
is the only thing that converts "ships" into "works".

**The question for you:** the moment you have the phone, the three checks worth running are (1) cold
launch with Tailscale disconnected and on cellular — does it connect with no Tailscale UI, (2) turn
Wi-Fi off mid-session and confirm the roster reloads over Tailscale, (3) the Settings → *Estado da
ligação* panel, which names which of the four failures you hit.
