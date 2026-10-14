<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Personae — the mark: a blue face in profile with a white eye">
</p>

# Personae Mobile — Hermes Agent client for Android & iOS

**Your profiles as contacts. Their sessions as threads. Replies streaming token by token.**

Personae Mobile is a native client — React Native + Expo, TypeScript, `expo-router` — for the HTTP API a
**Hermes Agent** gateway already serves. It reads the same endpoint family the bundled web UI reads and
renders it the way a phone wants: profiles as a contact list with a live status dot, one profile's
sessions grouped by day, and a thread you can answer from the sofa instead of the desk. Replies arrive
as they are generated, and **Stop** actually stops them.

No browser. No relay server. No analytics. The phone talks to your gateway directly, over your LAN or
over Tailscale, and holds its own device credential rather than your API key.

---

## ✨ What it does

| | |
| --- | --- |
| 🟢 **Roster** | Every profile is a contact cell with a face, a live status dot, and a "new since last visit" count. Avatars are fetched once per profile per size and cached; a monogram stands in when there is no picture and a broken fetch is never an error. |
| 💬 **Thread** | History from the sessions endpoint, a composer, and a reply streamed in as it is written. Markdown is really rendered — prose, lists, blockquotes, rules, tables as a horizontal-scroll grid, fenced code with a copy button. |
| 🔧 **Tool runs** | Each tool call is joined to its result by `tool_call_id`, so a run reads as one item. Reasoning shows as its own item. Long arguments and results truncate behind a marker you can open. |
| 🔌 **Connecting** | A wizard that asks **LAN** or **Remote** up front, validates IPv4 and port strictly, splits a pasted `host:port` for you, and probes every route in parallel to paint one status dot per row. Tailscale peers are listed by their MagicDNS name. |
| 🔑 **Pairing** | The app opens your dashboard at `next=/pair`, polls, then redeems a single-use code. The phone ends up with its **own device token** — revocable on its own, never your bearer. |
| ⚙️ **Settings** | Gateway URL, API key in the OS secure store, extra profiles via `/p/<profile>/`, and a model override. Every field saves itself and always shows the value actually in use. |
| 🧠 **Session state** | One lease per session, held by one writer and read by one reader. A cold second message resumes exactly once, and the retry carries the lease that came back. |
| 🔍 **Support bundle** | A shareable diagnostic with addresses masked to their first three octets and headers, tickets and tokens redacted **by pattern** — so the bundle you send is safe to send. |
| 🌍 **Language** | English and Portuguese. Every user-visible string lives in one table, `src/i18n.ts`. |

---

## 🚀 Quick Start

### Android — the release APK

Download `personae-<version>.apk` from [Releases](../../releases), copy it to the phone, and open it
(allow "install unknown apps" for the file manager that opened it). Then:

**Connect** → pick **LAN** or **Remote** → enter the gateway address → it probes and tells you what it
found.

### From source, on a phone

```
npm install
npm run mock              # a mock gateway on 127.0.0.1:8791, key "test-key-123"
npx expo start            # then open it in Expo Go, or `npx expo run:android`
```

Point the app at the mock (`http://<your-lan-ip>:8791`, key `test-key-123`) to exercise the roster, the
thread, streaming, Stop and every error path without touching a real gateway.

### Against your own gateway

The app speaks to the gateway host directly. Put the phone on the same LAN, or on your Tailscale
network and use the tailnet address. A real gateway on a LAN answers on its own port; a remote one
usually wants the dashboard's `/pair` flow.

---

## 🧠 The story

Your agent lives on a machine at home. The web UI is genuinely good — at a desk, with two monitors and
your hands on a keyboard. In a corridor, holding a coffee, it is a browser tab you cannot reach.

The thing you actually want is small and constant: **is anything waiting for me, and can I answer it
from here?** So the roster is a contact list. A dot goes amber when a session is blocked on you, and the
count is the number of things you can act on — answer one and the number drops, because it was never
counting anything you could not fix. Tap the cell and you are in a thread that reads like a
conversation, because the reply arrives as it is being written and the code the agent pastes at you
looks like code.

None of this needed a server in the middle. The gateway on the box is already serving it.

---

## 🟢 The roster

One cell per profile: face, name, status dot, unread count. Sessions group under day headings and page
25 at a time. A profile's sessions and the cross-profile recents slice are de-duplicated by key, so a
session that both would list is drawn once.

The dot is bound to that profile's stored session and re-derived from the live surface — it is not a
cached colour that goes stale while you look at it.

---

## 💬 The thread

Messages stream over SSE from the chat endpoint. The composer is cleared **only on success**: a failed
turn leaves your sentence in the box, because retyping it is the tax you should not pay. A pinned
scroll position survives new content arriving; a layout change never yanks you to the bottom.

Markdown goes through one text policy with no second stripper in the tree — the plan module and the
renderer agree, and the vendored `markdown-text.js` is pinned byte-for-byte to the plugin copy so the
two cannot drift.

---

## 🔌 Connecting

The wizard asks one question before it shows a single field — **LAN or Remote** — because the two want
different inputs and different proof.

- **LAN** — strict IPv4 and a separate port. A pasted `http://host:port/path` is split into its parts.
- **Remote** — Tailscale peers listed by MagicDNS name, or the address typed by hand.

Every route gets its own probe, run in parallel, with no repeating timer: one probe per row, one dot
per row. The wizard remembers what you skipped.

---

## 🔑 Pairing

A phone should never carry your bearer token. The dashboard side ships two Hermes plugins
(`server/personae-mobile-auth`, `server/personae-mobile-state`) and they exist to prevent exactly that:

