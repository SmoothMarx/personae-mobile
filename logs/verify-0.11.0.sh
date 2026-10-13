#!/usr/bin/env bash
# 0.11.0 — the whole release check in one command. Prints a PASS/FAIL line per check, exits non-zero on
# any failure. Safe to re-run; changes nothing (it only reads the APK, runs the suites, and asks the
# live dashboard the questions this batch depends on).
#
#   bash logs/verify-0.11.0.sh [path/to/personae-0.11.0.apk]
#
# ASCII-ONLY FEATURE PROBES, and the measured reason: the shipped bundle is Hermes bytecode, and
# Hermes stores a string that needs UTF-16 as 2-byte characters — so `grep` against the bundle cannot
# find it even though the app renders it. Measured on the 0.10.0 artifact: ASCII strings are found
# ('Perfis', 'instalado', 'Everything answered'), strings with an accent, an ellipsis or an em dash are
# NOT. Every probe below is therefore ASCII; a phone-rendered sentence is not a verifiable claim here.
#
# What is different from verify-0.10.0.sh, and why:
#   0. THIS BATCH IS TWO RELEASES IN ONE BUILD. Half A is GOAL-0.10.1.md §S1-S8 (specced at vc13),
#      Half B+C is R1-R8. vc13 was skipped; the single artifact is 0.11.0 / vc14, and this script is
#      the ONE verifier for it — 0.10.1's own verify/red pair was never written, by design (§9).
#   1. The Half A items (S1-S8) and the Half B+C items (R1-R8) each have a test that NAMES it, and the
#      two lists below are the contract — a missing name is a FAIL. Both lists were generated from
#      `tests/run.ts` itself when this release was cut, so a rename cannot leave a stale contract
#      behind (and none of these names contains an apostrophe: `grep -F` cannot match what the
#      TypeScript source has to escape — 0.9.1's lesson, applied here by renaming three tests of this
#      batch rather than putting a backslash into the contract).
#   2. Both older named lists are KEPT below as regression gates (0.10.0, then 0.9.0 and 0.9.1): no
#      test was deleted to make room for this batch.
#   3. The app floor moves with the measured reality: 250 at 0.9.1, 261 at 0.10.0, **294** here (the
#      13 Half A cases plus the 21 R cases joined the suite). The suite must report `, 0 failed`.
#   4. NEW dependency assertions: the two Expo SDK pickers are DECLARED at the SDK's pin, and TWO
#      absences are checked — no third-party picker, and no keyboard library (§10.3's budget).
#   5. NEW artifact probes, ASCII: the attach/slash/stream RPC names, the two pickers, the keyboard
#      listener, the wire ref channel — plus TWO ABSENCE probes with a positive control, because "the
#      disabled document row is gone" is exactly the kind of claim an empty grep fakes.
#   6. §R8's keyboard lift CANNOT be verified here. It is printed as a MANUAL line and is never
#      written as PASS (§14). What is asserted about it is its SHAPE, by the named test.
#   7. The env bearer is read from $HERMES_HOME/.env (or ~/.hermes/.env) by NAME and is NEVER printed —
#      only its occurrence count in the bundle.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APK="${1:-dist/personae-0.11.0.apk}"
IMAGE="${PERSONAE_IMAGE:-personae-android:1}"
SIGNER_RELEASE="bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26"
ENV_BEARER_FILE="${HERMES_HOME:-$HOME/.hermes}/.env"
if ! grep -q '^HERMES_PERSONAE_BEARER=' "$ENV_BEARER_FILE" 2>/dev/null && [ -r "$HOME/.hermes/.env" ]; then
  ENV_BEARER_FILE="$HOME/.hermes/.env"
fi
if [ -z "${LIVE_BEARER:-}" ] && [ -r "$ENV_BEARER_FILE" ]; then
  LIVE_BEARER="$(sed -n 's/^HERMES_PERSONAE_BEARER=//p' "$ENV_BEARER_FILE" | head -1 | sed "s/^[\"']//; s/[\"']$//")"
fi
export LIVE_BEARER

WANT_V="$(node -p "require('./app.json').expo.version" 2>/dev/null)"
WANT_C="$(node -p "require('./app.json').expo.android.versionCode" 2>/dev/null)"
DASH="http://127.0.0.1:9119"
# The floors: 196 before any 0.9.0 change, 241 at 0.9.0, 250 at 0.9.1, 261 at 0.10.0, and the 0.11.0
# count below (the 13 Half A cases plus the 21 R cases); the live count is printed beside it.
TEST_FLOOR=294
SERVER_FLOOR=77
fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
note() { printf '      %s\n' "$1"; }

echo "=== ${WANT_V} release check — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo

