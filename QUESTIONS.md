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