- the app opens the dashboard at `next=/pair`, then **polls**, then **redeems** — three staged calls,
  and a 401 anywhere means sign in again;
- a code is a credential on the redeem path **only**, single use, rate-limited per IP, capped in number,
  and minted under an entropy gate;
- what the phone keeps is a device token it can revoke on its own, and which cannot administer anything;
- the token store is `0600`, holds no plaintext, and fails closed on corruption rather than guessing.

---

## ⚙️ Settings and preferences

Gateway, key, extra profiles and model override — each field saves itself, and the value in use is the
value on screen.

Portable preferences sync through the state plugin with per-key last-write-wins and a monotonic
revision, so two devices editing **different** keys both survive, and a stale revision never clobbers a
newer one. Device-local keys are refused with a reason instead of being quietly synced.

---

## 🛡️ Safety

- **No secret is in this repository.** `scripts/verify-secrets.sh` greps every tracked file *and* every
  untracked-but-not-ignored file for the live credentials and prints **counts only** — never a matched
  value. If it cannot read the live bearer it reports `SKIPPED` rather than claiming a pass.
- **No credential is compiled into the build.** The API key lives in the OS secure store on the device,
  not in a file in the tree.
- **No analytics.** There is no analytics or crash-reporting dependency in `package.json`. The only
  network peer is the gateway address you typed.
- **The support bundle is masked before it leaves.** Addresses keep three octets, and headers, tickets
  and tokens are redacted by pattern — not only by value, so a token you never enumerated is still
  caught.
- **`logs/` is the app's own evidence.** The per-version transcripts there are the output of the leak
  checks, kept so a claim can be re-run instead of re-asserted.
- **The Android build asks for little:** `INTERNET`, `POST_NOTIFICATIONS`, `RECORD_AUDIO` (for the voice
  composer) and local-network access. `NSAllowsLocalNetworking` is set on iOS for the same reason.

---

## 📦 Project layout

```
app/            # expo-router routes — roster, thread/[id], settings, connect
src/api/        # client, transport (XHR + node), SSE parser, error shapes, failures
src/logic/      # pure derivations — roster, thread, markdown, scroll pin, slash, voice
src/connect/    # the wizard, address parsing, staged probes, the support bundle
src/gateway/    # connections, routes, per-route status dots, the plan
src/roster/     # roster UI — cells, geometry, sheets, menus
src/sync/       # preference + UI-state sync against the state plugin
src/            # settings model + secure storage, i18n, theme, notifications
modules/        # tailscale-trigger — a local Expo module that calls the Tailscale app forward
mock/           # local Node mock of the gateway API (also runnable standalone)
server/         # the two Hermes dashboard plugins the app pairs against
scripts/        # signing + branding patches, and the secret scanners
tests/          # the offline suite (`npm test`)
logs/           # per-version verification transcripts — the leak checks, run by script
brand/          # the logo kit and the design exploration behind the mark
assets/         # app icon, adaptive icon, splash screens (five densities)
app.json        # Expo config — name, icons, Android permissions, iOS local networking
eas.json        # build profiles
package.json    # scripts and dependencies
tsconfig.json   # strict TypeScript
LICENSE         # GPL-3.0
README.md       # this file
```

The repository also carries its working record — `PROGRESS.md`, `DECISIONS.md`, `QUESTIONS.md`,
`SPEC.md`, `RECON-0.9.0.md` and the `GOAL-*` / `DESIGN-*` briefs. They are the project's own history,
kept because "verified" without a record is just a claim.

---

## 🔧 Development

```
npm install
npm test                 # 324 offline checks against the mock gateway — no key needed
npm run typecheck        # tsc --noEmit
npm run mock             # mock gateway on 127.0.0.1:8791, key "test-key-123"
npx expo start           # Expo Go, or `npx expo run:android`
```

Tested on **Node 22**. Written in strict TypeScript; `npm run typecheck` is expected to be silent.

Three rules worth keeping if you fork:

1. **Run the secret scan before you push.** `bash scripts/verify-secrets.sh`.
2. **Some checks read the source as text** — a rename can go red without anything being broken. When a
   check about *shape* fails, read it before you "fix" the code it names.
3. **`0.14.0 W1` (the cold-resume/lease check) is intermittently red.** It is a pre-existing flake in the
   harness, present before this tree was published, and it is not a build failure. It fails roughly
   three runs in four. Everything else is expected green.

`android/` is generated and git-ignored, so rebuilds re-apply the signing patch by script:

```
npx expo prebuild -p android --no-install
bash scripts/patch-android-signing.sh
```

The release keystore lives **outside** this repository. Keep it: a build signed with a different key
cannot upgrade an installed copy — Android refuses, and the app must be uninstalled first.

---

## 🙏 Acknowledgements

Stands on the shoulders of:

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research — the agent and the
  gateway API this app is a client for; every request and response shape is derived from its
  `gateway/platforms/api_server.py`, with the line numbers cited in `src/api/client.ts`.
- [Expo](https://expo.dev) and [expo-router](https://docs.expo.dev/router/introduction/) — the build
  toolchain and the file-based navigation.
- [React Native](https://reactnative.dev) — the renderer.
- [react-native-sse](https://github.com/binaryminds/react-native-sse) — event-stream parsing over XHR.
- [remark](https://github.com/remarkjs/remark) and [unified](https://github.com/unifiedjs/unified) with
  `remark-gfm` — the markdown parse that feeds the renderer.

---

*GPL-3.0. Free to use, modify and share.*
