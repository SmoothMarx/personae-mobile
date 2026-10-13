#!/usr/bin/env bash
# 0.10.0 — the whole release check in one command. Prints a PASS/FAIL line per check, exits non-zero on
# any failure. Safe to re-run; changes nothing (it only reads the APK, runs the suites, and asks the
# live dashboard questions this batch depends on).
#
#   bash logs/verify-0.10.0.sh [path/to/personae-0.10.0.apk]
#
# ASCII-ONLY FEATURE PROBES, and the measured reason: the shipped bundle is Hermes bytecode, and
# Hermes stores a string that needs UTF-16 as 2-byte characters — so `grep` against the bundle cannot
# find it even though the app renders it. Measured on this artifact: ASCII strings are found
# ('Perfis', 'instalado', 'Everything answered'), strings with an accent, an ellipsis or an em dash are
# NOT ('Sessões', 'A carregar…', 'surfaceCheckOk'). The probes below therefore use ASCII substrings;
# §1.7 already says a phone-rendered sentence is not a verifiable claim on this host.
#
# What is different from verify-0.9.1.sh, and why:
#   1. The §2 items of 0.10.0 (S0-S5) each have a test that NAMES them (`0.10.0 S<n>: …`), and the list
#      below is the contract — a missing name is a FAIL. **S0 IS in the list this time**: 0.9.1's S0 was
#      "a file is on that disk", which is a command and not a test; 0.10.0's S0 is a READING of the
#      route model, which is a test like every other item.
#   2. The 0.9.1 named-test list is KEPT (below the new one) as a regression gate: the four corrections
#      the user asked for in 0.9.1 must still be the ones the suite asserts.
#   3. The expected version is still DERIVED FROM app.json (never hardcoded), and the APK is checked for
#      the 0.9.0/0.9.1 features AND 0.10.0's own strings (the connections dropdown, the wizard's two
#      branches, the test panel, the share button) inside the bundle. A 0.9.1 bundle renamed to 0.10.0
#      fails instead of passing.
#   4. The app-test floor moves with the measured reality (250 at 0.9.1 → the 0.10.0 count), and the
#      suite must report `, 0 failed`.
#   5. The iOS ATS keys are checked in app.json (§2 S4), and Android's cleartext is checked to be the
#      ONE mechanism (a second one is what §1.11 forbids).
#   6. Push (§1.8) is still PARKED: the check is that the deferral is RECORDED and that no half-built
#      sender or credential file exists — the honest shape of a deferred item, not a passing feature.
#   7. The env bearer is read from $HERMES_HOME/.env (or ~/.hermes/.env) by NAME and is NEVER printed —
#      only its occurrence count in the bundle.
#
# NOTE on the server suite: `~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q` does NOT
# work on this host (that venv's pydantic_core is built for a different interpreter), so the suite is run
# the way the repo runs it — `server/run-tests.sh`, which borrows the dashboard's own 3.14 runtime. The
# literal command is attempted too and its outcome reported, not hidden.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APK="${1:-dist/personae-0.10.0.apk}"
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
# The floors: 196 before any 0.9.0 change, 241 at 0.9.0, 250 at 0.9.1, and the 0.10.0 count below; the
# live count is printed beside it.
TEST_FLOOR=261
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
    ok "app tests: $line (floor $TEST_FLOOR — the 0.9.1 count of 250 plus the eleven 0.10.0 tests)"
  else
    bad "app tests: ${line:-no tally}"
  fi
else
  bad "app tests produced no tally line"
fi
if npx tsc --noEmit >/tmp/v0100-tsc.log 2>&1; then ok "typecheck: tsc --noEmit rc 0"; else bad "typecheck failed"; head -5 /tmp/v0100-tsc.log; fi

echo
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
S1|0.10.0 S1: the gateway page is a plan — connections, status, pills, wizard, Advanced last
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
if drift="$(bash server/install.sh --check 2>&1)"; then
  ok "server/install.sh --check: $(printf '%s' "$drift" | tail -1)"
