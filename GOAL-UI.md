# GOAL — Personae Mobile 0.4.0: the messenger pane on the phone, four defects fixed, a new APK

**Owner:** cody · **Repo:** `~/Projects/personae-mobile` (React Native + Expo, TypeScript)
**Spec of record:** `~/Projects/personae-mobile/PLAN-UI.md` (REV 5, 439 lines) — **read it before you touch
code; it is binding.** This file is the contract and the acceptance test; the plan carries the design,
the parity matrix and the `file:line` evidence. Where the two disagree, this file wins.

The deliverable is **a new APK on the phone**, not "ships" and not "passes locally".

---

## Ground truth — verified by command on 2026-10-11, not assumed

| Fact | Value |
|---|---|
| Gateway host | `personae-sk`, LAN **10.0.0.15** (`enp3s0`), tailnet `100.64.0.11` |
| **Dashboard** | `0.0.0.0:9119`, running as systemd unit **`hermes-serve.service`** (`hermes dashboard --host 0.0.0.0 --port 9119 --skip-build --no-open`). **This is the surface we target.** |
| api_server `:9222` | listening, **dropped from this design** — do not build against it, do not add features to it |
| Tailnet route | `tailscale serve --https=10443 → http://127.0.0.1:9119` (already repointed and verified: through the tailnet `/api/profiles` → `401 {"reason":"no_cookie","login_url":"/login"}` = the dashboard's own gate) |
| Second LAN machine | `ssh win-desktop` → Windows 11 at **10.0.0.16**, `curl.exe` = `C:\Windows\System32\curl.exe`. Its shell is **cmd.exe**: no `$(...)`, no single-quote strings, use `^` or double quotes. This is the machine the gate probe must come from. |
| Test baseline | `npm test` → **60/60 passed**; `tsc --noEmit` clean. Both must still hold at the end — 60 is a floor, not a target. |
| Version today | `app.json`: `version 0.3.0` / `android.versionCode 3`. `dist/` holds 0.1.0–0.3.0. |
| Icons | `@expo/vector-icons` is **not installed** |
| Build | docker image `personae-android:1` (warm, 7.03 GB) + release keystore **outside** the repo in `~/.personae-android/` (`personae-release.keystore`, `build.env`, `keystore-password.txt`). Host has **no** Android SDK and **no** adb. |
| Device | Pixel 8 tailnet `100.64.0.12` — **not reachable from this host right now** (ping failed). See acceptance #5. |
| Tree | dirty — the 0.3.0 work is uncommitted. That is the only copy. |

**Never print, echo, commit or paste any secret** (bearer, `build.env`, keystore password, dashboard
basic-auth). Reference them by path or env-var name. Nothing secret goes into a `.md`, a commit message
or a log tail you paste.

---

## §0 — Checkpoint first

```
git add -A && git commit -m "checkpoint: 0.3.0 remote-access build, before UI work"
```

Then **one commit per phase** below. Every phase must leave the tree green (`npm test`, `tsc --noEmit`)
and committed, so a budget cut-off is resumable rather than fatal.

---

## §1 — Gate P0.1 (do this FIRST; it is allowed to change the plan)

Build the sanctioned bearer seam on the dashboard and prove it **from another machine**. Nothing in P1/P2
is worth starting until this is proven, because avatars (F1) and live tool activity (F3) ride the same
authenticated channel.

1. **Provider plugin.** Write an out-of-tree dashboard auth provider modelled on the bundled
   `plugins/dashboard_auth/drain/` (constant-time compare, ≥256-bit entropy gate, audit line). Register it
   via `ctx.register_dashboard_auth_provider` (`hermes_cli/plugins.py:766`). Secret is **env-only**: put a
   random ≥256-bit value (`openssl rand -hex 32`) in a root-only file and reference it by
   `EnvironmentFile=`/`Environment=` in a systemd drop-in for `hermes-serve.service`
   (`systemctl edit hermes-serve`; confirm whether it is a user or system unit first) — **same mechanism the
   live basic-auth already uses**. `daemon-reload` + `restart`, then re-verify the **existing browser login
   still works** (no regression for the user) before continuing.
   Check the discovery code for a user-level plugin path before editing anything inside the
   `hermes-agent` git checkout; if the in-tree path is the only one that works, add neither a leftover
   `.orig` nor an uncommitted edit you cannot explain in `PROGRESS.md`.
2. **Token routes.** `register_token_route(path)` is **exact-path set membership — there is no prefix or
   glob** (`hermes_cli/dashboard_auth/`). Register the *smallest* list that the app actually calls, and
   write that list down in `PROGRESS.md` with the path of the code that registers it. Start with
   `/api/profiles` and `POST /api/auth/ws-ticket`; add more only when a phase needs one.
3. **Prove the REST leg cross-machine:** from `win-desktop`, with the bearer, hit
   `http://10.0.0.15:9119/api/profiles` → **200 with profile JSON**. A `401`/`302` here means the provider
   or the route registration is wrong — fix it, do not proceed.
4. **Prove the WS leg cross-machine:** mint a ticket with the bearer (`POST /api/auth/ws-ticket`) and open
   `/api/ws?ticket=…` from that same machine. PowerShell's `ClientWebSocket` is a workable client if
   `curl.exe` cannot speak WS (tickets are **single-use, 30 s** — mint one per attempt).
5. **Record the raw evidence** (both commands, both responses, verbatim) in `logs/p0.1-spike.txt` and
   `PROGRESS.md`, then continue.

**Pre-approved fallback — do not stall on this.** If either leg cannot be made to work, **stop P0.1**, and
switch the transport to the plan's §0.4 **option C**: a second dashboard on loopback (`127.0.0.1:9118`)
reached through `tailscale serve` (Tailscale becomes mandatory; LAN http is off the table). Record which
leg failed, the exact response, and what you tried. Then carry on with P1/P2 against `mock/` and finish
the APK — a 0.4.0 APK that works over Tailscale is the deliverable; an unfinished run is not.

---

## §2 — Scope: P0.2 → P1 → P2 → P7 → build

In order, each with its commit. **Deferred to a later goal, not in this run:** P3 (search/filters),
P4 (groups/colours/manual sort), P5 (multi-select), P6 (Apropos), P8 (layout export/import),
P9 (iOS/EAS), P10 (gateway layout blob). Do not start them; do not half-start them.

- **P0.2** — dashboard adapter behind the existing `src/api` interface: REST + `/api/ws`, bearer in
  `expo-secure-store`, a fresh ticket per WS connection, and `mock/` extended with the dashboard routes
  **and** a fake WS dispatch so every later phase is testable offline. Secrets never in source.
- **P1** — roster parity + **F1** + **F2**. Avatars circular, 28 px, cached, never blocking the rail;
  initial-monogram fallback; icons with PT-PT `accessibilityLabel`.
- **P2** — thread parity + **F3** + **F4**. Real details expansion, session **name** in the top bar.
- **P7** — connections manager + state card + **export log** (§5/§9 of the plan).
- **Build** — `:app:assembleRelease` in `personae-android:1`, copy to `dist/personae-0.4.0.apk`, run
  `logs/verify-apk.sh` and `logs/verify-dex.sh` against it, paste the summary into `PROGRESS.md`.

Build command (from `PROGRESS.md`, no secrets on the line — they arrive via `build.env`):

```
docker run --rm --env-file ~/.personae-android/build.env \
  -v ~/Projects/personae-mobile:/work -v ~/.personae-android/gradle:/root/.gradle \
  -v ~/.personae-android:/signing:ro -w /work/android personae-android:1 \
  bash -lc './gradlew :app:assembleRelease --no-daemon --console=plain --no-parallel --max-workers=1'
```

Set `version` `0.4.0` / `versionCode` `4` in `app.json` before the build. The build must be
**release-signed with the existing keystore** — `build.gradle` falls back to the debug key with a warning
when the store is missing, and a debug-signed "release" APK is a fail, not a warning.

---

## §3 — The four defects (binding specs; evidence and detail in `PLAN-UI.md` §7)

- **F1 profile pictures.** `profiles.get_asset` returns a **data URL** (`methods_profiles.py:446-460`, up to
  2 MB). Render it directly in `<Image>` — no new route. `profiles.list` carries a cheap existence flag.
  Fetch once per profile per session; cache in memory + AsyncStorage keyed `profile+size`; fall back to the
  monogram. Avatars must not delay the roster paint.
- **F2 icon buttons.** Add `@expo/vector-icons` (Ionicons) — **not installed today**. Replace the text
  buttons in the composer, roster toolbar and row affordances. Verify the glyphs survive **release**
  bundling (the font-asset footgun is real: an icon that renders in dev and is a blank box in the APK
  fails this goal). Keep a label where an icon is ambiguous; every icon-only button gets a PT-PT
  `accessibilityLabel`.
- **F3 "Ver detalhes" shows nothing — a bug, three causes.** `app/thread/[id].tsx:175-184` toggles a
  boolean that only changes the **label** — there is no expanded body; `showTools` is **one global
  boolean**; and `src/logic/thread.ts:43-67` never reads `reasoning`/`reasoning_content`. The data is
  already on the wire (`gateway/platforms/api_server.py:3046-3052` allow-lists `tool_calls`, `tool_name`,
  `tool_call_id`, `reasoning`, `reasoning_content`, `display_kind`). Required: real payloads on
  `ThreadItem` (`{kind:'tools', calls:[{name,args,result,ok}]}`, `{kind:'reasoning', text}`); expansion
  state **per run** (a `Set` keyed by item key, never one global flag); tool results joined to their call
  by `tool_call_id`; `display_kind === 'hidden'` scaffolding stays hidden; reasoning as its own collapsed
  "Pensamento" block; and the **live** half via the WS event channel (tool start/complete during a turn).
  Tests: calls+results, reasoning-only, orphan tool result, hidden scaffolding — all offline on `mock/`.
- **F4 top bar shows the session id.** `app/index.tsx:151` and `:216` push `{id, profile}` without the
  title even though the row has it (`:226` renders `item.title`), and `app/thread/[id].tsx:231` sets
  `title: sessionId`. Pass the title as a route param for instant paint, then let `GET /api/sessions/{id}`
  (`web_routers/sessions.py:524`) be authoritative once loaded — that is also how a rename lands while the
  screen is open. Chain: title → id. **A raw id rendered while a title exists fails this goal.**

---

## §4 — Completion condition (every line true, with the command that shows it)

1. `logs/p0.1-spike.txt` exists with the verbatim cross-machine REST **and** WS evidence, or the
   pre-approved option-C fallback with the failing response and what was tried.
2. `npm test` ≥ **60 passing, 0 failing** and `tsc --noEmit` clean on the final commit.
3. `dist/personae-0.4.0.apk` exists; `apkanalyzer`/`aapt2` shows `versionName 0.4.0`, `versionCode 4`;
   the signer is the **Personae release keystore**, not the debug key.
4. Same signing key as 0.3.0 → it installs **over** the existing app (no uninstall, no data loss).
5. On the Pixel 8 (if adb is reachable — over the tailnet, or `adb connect` from a machine that has adb):
   rail renders with **avatars** → a session expands → a **tool call expands and shows its result** →
   the top bar shows the session **name** → the export log shares with a redacted bearer. If the device
   never becomes reachable, emit the exact install + acceptance command list in `PROGRESS.md` for the user
   and say so plainly in your final message — do not claim a device test you did not run.
6. `grep -rIn` over the repo finds **no** bearer, no keystore password, no `build.env` contents, no token
   in source or in any committed log.
7. `PROGRESS.md` updated: what shipped, what is deferred (P3–P6, P8, P9, P10), the token-route list, the
   exact APK path, and any honest gap.

## §5 — NOT DONE IF (any one → keep working)

- A phase is half-applied, or a phase was skipped to save time.
- The APK is debug-signed, or is not 0.4.0/4, or was not run through `verify-apk.sh`.
- "Ver detalhes" still only changes a label, or details collapse/expand all at once (one global bool).
- An icon renders as a blank box in the **release** APK.
- The top bar can still show a raw session id while a title exists.
- The LAN route was degraded to Tailscale-only without the P0.1 fallback being recorded with its evidence.
- A secret or a credential-bearing body reached the repo, a commit, a `.md`, or a log tail.
- The run ends without an APK in `dist/` — an unfinished phase with a clear `PROGRESS.md` is acceptable;
  no APK at all is not.

## §6 — Rules of engagement

- Long run; work in **phases with commits**, keep `PROGRESS.md` current, and prefer a smaller verified step
  over a large unverified one.
- Offline-testable first: every behaviour gets its `mock/` route and its test before it needs the real
  gateway.
- No hardcoded host/IP in source — connections are user-editable settings; the seeded defaults live in the
  connection templates only.
- Do not touch `:9222`, the Funnel entry (`:443` → Pharmacy `:8100`), or any other service's ports. The
  only host-level change authorised here is the `hermes-serve.service` drop-in for the provider secret and
  the (already done) `:10443 → 127.0.0.1:9119` serve mapping.
- Restarting `hermes-serve` briefly drops the user's dashboard — do it once, deliberately, after the drop-in,
  and re-verify browser login immediately afterwards.
- If something is blocked for more than ~30 minutes, record the blocker in `PROGRESS.md` and move to the
  next phase rather than burning the budget on it.