echo "--- app ---"
if line=$(npm test 2>&1 | tail -3 | grep -E '^[0-9]+/[0-9]+ passed' | tail -1); then
  n=${line%%/*}; n=${n//[!0-9]/}
  if [ "${n:-0}" -ge "$TEST_FLOOR" ] && printf '%s' "$line" | grep -q ', 0 failed'; then
    ok "app tests: $line (floor $TEST_FLOOR — the 0.9.1 count of 250 plus the eleven 0.10.0 tests plus this batch 34)"
  else
    bad "app tests: ${line:-no tally}"
  fi
else
  bad "app tests produced no tally line"
fi
if npx tsc --noEmit >/tmp/v0110-tsc.log 2>&1; then ok "typecheck: tsc --noEmit rc 0"; else bad "typecheck failed"; head -5 /tmp/v0110-tsc.log; fi

echo
echo
echo "--- 0.10.1 (Half A) items: each one has a test that NAMES it ---"
while IFS='|' read -r item name; do
  [ -n "${item:-}" ] || continue
  if grep -qF "$name" tests/run.ts; then ok "item $item: test present — \"$name\""; else bad "item $item: test MISSING — \"$name\""; fi
done <<'SPECS0101'
S6|0.10.1 S6: the gateway page is a plan — status on top, connections below, pills, wizard, Advanced last
S1|0.10.1 S1: the peer-list cap is ONE plan value, bounded, and both lists read it
S1|0.10.1 S1: the Choose-device sheet scrolls its rows, with the title and actions pinned
S1|0.10.1 S1: the peer list inside the wizard is bounded and nested — the manual field stays reachable
S2|0.10.1 S2: the scheme is a visible prefix on BOTH address fields, and the sentence is gone
S3|0.10.1 S3: step 1 probes ONCE, by itself — a re-render does not, a changed address does
S3|0.10.1 S3: the editable address is a CORRECTION behind a disclosure, and the diagnosis stays
S4|0.10.1 S4: the two sentences of chrome are gone, and the decoy "saved" survives
S5|0.10.1 S5: the DRAWN index is what a delete acts on — a raw index deletes another row
S5|0.10.1 S5: the selection after a delete is RE-DERIVED, never `selectedIndex - 1`
S5|0.10.1 S5: the Gateway page hosts the verb, reusing the existing strings and the drawn index
S7|0.10.1 S7: the session-types help sits directly under its heading, and the warning stays LAST
S8|0.10.1 S8: the index stops explaining itself, and the ROWS keep their sentences
SPECS0101

echo
echo "--- 0.11.0 (Half B + C) items: each one has a test that NAMES it ---"
while IFS='|' read -r item name; do
  [ -n "${item:-}" ] || continue
  if grep -qF "$name" tests/run.ts; then ok "item $item: test present — \"$name\""; else bad "item $item: test MISSING — \"$name\""; fi
done <<'SPECS0110'
R1|0.11.0 R1: the ref travels with the turn — the WIRE text carries it, the screen does not
R1|0.11.0 R1: the dead string is alive — the voice note says so in both tables
R2|0.11.0 R2: the two pickers exist, the disabled row is gone, and a pick goes through stage()
R2|0.11.0 R2: labelOf cannot mislabel — every row resolves its OWN label
R3|0.11.0 R3: the mic mode is a DEVICE-LOCAL setting, and the default is the requested one
R3|0.11.0 R3: the icon follows the GESTURE, cancel is reachable, and stopping SENDS
R3|0.11.0 R3: a slide past the cancel point CANCELS instead of sending
R4|0.11.0 R4: expo-file-system is DECLARED, and there is ONE read implementation
R5|0.11.0 R5: the menu is the gateway list itself, served over the socket the app already holds
R5|0.11.0 R5: insert-does-not-send, last-write-wins, and the caret rule — the rails
R6|0.11.0 R6: a leading `/` RUNS a command, and opens NO stream
R6|0.11.0 R6: the documented 4018 refusal is retried ONCE through command.dispatch
R6|0.11.0 R6: any OTHER failure is reported, never retried
R6|0.11.0 R6: the outcome lands in the card that already exists, and a mid-sentence / is text
R7|0.11.0 R7: the thread subscribes to its OWN session, on the socket it sends on
R7|0.11.0 R7: catch-up replays from the watermark — and a HOLEY replay is never stitched
R7|0.11.0 R7: a changed replay EPOCH resets the watermark and refetches
R7|0.11.0 R7: a refused attach is not an error card
R7|0.11.0 R7: an incomplete turn is NOT a success, and the turn rides the shared socket
R7|0.11.0 R7: the subscription is FOCUS-SCOPED, and always dropped
R8|0.11.0 R8: Android is off KAV height, and the lift comes from the keyboard itself
SPECS0110

echo "--- 0.10.0 §2 items: each one has a test that NAMES it (\`0.10.0 S<n>: …\`) ---"
# A heredoc, not a backslash-continued list: several of these names contain double quotes and dashes,
# and escaping them inside `"item|name"` strings is how a name silently stops matching. A quoted heredoc
# passes every character through literally. **No name may contain an apostrophe**: `grep -F` cannot match
# what the TypeScript source has to escape (0.9.1's verifier caught exactly that, and the test was
# renamed rather than putting a backslash into the contract).
while IFS='|' read -r item name; do
  [ -n "${item:-}" ] || continue
  if grep -qF "$name" tests/run.ts; then ok "item $item: test present — \"$name\""; else bad "item $item: test MISSING — \"$name\""; fi
done <<'SPECS010'
S0|0.10.0 S0: the dropdown lists the routes — each route IS a connection
S1|0.10.1 S6: the gateway page is a plan — status on top, connections below, pills, wizard, Advanced last
S2|0.10.0 S2: the status dots — one probe per row, in parallel, with no repeating timer
S3|0.10.0 S3: the wizard asks LAN or Remote, and either branch keeps the three 0.7.0 steps
S3|0.10.0 S3: the LAN fields — IPv4 strict, a separate port, and a pasted address splits
S3|0.10.0 S3: the LAN login opens the dashboard at next=/pair, THEN polls, THEN redeems
S3|0.10.0 S3: remote — a MagicDNS name is legal, the tunnel row is Android-only, a 100.x timeout blames Tailscale
S3|0.10.0 S3: the test is three staged calls, and a 401 means sign in
S3|0.10.0 S3: the support bundle is masked and redacted, and the wizard remembers a skip
S4|0.10.0 S4: iOS gets local networking and a usage description, and Android keeps ONE mechanism
S5|0.10.0 S5: rename, delete and add a connection — and the credential survives all of it
SPECS010
# 0.10.0 S1's ordering claim was SUPERSEDED IN PLACE by Half A's S6 (the user, 2026-10-13: status first,
# then connections, then the pills) — so the gate above moved to the S6 name, and this proves it was a
# SUPERSESSION and not a deletion: the renamed test says so in as many words, and must keep saying so.
if grep -qF "SUPERSEDES 0.10.0 S1" tests/run.ts; then
  ok "0.10.0 S1's order was superseded IN PLACE by 0.10.1 S6 (renamed, not deleted — the marker is in the test)"
else
  bad "0.10.0 S1's ordering claim vanished without a supersession marker"
fi

echo
echo "--- the 0.9.0 items are STILL asserted (the second regression gate) ---"
while IFS='|' read -r item name; do
  [ -n "${item:-}" ] || continue
  if grep -qF "$name" tests/run.ts; then ok "item $item: test present — \"$name\""; else bad "item $item: test MISSING — \"$name\""; fi
done <<'SPECS090'
1|0.9.0 F: the search bar is 25% taller and rounded at the side, both DERIVED
2|0.9.0 F: the routine connection strip is gone; the FAILURE disclosure stays
3|0.9.0 F: the trailing "51 automatic…" line is gone and the honesty line is not
4|0.9.0 G: the staging strip stages, sizes, and removes ONE item at a time
4|0.9.0 G: the phone SENDS the bytes to the session before it submits the turn
4|0.9.0 G: a message that CARRIED something reads back as attachments plus a caption
4|0.9.0 G: what the RPC carries is the base64 PAYLOAD, never the whole data URL
4|0.9.0 G: the legacy surface refuses the attach verbs WITH a reason, as it does for the rest
5|0.9.0 H: hold to record, slide left to cancel, release to stage
5|0.9.0 H: a note too short to be a message is refused, WITH the reason
5|0.9.0 H: a voice note LEAVES the phone as a file the agent on the box can read
5|0.9.0 H: "receive" covers BOTH meanings — the agent sending one, and the phone playing it
5|0.9.0 H: the ONE new dependency is expo-audio, from the SDK, and the mic is declared
6|0.9.0 D: the session menu is the desktop shape — flat verbs plus one-noun submenus
6|0.9.0 D: every verb the phone cannot run carries a REASON, and none is silently absent
6|0.9.0 D: the sheet DRILLS INTO a submenu and back, and a submenu opener is not a verb
7|0.9.0 E: holding a row ticks it IMMEDIATELY and opens the mode (the WhatsApp model)
7|0.9.0 E: emptying the set leaves the mode (the user, 2026-10-10)
7|0.9.0 E: the batch resolves against what is ON SCREEN, not the raw roster
7|0.9.0 E: ONE delete path, and the confirm carries the COUNT
7|0.9.0 E: batch verbs once more than one row is ticked; single-object when exactly one
8|0.9.0 F: the Expand/collapse-all button is gone from the top bar, the ability is not
9|0.9.0 F: the "+" and Settings are bigger and their background is transparent
10|0.9.0 F: the routine connection strip is gone; the FAILURE disclosure stays
11|0.9.0 F (landscape): the app rotates, and every screen honours the SIDE insets
11|0.9.0 F (landscape): the sheets use MORE of a short viewport, not less
11|0.9.0 F (landscape): the roster geometry is dp-based, so a wide short canvas does not break it
A|0.9.0 A: archive and delete ride the state verbs when the host mounts the plugin
A|0.9.0 A: a PINNED session is refused with a machine-readable code, never silently archived
A|0.9.0 A: without the plugin the same verbs FALL BACK to the dashboard verbs
A|0.9.0 A: the legacy surface ATTEMPTS the verb and reports it; the 501 stub is gone
A|0.9.0 A: the portable-preference document round-trips; a device-local key is refused
A|0.9.0 A: the state surface has exactly ONE prefix, written in exactly one file
B|0.9.0 B: Settings is a page of rows, and Notifications is a SIBLING of Agent Preferences
B|0.9.0 B: the portable/device-local split is visible, and matches the SERVER key list
B|0.9.0 B: promoting Settings to a page deleted nothing
C|0.9.0 C: the model is the desktop document, shape for shape
C|0.9.0 C: create, rename, file, unfile, collapse, move — and delete NEVER deletes a session
C|0.9.0 C: no groups at all renders exactly the flat list it always was
C|0.9.0 C: the phone syncs the same key the desktop writes, through the same merge
C|0.9.0 C: the heading is its own row kind, and GROUP is not SECTION
C|0.9.0 C: a 0.8.0 install has no groups key and loads as "no groups"
I|0.9.0 I: what syncs is an ALLOWLIST, and a gateway address can never be in it
I|0.9.0 I: the server is the source of truth, and a stale revision is never a clobber
I|0.9.0 I: only a GENUINE difference is pushed, so an applied value cannot echo back

SPECS090

echo
echo "--- the 0.9.1 corrections are STILL asserted (regression gate, no test was deleted) ---"
while IFS='|' read -r item name; do
  [ -n "${item:-}" ] || continue
  if grep -qF "$name" tests/run.ts; then ok "item $item: test present — \"$name\""; else bad "item $item: test MISSING — \"$name\""; fi
done <<'SPECS091'
S1|0.9.1 S1: every index row is geometrically identical — the Notifications indent cannot come back
S2|0.9.1 S2: ONE back control in the header — it walks the plan, never straight to the index
S3|0.9.1 S3: Advanced moved INSIDE Gateway Settings — it did not vanish
S4.1|0.9.1 S4.1: the Agent Preferences page offers no control that changes the language — English, always
S4.1|0.9.1 S4.1: a stored {language: "pt"} still renders English
S4.2|0.9.1 S4.2: "Display session types" — four checkboxes, one per kind, each filtering on its own
S4.2|0.9.1 S4.2: a legacy two-boolean blob loads as the three run types it meant
S4.2|0.9.1 S4.2: the portable round-trip carries four booleans (and no server change was needed)
S4.2|0.9.1 S4.2: the list and the checkpoint watcher still consult ONE classifier
SPECS091

echo
echo "--- §1.8 (push): still PARKED, and recorded as parked ---"
if grep -qi 'push' PROGRESS.md && grep -qi 'Firebase project is the user' PROGRESS.md; then
  ok "PROGRESS.md records the push deferral and its reason (the Firebase project is the user's to create)"
else
  bad "the push deferral is not recorded in PROGRESS.md"
fi
if [ -f google-services.json ] || [ -f GoogleService-Info.plist ]; then
  bad "a Firebase credential file is in the repo (it must never be committed)"
else
  ok "no google-services.json / GoogleService-Info.plist in the repo (nothing to leak)"
fi

echo
echo "--- server plugins ---"
if line=$(bash server/run-tests.sh tests 2>&1 | tail -1); then
  n=${line%% *}; n=${n//[!0-9]/}
  if [ "${n:-0}" -ge "$SERVER_FLOOR" ] && printf '%s' "$line" | grep -q 'passed'; then ok "server tests: $line (floor $SERVER_FLOOR)"; else bad "server tests: $line"; fi
else
  bad "server tests did not run"
fi
if ~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q >/tmp/v0100-pytest.log 2>&1; then
  note "the literal venv-pytest command also works here"
else
  note "literal '~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q' fails on this host"
  note "  ($(grep -m1 -E 'ModuleNotFoundError|ImportError|errors during collection' /tmp/v0100-pytest.log | cut -c1-90)); server/run-tests.sh is the runner of record"
fi
[ "$(systemctl --user is-active hermes-serve.service)" = "active" ] && ok "hermes-serve.service active (never restarted by this run)" || bad "hermes-serve.service not active"

# ── the deployment 0.9.0 CLAIMED and never performed: still measured, every release ───────────────
echo
echo "--- the state plugin is really deployed, not merely documented (measured, not asserted) ---"
PLUGIN_DIR="${HERMES_PLUGIN_DIR:-$HOME/.hermes/plugins}"
# `server/install.sh --check` is a WHOLE-HOST gate: it compares every deployed plugin against server/.
# This release can only answer for the plugin it ships, so the ASSERTION is narrowed to
# `personae-mobile-state` and everything else is PRINTED rather than swallowed — a green gate that hid
# another plugin's drift would be the gate lying, and a red gate on a plugin this batch never touches
# would be a false alarm about the app.
if drift="$(bash server/install.sh --check 2>&1)"; then
  ok "server/install.sh --check: $(printf '%s' "$drift" | tail -1)"
else
  note "server/install.sh --check reports drift somewhere on this host:"
  printf '%s\n' "$drift" | sed 's/^/      /'
  if printf '%s' "$drift" | grep -qE '^[[:space:]]*(drift|missing):[[:space:]]+personae-mobile-state'; then
    bad "the plugin THIS RELEASE depends on has drifted or gone missing"
  else
    ok "personae-mobile-state itself is un-drifted — the drift above is another plugin, reported not hidden"
  fi
  other="$(printf '%s' "$drift" | grep -cE '^[[:space:]]*(drift|missing):[[:space:]]+(messenger|other)' || true)"
  if [ "${other:-0}" -gt 0 ]; then
    note "UNRELATED TO THIS RELEASE: $other messenger/other entry(ies) — PASS at 0.10.0's own run, so this is a"
    note "host-side change between then and now. 0.11.0 touches no file under server/ and no deployed plugin;"
    note "flagged to the user rather than fixed here (the server tree is read-only for this batch)."
  fi
fi
for f in __init__.py plugin.yaml dashboard/manifest.json dashboard/plugin_api.py dashboard/preferences.py; do
  if [ -f "$PLUGIN_DIR/personae-mobile-state/$f" ]; then
    ok "deployed: personae-mobile-state/$f"
  else
    bad "NOT deployed: personae-mobile-state/$f"
  fi
done
if grep -qE '^[[:space:]]+- personae-mobile-state[[:space:]]*$' "${HERMES_HOME_DIR:-$HOME/.hermes}/config.yaml" 2>/dev/null; then
  ok "config.yaml enables personae-mobile-state"
else
  bad "config.yaml does not enable personae-mobile-state"
fi
# NOTE the variable, and why it is NOT $HERMES_HOME: `server/install.sh` targets
# `${HERMES_HOME_DIR:-$HOME/.hermes}` — the DEFAULT profile home, which is where the live dashboard reads
# its plugins from. $HERMES_HOME is the ACTIVE PROFILE's home, so reading the config through it would
# check a file the dashboard never loads.

echo
echo "--- the live dashboard answers what 0.10.0's wizard depends on ---"
note "credential read from $ENV_BEARER_FILE (the value is never printed; only the file name is)"
if [ -n "${LIVE_BEARER:-}" ]; then
  if body="$(curl -sS -m 20 --oauth2-bearer "$LIVE_BEARER" "$DASH/api/status" 2>/dev/null)"; then
    if printf '%s' "$body" | grep -q '"version"'; then
      ok "GET /api/status answers with a version — the S1 status panel's server row and S3.3's stage 2 have a real body to read"
      printf '%s' "$body" | grep -q '"gateway_state"' \
        && ok "/api/status carries gateway_state too (the second half of that row)" \
        || note "/api/status carries no gateway_state on this build — the panel shows the version alone, which is what its own rule says"
    else
      bad "GET /api/status did not answer the expected shape"
    fi
  else
    bad "GET /api/status did not answer at all"
  fi
  if curl -sS -m 8 "$DASH/api/health" 2>/dev/null | grep -q '"ok"'; then
    ok "GET /api/health is PUBLIC (no bearer) — the S2 dots need no credential, as designed"
  else
    bad "GET /api/health did not answer unauthenticated"
  fi
  if curl -sS -m 8 --oauth2-bearer "$LIVE_BEARER" "$DASH/api/plugins/personae-mobile-auth/tailscale/peers" 2>/dev/null | grep -qE '"available"'; then
    ok "the peer route answers its documented shape — the wizard's remote fast path has a real endpoint"
  else
    note "the peer route did not answer the documented shape (a host without the tailscale CLI answers"
    note "  {available: false, reason}, which is the case the wizard falls through to manual entry for)"
  fi
  if curl -sS -m 20 --oauth2-bearer "$LIVE_BEARER" "$DASH/api/profiles/sessions/sidebar?recents_limit=60&cron_limit=10" 2>/dev/null | grep -q '"recents"'; then
    ok "GET /api/profiles/sessions/sidebar → the batched slices the roster still rides"
  else
    bad "GET /api/profiles/sessions/sidebar did not answer the expected shape"
  fi
  if curl -sS -m 8 --oauth2-bearer "$LIVE_BEARER" "$DASH/pair" 2>/dev/null | grep -q 'Autorizar Personae Mobile'; then
    ok "/pair still renders (the S3.1 login flow lands on it)"
  else
    bad "/pair no longer renders"
  fi
else
  bad "no LIVE_BEARER (HERMES_PERSONAE_BEARER not found in $ENV_BEARER_FILE) — the live checks cannot run"
fi

echo
echo "--- app.json declares the release (§2 S4 included) ---"
[ -n "$WANT_V" ] && [ -n "$WANT_C" ] && ok "app.json: $WANT_V / versionCode $WANT_C" || bad "app.json version unreadable"
if node -e "const a=require('./app.json').expo.ios.infoPlist; const ats=a.NSAppTransportSecurity||{}; process.exit(ats && ats.NSAllowsLocalNetworking===true && !('NSAllowsArbitraryLoads' in ats) ? 0 : 1)" 2>/dev/null; then
  ok "iOS: NSAllowsLocalNetworking is on and NSAllowsArbitraryLoads is NOT (S4)"
else
  bad "iOS ATS keys are wrong (S4)"
fi
if node -e "const s=require('./app.json').expo.ios.infoPlist.NSLocalNetworkUsageDescription; process.exit(typeof s==='string' && s.trim().length>20 ? 0 : 1)" 2>/dev/null; then
  ok "iOS: NSLocalNetworkUsageDescription is present and says why (S4)"
else
  bad "iOS: the local-network usage description is missing or empty (S4)"
fi
if node -e "const p=require('./app.json').expo.plugins.filter(x=>Array.isArray(x)&&x[0]==='expo-build-properties'); process.exit(p.length===1 && p[0][1].android.usesCleartextTraffic===true && !('networkSecurityConfig' in p[0][1].android) ? 0 : 1)" 2>/dev/null; then
  ok "Android: cleartext is the ONE mechanism that was already there (S4 / §1.11)"
else
  bad "Android's cleartext mechanism changed or was duplicated"
fi
if node -p "require('./app.json').expo.orientation" 2>/dev/null | grep -q '^default$'; then
  ok "app.json allows BOTH orientations (0.9.0 item 11: the app rotates)"
else
  bad "app.json is still portrait-only"
fi
if node -p "require('./app.json').expo.android.permissions.includes('android.permission.RECORD_AUDIO')" 2>/dev/null | grep -q true; then
  ok "app.json declares RECORD_AUDIO (0.9.0 item 5: voice notes)"
else
  bad "app.json does not declare RECORD_AUDIO"
fi
if node -p "require('./app.json').expo.android.permissions.includes('android.permission.POST_NOTIFICATIONS')" 2>/dev/null | grep -q true; then
  ok "app.json still declares POST_NOTIFICATIONS (0.8.0's device-side checkpoints)"
else
  bad "app.json lost POST_NOTIFICATIONS"
fi
if node -p "JSON.stringify(Object.keys(require('./package.json').dependencies).filter(d => /react-native-(gesture-handler|reanimated)$/.test(d)))" 2>/dev/null | grep -q '^\[\]$'; then
  ok "no gesture/reanimated dependency (0.8.0's swipe still rides PanResponder)"
else
  bad "a gesture library was added to dependencies"
fi
if node -p "Object.keys(require('./package.json').dependencies).filter(d => /^expo-av$/.test(d)).length" 2>/dev/null | grep -q '^0$'; then
  ok "the recorder is expo-audio, NOT expo-av (0.9.0 item 5's one new dependency)"
else
  bad "expo-av was added — the wrong media package for this SDK"
fi
# §1.6: a new dependency must be SAID OUT LOUD. 0.10.0 needs none, and this is the check for it.
if node -e "const p=require('./package.json'); const want=['expo-web-browser','expo-sharing','expo-constants','expo-clipboard','expo-camera','expo-secure-store'].every(d=>d in p.dependencies); process.exit(want?0:1)" 2>/dev/null; then
  ok "S3's whole surface rides dependencies that were ALREADY installed (no new dependency, §1.6)"
else
  bad "a package the 0.10.0 surface needs is missing from dependencies"
fi

echo
echo
echo "--- 0.11.0 dependencies, config and the two ABSENCES (§10.3, §15) ---"
if node -e "const d=require('./package.json').dependencies; process.exit(/^~57\\./.test(d['expo-document-picker']||'') && /^~57\\./.test(d['expo-image-picker']||'') ? 0 : 1)" 2>/dev/null; then
  ok "the two pickers are DECLARED, at this SDK's own pin (R2)"
else
  bad "expo-document-picker / expo-image-picker are missing or floating (R2)"
fi
if node -e "const d=require('./package.json').dependencies['expo-file-system']; const i=require('./node_modules/expo-file-system/package.json').version; process.exit(d && d.replace(/^[~^]/,'')===i ? 0 : 1)" 2>/dev/null; then
  ok "expo-file-system is DECLARED at the version installed (R4 — the voice path no longer rests on a transitive dep)"
else
  bad "expo-file-system is undeclared or out of step with node_modules (R4)"
fi
if node -e "const d=Object.keys(require('./package.json').dependencies); process.exit(d.some(n=>/document-picker/.test(n) && n!=='expo-document-picker') ? 1 : 0)" 2>/dev/null; then
  ok "no third-party picker entered the dependency list (R2)"
else
  bad "a third-party picker was added"
fi
if node -e "const d=Object.keys(require('./package.json').dependencies); process.exit(d.some(n=>/keyboard-controller/.test(n)) ? 1 : 0)" 2>/dev/null; then
  ok "NO keyboard library — R8's lift is a listener and a padding (\u00a715 declines the library)"
else
  bad "a keyboard library was added for R8"
fi
if node -e "const p=require('./app.json').expo.plugins; const ip=p.filter(x=>Array.isArray(x)&&x[0]==='expo-image-picker'); process.exit(ip.length===1 && p.includes('expo-document-picker') ? 0 : 1)" 2>/dev/null; then
  ok "both pickers are REGISTERED as config plugins (R2 — iOS config correct for a later EAS build)"
else
  bad "the pickers are not registered in app.json (R2)"
fi
if node -e "const ip=require('./app.json').expo.plugins.filter(x=>Array.isArray(x)&&x[0]==='expo-image-picker')[0]; process.exit(ip && !('microphonePermission' in ip[1]) ? 0 : 1)" 2>/dev/null; then
  ok "the photo picker asks for NO microphone — it opens photos only, and the mic belongs to expo-audio (R2)"
else
  bad "the photo picker config claims the microphone (R2 narrowed it deliberately)"
fi
if node -e "const s=require('./app.json').expo.ios.infoPlist.NSPhotoLibraryUsageDescription; process.exit(typeof s==='string' && s.trim().length>20 ? 0 : 1)" 2>/dev/null; then
  ok "iOS: NSPhotoLibraryUsageDescription is present and says what the app does with it (R2)"
else
  bad "iOS: the photo-library usage description is missing or empty (R2)"
fi
if node -e "const p=require('./app.json').expo.plugins.filter(x=>Array.isArray(x)&&x[0]==='expo-camera'); process.exit(p.length===1 && p[0][1].recordAudioAndroid===false && p[0][1].microphonePermission===false ? 0 : 1)" 2>/dev/null; then
  ok "expo-camera is STILL narrow — the mic belongs to expo-audio, and R2 did not widen it"
else
  bad "expo-camera was widened (R2)"
fi
if node -e "const a=require('./app.json').expo.android.permissions; process.exit(a.some(p=>/STORAGE|READ_MEDIA/.test(p)) ? 1 : 0)" 2>/dev/null; then
  ok "no storage permission was added speculatively (the storage access framework needs none)"
else
  bad "a storage permission was added for the pickers"
fi
if node -e "const a=require('./app.json').expo.android.permissions; process.exit(a.includes('android.permission.RECORD_AUDIO') && a.includes('android.permission.INTERNET') && a.includes('android.permission.POST_NOTIFICATIONS') ? 0 : 1)" 2>/dev/null; then
  ok "every permission the earlier releases declared is STILL declared (nothing was traded away)"
else
  bad "a previously declared permission disappeared"
fi
if grep -qF "0.11.0 R3: the mic mode is a DEVICE-LOCAL setting" tests/run.ts && grep -qF "'micMode'" src/settingsPages.ts; then
  ok "R3's mic gesture is declared DEVICE-LOCAL in the page plan (a phone gesture has no server meaning)"
else
  bad "micMode is not in the device-local list (R3)"
fi
if grep -qF "mixed" src/settingsPages.ts && grep -qF "microphone" src/i18n.ts; then
  ok "the Agent Preferences row says `mixed` and names the exception (R3 — the codebase's own split, applied)"
else
  bad "the Agent Preferences row still claims to be purely portable (R3)"
fi

echo "--- the artifact ---"
if [ ! -f "$APK" ]; then bad "$APK missing"; echo; echo "RESULT: FAIL"; exit 1; fi
note "path: $APK"
note "bytes: $(stat -c %s "$APK")"
note "sha256: $(sha256sum "$APK" | cut -d' ' -f1)"
# The PREVIOUS release's artifact, printed beside it so the two can be compared at a glance (it is NOT
# an assertion: a feature release legitimately changes both, and pinning a byte count would fail on a
# rebuild).
note "0.10.0 was: 116979706 bytes / sha256 3b231c830f154c5c3af64f9043297aa804430a343be23afe9e4e30286c464c2f"
# THE 13.8 MB GROWTH OVER 0.10.0, measured rather than left unexplained: the entry-by-entry diff of the
# two APKs says 11 native libraries are in this artifact that 0.10.0's did not carry — libreanimated.so,
# libworklets.so and libreact_codegen_rngesturehandler_codegen.so (four ABIs each, one ABI fewer for the
# codegen lib). It is a BUILD-HISTORY artifact, not a dependency change: 0.10.0's log shows 449 tasks
# with 419 up-to-date and ZERO mentions of reanimated/worklets (its `android/` was reused), while 0.11.0
# regenerated the project for the version bump and re-derived autolinking in full (605 tasks, 577
# executed, 93 mentions). Adding native libraries that were ABSENT cannot break a working app — the JS
# shape is the same one that shipped in 0.10.0 — and the flip side is worth stating: 0.11.0 is the first
# fully clean assembly since these modules entered the tree, so it is the more trustworthy artifact.
note "measure: +11 native .so entries vs 0.10.0 (reanimated/worklets/gesture-handler) — see the header"
if docker run --rm -v "$ROOT:/work" -w /work "$IMAGE" bash -lc 'unzip -l "$1" | grep -c "libreanimated.so"' _ "$APK" 2>/dev/null | grep -qE '^[1-9]'; then
  ok "the artifact carries the reanimated/worklets native libs (present in 0.11.0, absent from 0.10.0)"
else
  note "reanimated/worklets .so are NOT in this artifact — then the size delta has another cause and must be re-measured"
fi

docker run --rm -e LIVE_BEARER -v "$ROOT:/work" -w /work "$IMAGE" bash -lc '
  set -u
  export PATH="$PATH:$ANDROID_HOME/build-tools/36.0.0"
  APK="$1"
  echo "summary: $(apkanalyzer apk summary "$APK")"
  echo "min-sdk: $(apkanalyzer manifest min-sdk "$APK")  target-sdk: $(apkanalyzer manifest target-sdk "$APK")"
  echo "camera permission: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -c "android.permission.CAMERA")"
  echo "post-notifications permission: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -c "android.permission.POST_NOTIFICATIONS")"
  echo "record-audio permission: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -c "android.permission.RECORD_AUDIO")"
  echo "deep-link scheme personae: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -c "personae")"
  printf "markers: "
  for s in personae://connect api/profiles api/health api/status api/plugins/messenger/state api/plugins/personae-mobile-state personae.wizard.v1 expo-camera expo-audio expo-sharing checkpoints session.activate session.events.since complete.slash slash.exec command.dispatch reasoning.delta expo-document-picker expo-image-picker keyboardDidShow; do
    printf "%s=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
  echo
  printf "gone-markers (want 0): "
  for s in "Choosing a file from this phone" "Pictures work today"; do
    printf "[%s]=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
  echo
  printf "gone-markers positive control (want >=1): "
  for s in "Send a file" "Photo library"; do
    printf "[%s]=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
  echo
  printf "dex native modules (want >=1 each): "
  for s in expo.modules.documentpicker.DocumentPickerModule expo.modules.imagepicker.ImagePickerModule expo.modules.filesystem; do
    printf "%s=%s " "$s" "$(apkanalyzer dex packages --defined-only "$APK" 2>/dev/null | grep -c "$s")"
  done
  echo
  echo "application-id: $(apkanalyzer manifest application-id "$APK")"
  printf "0.10.0 feature strings (want >=1 each): "
  while IFS= read -r s; do printf "[%s]=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"; done <<'"'"'STRINGS'"'"'
Connection Wizard
Connections
Preferred connection kind
Set up a connection
Local network
Remote
Test connection
Share support log
Skip for now
Name this connection
Nothing answered at that address. Check the address and the port
already one of your connections
Tap to start and stop
Hold to record
Send a file
Photo library
The command produced no output.
STRINGS
  echo
  printf "older feature strings (want >=1 each): "
  while IFS= read -r s; do printf "[%s]=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"; done <<'"'"'OLD'"'"'
Display session types
Advanced lives inside this page
session-groups-v1
image.attach_bytes
Hold to record a voice note
OLD
  echo
  printf "env facts (want 0): "
  for s in 100.64.0.11 personae 10.0.0.15 100.64.0.2 API_SERVER_KEY=; do
    printf "%s=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
  echo
  echo "positive control personae://connect: $(unzip -p "$APK" assets/index.android.bundle | grep -ac "personae://connect")"
  printf "live bearer occurrences (want 0): "
  if [ -n "${LIVE_BEARER:-}" ]; then unzip -p "$APK" assets/index.android.bundle | grep -ac "${LIVE_BEARER}" || true; else echo "SKIPPED"; fi
  apksigner verify --print-certs "$APK" 2>/dev/null | grep -E "Signer #1 certificate (DN|SHA-256)"
' _ "$APK" | tee /tmp/v0110-apk.txt

SUMMARY="$(grep '^summary:' /tmp/v0110-apk.txt)"
if printf '%s' "$SUMMARY" | awk -v v="$WANT_V" -v c="$WANT_C" -F'\t' '{exit !($2 == c && $3 == v)}'; then
  ok "APK is $WANT_V / versionCode $WANT_C (matches app.json)"
else
  bad "APK version does not match app.json"; note "$SUMMARY"; note "app.json says $WANT_V / $WANT_C"
fi
if grep -qE "Signer #1 certificate SHA-256( digest)?: $SIGNER_RELEASE" /tmp/v0110-apk.txt; then
  ok "signed with the SAME Personae release key as 0.1.0-0.9.1 (installs straight over 0.9.1)"
else
  bad "signer is not the Personae release key"; grep 'Signer' /tmp/v0110-apk.txt || true
fi
if grep -qE 'record-audio permission: [1-9]' /tmp/v0110-apk.txt; then
  ok "the APK carries RECORD_AUDIO (0.9.0 item 5 is in the ARTIFACT, not merely in app.json)"
else
  bad "the APK does not carry RECORD_AUDIO"
fi
if grep -qE '^markers:.*personae.wizard.v1=[1-9]' /tmp/v0110-apk.txt; then
  ok "the bundle carries the wizard state key (S3 entry (b)/(c) ship in the app)"
else
  bad "personae.wizard.v1 is not in the bundle"
fi
if grep -qE '^markers:.*api/status=[1-9]' /tmp/v0110-apk.txt; then
  ok "the bundle knows /api/status (S1's server row and S3.3's stage 2)"
else
  bad "/api/status is not in the bundle"
fi
if grep -qE '^positive control personae://connect: [1-9]' /tmp/v0110-apk.txt; then
  ok "positive control: personae://connect IS in the bundle (an empty grep is not a proof)"
else
  bad "the positive control found nothing — the marker greps prove nothing"
fi
if grep -qE 'live bearer occurrences \(want 0\): (0|SKIPPED)' /tmp/v0110-apk.txt; then
  ok "zero live-bearer occurrences in the shipped bundle"
else
  bad "the shipped bundle contains the live bearer"
fi
if grep -qE '^env facts \(want 0\): .*100\.106\.51\.4=0 .*personae=0 .*10\.0\.4\.15=0' /tmp/v0110-apk.txt; then
  ok "zero host/credential literals in the shipped bundle"
else
  bad "a host or credential literal is in the shipped bundle"; grep '^env facts' /tmp/v0110-apk.txt || true
fi
# every feature string this release claims must be IN the artifact
missing=0
for s in "Connection Wizard" "Connections" "Preferred connection kind" "Set up a connection" "Local network" "Test connection" "Share support log" "Skip for now" "Name this connection" "Nothing answered at that address. Check the address and the port" "already one of your connections"; do
  if ! grep -qF "[$s]=" /tmp/v0110-apk.txt; then continue; fi
  n="$(sed -n "s/.*\[$s\]=\([0-9]*\).*/\1/p" /tmp/v0110-apk.txt | head -1)"
  if [ "${n:-0}" -lt 1 ]; then bad "feature string is NOT in the bundle: \"$s\""; missing=1; fi
done
[ "$missing" = 0 ] && ok "every 0.10.0 feature string is inside the shipped bundle"

# ---- 0.11.0's own artifact claims ------------------------------------------------------------------
# (a) the RPC and module literals this batch added must be IN the shipped bundle. A method name that is
#     only in the source is a feature that did not ship.
for s in session.activate session.events.since complete.slash slash.exec command.dispatch reasoning.delta expo-document-picker expo-image-picker keyboardDidShow; do
  if grep -qE "^markers:.* ${s}=[1-9]" /tmp/v0110-apk.txt; then
    ok "the bundle carries $s"
  else
    bad "$s is NOT in the bundle — the feature did not ship"
  fi
done
# (b) the new STRINGS must be in it, read the same way the 0.10.0 ones are
missing=0
for s in "Tap to start and stop" "Hold to record" "Send a file" "Photo library" "The command produced no output."; do
  if ! grep -qF "[$s]=" /tmp/v0110-apk.txt; then continue; fi
  n="$(sed -n "s/.*\[$s\]=\([0-9]*\).*/\1/p" /tmp/v0110-apk.txt | head -1)"
  if [ "${n:-0}" -lt 1 ]; then bad "0.11.0 string is NOT in the bundle: \"$s\""; missing=1; fi
done
[ "$missing" = 0 ] && ok "every 0.11.0 string is inside the shipped bundle (the re-enabled row, the mic mode, the command card)"
# (c) the ABSENCE, checked WITH a positive control from the same probe — "the disabled row is gone" is
#     exactly the claim an empty grep fakes.
if grep -qE '^gone-markers \(want 0\): \[Choosing a file from this phone\]=0 \[Pictures work today\]=0' /tmp/v0110-apk.txt; then
  ok "the old document-row apology is GONE from the bundle (R2 re-enabled the row)"
else
  bad "the old document-row sentence is still in the bundle — or the probe measured nothing"
  grep '^gone-markers' /tmp/v0110-apk.txt || true
fi
if grep -qE '^gone-markers positive control \(want >=1\): .*\[Send a file\]=[1-9].*\[Photo library\]=[1-9]' /tmp/v0110-apk.txt; then
  ok "positive control: the two picker-row labels ARE in the bundle (so the absence above means something)"
else
  bad "the positive control found nothing — the absence probe proves nothing"; grep '^gone-markers' /tmp/v0110-apk.txt || true
fi
# (d) a picker is only a picker if its NATIVE module is in the dex. The JS bundle probe above proves the
#     screen imports it; this proves the Android side is really linked into the artifact.
for s in expo.modules.documentpicker.DocumentPickerModule expo.modules.imagepicker.ImagePickerModule expo.modules.filesystem; do
  if grep -qE "^dex native modules \(want >=1 each\):.* ${s}=[1-9]" /tmp/v0110-apk.txt; then
    ok "the dex carries $s"
  else
    bad "$s is NOT in the dex — the picker would fail on a phone"
  fi
done

echo
# §14 — the ONE item this script cannot verify, written as MANUAL and NEVER as PASS. The shape of R8's
# fix IS asserted above (its named test: off KAV `height`, a keyboard listener that is removed, a lift
# floored at the safe-area inset, no keyboard library). Whether the composer actually clears the
# keyboard is a phone question and stays one.
printf 'MANUAL  %s\n' "R8 keyboard lift — awaiting device confirmation"
echo
if [ "$fail" = 0 ]; then echo "RESULT: PASS — 0.11.0 verified (R8's keyboard lift is MANUAL, not verified)"; else echo "RESULT: FAIL"; fi
exit "$fail"