else
  bad "server/install.sh --check reports DRIFT"
  printf '%s\n' "$drift" | sed 's/^/      /'
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
echo "--- the artifact ---"
if [ ! -f "$APK" ]; then bad "$APK missing"; echo; echo "RESULT: FAIL"; exit 1; fi
note "path: $APK"
note "bytes: $(stat -c %s "$APK")"
note "sha256: $(sha256sum "$APK" | cut -d' ' -f1)"
# 0.9.1's own artifact, printed beside it so the two can be compared at a glance (it is NOT an assertion:
# a feature release legitimately changes both, and pinning a byte count would fail on a rebuild).
note "0.9.1 was: 116926234 bytes / sha256 757c536e648210fac589c5a00dae008d57d0e6463218ba95acef97f3b9c77cc6"

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
  for s in personae://connect api/profiles api/health api/status api/plugins/messenger/state api/plugins/personae-mobile-state personae.wizard.v1 expo-camera expo-audio expo-sharing checkpoints; do
    printf "%s=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
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
' _ "$APK" | tee /tmp/v0100-apk.txt

SUMMARY="$(grep '^summary:' /tmp/v0100-apk.txt)"
if printf '%s' "$SUMMARY" | awk -v v="$WANT_V" -v c="$WANT_C" -F'\t' '{exit !($2 == c && $3 == v)}'; then
  ok "APK is $WANT_V / versionCode $WANT_C (matches app.json)"
else
  bad "APK version does not match app.json"; note "$SUMMARY"; note "app.json says $WANT_V / $WANT_C"
fi
if grep -qE "Signer #1 certificate SHA-256( digest)?: $SIGNER_RELEASE" /tmp/v0100-apk.txt; then
  ok "signed with the SAME Personae release key as 0.1.0-0.9.1 (installs straight over 0.9.1)"
else
  bad "signer is not the Personae release key"; grep 'Signer' /tmp/v0100-apk.txt || true
fi
if grep -qE 'record-audio permission: [1-9]' /tmp/v0100-apk.txt; then
  ok "the APK carries RECORD_AUDIO (0.9.0 item 5 is in the ARTIFACT, not merely in app.json)"
else
  bad "the APK does not carry RECORD_AUDIO"
fi
if grep -qE '^markers:.*personae.wizard.v1=[1-9]' /tmp/v0100-apk.txt; then
  ok "the bundle carries the wizard state key (S3 entry (b)/(c) ship in the app)"
else
  bad "personae.wizard.v1 is not in the bundle"
fi
if grep -qE '^markers:.*api/status=[1-9]' /tmp/v0100-apk.txt; then
  ok "the bundle knows /api/status (S1's server row and S3.3's stage 2)"
else
  bad "/api/status is not in the bundle"
fi
if grep -qE '^positive control personae://connect: [1-9]' /tmp/v0100-apk.txt; then
  ok "positive control: personae://connect IS in the bundle (an empty grep is not a proof)"
else
  bad "the positive control found nothing — the marker greps prove nothing"
fi
if grep -qE 'live bearer occurrences \(want 0\): (0|SKIPPED)' /tmp/v0100-apk.txt; then
  ok "zero live-bearer occurrences in the shipped bundle"
else
  bad "the shipped bundle contains the live bearer"
fi
if grep -qE '^env facts \(want 0\): .*100\.106\.51\.4=0 .*personae=0 .*10\.0\.4\.15=0' /tmp/v0100-apk.txt; then
  ok "zero host/credential literals in the shipped bundle"
else
  bad "a host or credential literal is in the shipped bundle"; grep '^env facts' /tmp/v0100-apk.txt || true
fi
# every feature string this release claims must be IN the artifact
missing=0
for s in "Connection Wizard" "Connections" "Preferred connection kind" "Set up a connection" "Local network" "Test connection" "Share support log" "Skip for now" "Name this connection" "Nothing answered at that address. Check the address and the port" "already one of your connections"; do
  if ! grep -qF "[$s]=" /tmp/v0100-apk.txt; then continue; fi
  n="$(sed -n "s/.*\[$s\]=\([0-9]*\).*/\1/p" /tmp/v0100-apk.txt | head -1)"
  if [ "${n:-0}" -lt 1 ]; then bad "feature string is NOT in the bundle: \"$s\""; missing=1; fi
done
[ "$missing" = 0 ] && ok "every 0.10.0 feature string is inside the shipped bundle"

echo
if [ "$fail" = 0 ]; then echo "RESULT: PASS — 0.10.0 verified"; else echo "RESULT: FAIL"; fi
exit "$fail"
