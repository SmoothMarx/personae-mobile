#!/usr/bin/env bash
# 0.9.1 — the whole release check in one command. Prints a PASS/FAIL line per check, exits non-zero on
# any failure. Safe to re-run; changes nothing (it only reads the APK, runs the suites, and asks the
# live dashboard the questions 0.9.1's items depend on).
#
#   bash logs/verify-0.9.1.sh [path/to/personae-0.9.1.apk]
#
# What is different from verify-0.9.0.sh, and why:
#   0. **S0 is checked against the HOST, not against prose.** 0.9.0's PROGRESS section claimed Phase A's
#      plugin was deployed; on 2026-10-13 `server/install.sh --check` reported all five files of
#      `personae-mobile-state` MISSING — it had never been installed. This verifier therefore runs
#      `server/install.sh --check` itself and fails on drift, and asserts the five deployed files exist
#      under $HERMES_PLUGIN_DIR/personae-mobile-state/. A future run cannot make that claim without it.
#   1. The four §2 items of 0.9.1 each have a test that NAMES them (`0.9.1 S<n>: …`), and the list below
#      is the contract — a missing name is a FAIL.
#   2. The expected version is still DERIVED FROM app.json (never hardcoded), and the APK is checked
#      for the 0.9.0 FEATURES inside the bundle: the pill search bar's height, the session-group and
#      selection copy, the attachment/voice copy, the landscape orientation and the RECORD_AUDIO
#      permission. A 0.8.0 bundle renamed to 0.9.0 fails instead of passing. 0.9.1's own strings join
#      that list (the four display-session-type labels, the advanced page's new home).
#   3. The app-test floor moves with the measured reality (196 before any 0.9.0 change → 241 at 0.9.0
#      → the 0.9.1 count), and the suite must report `, 0 failed`.
#   4. The server floor moves too (60 → 75 at 0.9.0): 0.9.0 Phase A adds a whole plugin, and its 15
#      tests are part of the release.
#   5. Every §4 item has a test that NAMES it; the list below is the contract, and a missing name is a
#      FAIL — a phase whose test does not exist is a phase that did not happen.
#   6. Push (§4 item 12) is PARKED by the user's own instruction (2026-10-12). The check is therefore
#      that the deferral is RECORDED and that no half-built sender or credential file exists — the
#      honest shape of a deferred item, not a passing feature.
#   7. The env bearer is read from $HERMES_HOME/.env (or ~/.hermes/.env) by NAME and is NEVER printed —
#      only its occurrence count in the bundle.
#
# NOTE on the server suite: `~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q` does NOT
# work on this host (that venv's pydantic_core is built for a different interpreter), so the suite is
# run the way the repo runs it — `server/run-tests.sh`, which borrows the dashboard's own 3.14
# runtime. The literal command is attempted too and its outcome reported, not hidden.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APK="${1:-dist/personae-0.9.1.apk}"
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
# The floors: 196 before any 0.9.0 change, 241 at 0.9.0, 250 at 0.9.1 (the ten 0.9.1 tests joined the
# suite); the live count is printed beside it.
TEST_FLOOR=250
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
    ok "app tests: $line (floor $TEST_FLOOR — the 0.9.0 count of 241 plus the ten 0.9.1 tests)"
  else
    bad "app tests: ${line:-no tally}"
  fi
else
  bad "app tests produced no tally line"
fi
if npx tsc --noEmit >/tmp/v091-tsc.log 2>&1; then ok "typecheck: tsc --noEmit rc 0"; else bad "typecheck failed"; head -5 /tmp/v091-tsc.log; fi

echo
echo "--- §4 items: each one has a test that names it ---"
for spec in \
  "1|0.9.0 F: the search bar is 25% taller and rounded at the side, both DERIVED" \
  "2|0.9.0 F: the routine connection strip is gone; the FAILURE disclosure stays" \
  "3|0.9.0 F: the trailing \"51 automatic…\" line is gone and the honesty line is not" \
  "4|0.9.0 G: the staging strip stages, sizes, and removes ONE item at a time" \
  "4|0.9.0 G: the phone SENDS the bytes to the session before it submits the turn" \
  "4|0.9.0 G: a message that CARRIED something reads back as attachments plus a caption" \
  "4|0.9.0 G: what the RPC carries is the base64 PAYLOAD, never the whole data URL" \
  "4|0.9.0 G: the legacy surface refuses the attach verbs WITH a reason, as it does for the rest" \
  "5|0.9.0 H: hold to record, slide left to cancel, release to stage" \
  "5|0.9.0 H: a note too short to be a message is refused, WITH the reason" \
  "5|0.9.0 H: a voice note LEAVES the phone as a file the agent on the box can read" \
  "5|0.9.0 H: \"receive\" covers BOTH meanings — the agent sending one, and the phone playing it" \
  "5|0.9.0 H: the ONE new dependency is expo-audio, from the SDK, and the mic is declared" \
  "6|0.9.0 D: the session menu is the desktop shape — flat verbs plus one-noun submenus" \
  "6|0.9.0 D: every verb the phone cannot run carries a REASON, and none is silently absent" \
  "6|0.9.0 D: the sheet DRILLS INTO a submenu and back, and a submenu opener is not a verb" \
  "7|0.9.0 E: holding a row ticks it IMMEDIATELY and opens the mode (the WhatsApp model)" \
  "7|0.9.0 E: emptying the set leaves the mode (the user, 2026-10-10)" \
  "7|0.9.0 E: the batch resolves against what is ON SCREEN, not the raw roster" \
  "7|0.9.0 E: ONE delete path, and the confirm carries the COUNT" \
  "7|0.9.0 E: batch verbs once more than one row is ticked; single-object when exactly one" \
  "8|0.9.0 F: the Expand/collapse-all button is gone from the top bar, the ability is not" \
  "9|0.9.0 F: the \"+\" and Settings are bigger and their background is transparent" \
  "10|0.9.0 F: the routine connection strip is gone; the FAILURE disclosure stays" \
  "11|0.9.0 F (landscape): the app rotates, and every screen honours the SIDE insets" \
  "11|0.9.0 F (landscape): the sheets use MORE of a short viewport, not less" \
  "11|0.9.0 F (landscape): the roster geometry is dp-based, so a wide short canvas does not break it" \
  "A|0.9.0 A: archive and delete ride the state verbs when the host mounts the plugin" \
  "A|0.9.0 A: a PINNED session is refused with a machine-readable code, never silently archived" \
  "A|0.9.0 A: without the plugin the same verbs FALL BACK to the dashboard verbs" \
  "A|0.9.0 A: the legacy surface ATTEMPTS the verb and reports it; the 501 stub is gone" \
  "A|0.9.0 A: the portable-preference document round-trips; a device-local key is refused" \
  "A|0.9.0 A: the state surface has exactly ONE prefix, written in exactly one file" \
  "B|0.9.0 B: Settings is a page of rows, and Notifications is a SIBLING of Agent Preferences" \
  "B|0.9.0 B: the portable/device-local split is visible, and matches the SERVER key list" \
  "B|0.9.0 B: promoting Settings to a page deleted nothing" \
  "C|0.9.0 C: the model is the desktop document, shape for shape" \
  "C|0.9.0 C: create, rename, file, unfile, collapse, move — and delete NEVER deletes a session" \
  "C|0.9.0 C: no groups at all renders exactly the flat list it always was" \
  "C|0.9.0 C: the phone syncs the same key the desktop writes, through the same merge" \
  "C|0.9.0 C: the heading is its own row kind, and GROUP is not SECTION" \
  "C|0.9.0 C: a 0.8.0 install has no groups key and loads as \"no groups\"" \
  "I|0.9.0 I: what syncs is an ALLOWLIST, and a gateway address can never be in it" \
  "I|0.9.0 I: the server is the source of truth, and a stale revision is never a clobber" \
  "I|0.9.0 I: only a GENUINE difference is pushed, so an applied value cannot echo back" \
  "I|0.9.0 I: the phone writes through the document the desktop pane reads" ; do
  item="${spec%%|*}"; name="${spec#*|}"
  if grep -qF "$name" tests/run.ts; then ok "item $item: test present — \"$name\""; else bad "item $item: test MISSING — \"$name\""; fi
done

echo
echo "--- 0.9.1 §2 items: each one has a test that NAMES it (\`0.9.1 S<n>: …\`) ---"
# A heredoc, not a backslash-continued list: several of these names contain double quotes (they quote
# the user's own words), and escaping them inside `"item|name"` strings is how a name silently stops
# matching. A quoted heredoc passes every character through literally.
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
# S0 is deliberately NOT in that list, and the brief says why: "this item's proof is not a test". Its
# evidence is the `install.sh --check` block ABOVE (the five deployed files and the config line), plus the
# 0.9.0 correction it forced. So the check here is that the run SAYS so rather than inventing a test name.
if grep -qF "its proof is a command, not a test" PROGRESS.md; then
  ok "S0 is recorded with the reason its proof is a command and not a test (the brief's own rule)"
else
  bad "S0 does not say why it has no named test"
fi

echo
echo "--- §4 item 12 (push): PARKED by the user, and recorded as parked ---"
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
if ~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q >/tmp/v091-pytest.log 2>&1; then
  note "the literal venv-pytest command also works here"
else
  note "literal '~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q' fails on this host"
  note "  ($(grep -m1 -E 'ModuleNotFoundError|ImportError|errors during collection' /tmp/v091-pytest.log | cut -c1-90)); server/run-tests.sh is the runner of record"
fi
[ "$(systemctl --user is-active hermes-serve.service)" = "active" ] && ok "hermes-serve.service active (never restarted by this run)" || bad "hermes-serve.service not active"

# ── S0: the deployment 0.9.0 CLAIMED and never performed ─────────────────────────────────────────────
# 0.9.0's PROGRESS section said Phase A's plugin was deployed. On 2026-10-13 `--check` said all five files
# were missing. This block is the reason a future run cannot repeat that claim without doing the work.
echo
echo "--- S0: the state plugin is really deployed, not merely documented (measured, not asserted) ---"
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
# its plugins from. $HERMES_HOME is a different thing: it is the ACTIVE PROFILE's home, and in the agent's
# own CLI session it points at `~/.hermes/profiles/<agent>/`. Reading the config through $HERMES_HOME
# would check a file the dashboard never loads and would report "not enabled" for a plugin that is
# enabled — which is exactly the class of mistake S0 exists to stop.

echo
echo "--- the live dashboard answers what 0.9.0 needs ---"
note "credential read from $ENV_BEARER_FILE (the value is never printed; only the file name is)"
if [ -n "${LIVE_BEARER:-}" ]; then
  body="$(curl -sS -m 20 --oauth2-bearer "$LIVE_BEARER" "$DASH/api/profiles/sessions/sidebar?recents_limit=60&cron_limit=10" 2>/dev/null)"
  if printf '%s' "$body" | grep -q '"recents"'; then
    ok "GET /api/profiles/sessions/sidebar → the batched slices the roster still rides"
    if printf '%s' "$body" | grep -q '"archived"\(,\|\s*\)' || printf '%s' "$body" | grep -q '"archived"'; then
      ok "the surface serves 'archived' → Phase A's archive verb has a real flag to write"
    else
      note "no 'archived' on this surface — the archive verb still routes, the flag is simply not echoed"
    fi
  else
    bad "GET /api/profiles/sessions/sidebar did not answer the expected shape"
  fi
  if curl -sS -m 8 --oauth2-bearer "$LIVE_BEARER" "$DASH/pair" 2>/dev/null | grep -q 'Autorizar Personae Mobile'; then
    ok "/pair still renders (the pairing page survived the 0.9.0 build)"
  else
    bad "/pair no longer renders"
  fi
  # Phase A's plugin is deployed but DORMANT until the dashboard restarts (SERVER-PATCH.md, and
  # rule §3 forbids restarting it from here). Report which of the two states it is in, honestly.
  if curl -sS -m 8 --oauth2-bearer "$LIVE_BEARER" "$DASH/api/plugins/personae-mobile-state/health" 2>/dev/null | grep -q '"ok":true'; then
    ok "personae-mobile-state is MOUNTED: /health answers (the dashboard has restarted into it)"
    if curl -sS -m 8 --oauth2-bearer "$LIVE_BEARER" "$DASH/api/plugins/personae-mobile-state/preferences/keys" 2>/dev/null | grep -q 'session-types'; then
      ok "GET /preferences/keys publishes the portable/device-local split"
    else
      bad "the preferences route did not publish the split"
    fi
  else
    note "personae-mobile-state is DORMANT (404): deployed, not yet mounted — hermes-serve has not"
    note "  restarted, which rule §3 forbids this run from forcing. The app is unaffected: its probe"
    note "  records 'unavailable' and archive/delete fall back to the dashboard's own verbs."
  fi
else
  bad "no LIVE_BEARER (HERMES_PERSONAE_BEARER not found in $ENV_BEARER_FILE) — the live checks cannot run"
fi

echo
echo "--- app.json declares the release ---"
[ -n "$WANT_V" ] && [ -n "$WANT_C" ] && ok "app.json: $WANT_V / versionCode $WANT_C" || bad "app.json version unreadable"
if node -p "require('./app.json').expo.orientation" 2>/dev/null | grep -q '^default$'; then
  ok "app.json allows BOTH orientations (item 11: the app rotates)"
else
  bad "app.json is still portrait-only"
fi
if node -p "require('./app.json').expo.android.permissions.includes('android.permission.RECORD_AUDIO')" 2>/dev/null | grep -q true; then
  ok "app.json declares RECORD_AUDIO (item 5: voice notes)"
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
  ok "the recorder is expo-audio, NOT expo-av (item 5's one new dependency)"
else
  bad "expo-av was added — the wrong media package for this SDK"
fi

echo
echo "--- the artifact ---"
if [ ! -f "$APK" ]; then bad "$APK missing"; echo; echo "RESULT: FAIL"; exit 1; fi
note "path: $APK"
note "bytes: $(stat -c %s "$APK")"
note "sha256: $(sha256sum "$APK" | cut -d' ' -f1)"
# 0.9.0's own artifact, printed beside it so the two can be compared at a glance (it is NOT an assertion:
# a corrections release legitimately changes both, and pinning a byte count would fail on a rebuild).
note "0.9.0 was: 117547098 bytes / sha256 047da9e25092510bebbc606330586de528190b8ca07ad0d2a18cd75a51f5a131"

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
  for s in personae://connect api/profiles api/plugins/messenger/state api/plugins/personae-mobile-state expo-camera expo-audio checkpoints; do
    printf "%s=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
  echo
  echo "application-id: $(apkanalyzer manifest application-id "$APK")"
  printf "0.9.1 feature strings (want >=1 each): ": 
  while IFS= read -r s; do printf "[%s]=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"; done <<'"'"'STRINGS'"'"'
session-groups-v1
Select all
This cannot be undone
Hold to record a voice note
Slide left to cancel
image.attach_bytes
file.attach
Add an attachment
Agent Preferences
This phone only
Display session types
One-shots
Webhooks
Advanced lives inside this page
STRINGS
  echo
  printf "env facts (want 0): "
  for s in 100.64.0.11 personae 10.0.0.15 API_SERVER_KEY=; do
    printf "%s=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
  echo
  echo "positive control personae://connect: $(unzip -p "$APK" assets/index.android.bundle | grep -ac "personae://connect")"
  printf "live bearer occurrences (want 0): "
  if [ -n "${LIVE_BEARER:-}" ]; then unzip -p "$APK" assets/index.android.bundle | grep -ac "${LIVE_BEARER}" || true; else echo "SKIPPED"; fi
  apksigner verify --print-certs "$APK" 2>/dev/null | grep -E "Signer #1 certificate (DN|SHA-256)"
' _ "$APK" | tee /tmp/v091-apk.txt

SUMMARY="$(grep '^summary:' /tmp/v091-apk.txt)"
if printf '%s' "$SUMMARY" | awk -v v="$WANT_V" -v c="$WANT_C" -F'\t' '{exit !($2 == c && $3 == v)}'; then
  ok "APK is $WANT_V / versionCode $WANT_C (matches app.json)"
else
  bad "APK version does not match app.json"; note "$SUMMARY"; note "app.json says $WANT_V / $WANT_C"
fi
if grep -qE "Signer #1 certificate SHA-256( digest)?: $SIGNER_RELEASE" /tmp/v091-apk.txt; then
  ok "signed with the SAME Personae release key as 0.1.0-0.8.0 (installs straight over 0.8.0)"
else
  bad "signer is not the Personae release key"; grep 'Signer' /tmp/v091-apk.txt || true
fi
if grep -qE 'record-audio permission: [1-9]' /tmp/v091-apk.txt; then
  ok "the APK carries RECORD_AUDIO (item 5 is in the ARTIFACT, not merely in app.json)"
else
  bad "the APK does not carry RECORD_AUDIO"
fi
if grep -qE '^markers:.*api/plugins/personae-mobile-state=[1-9]' /tmp/v091-apk.txt; then
  ok "the bundle knows the state surface's prefix (Phase A/I ship in the app)"
else
  bad "the state surface prefix is not in the bundle"
fi
if grep -qE '^positive control personae://connect: [1-9]' /tmp/v091-apk.txt; then
  ok "positive control: personae://connect IS in the bundle (an empty grep is not a proof)"
else
  bad "the positive control found nothing — the marker greps prove nothing"
fi
if grep -qE 'live bearer occurrences \(want 0\): (0|SKIPPED)' /tmp/v091-apk.txt; then
  ok "zero live-bearer occurrences in the shipped bundle"
else
  bad "the shipped bundle contains the live bearer"
fi
if grep -qE '^env facts \(want 0\): .*100\.106\.51\.4=0 .*personae=0' /tmp/v091-apk.txt; then
  ok "zero host/credential literals in the shipped bundle"
else
  bad "a host or credential literal is in the shipped bundle"; grep '^env facts' /tmp/v091-apk.txt || true
fi
# every 0.9.0 feature string the release claims must be IN the artifact
missing=0
for s in session-groups-v1 "Select all" "This cannot be undone" "Hold to record a voice note" "image.attach_bytes" "Add an attachment" "Agent Preferences" "Display session types" "One-shots" "Webhooks" "Advanced lives inside this page"; do
  if ! grep -qF "[$s]=" /tmp/v091-apk.txt; then continue; fi
  n="$(sed -n "s/.*\[$s\]=\([0-9]*\).*/\1/p" /tmp/v091-apk.txt | head -1)"
  if [ "${n:-0}" -lt 1 ]; then bad "feature string is NOT in the bundle: \"$s\""; missing=1; fi
done
[ "$missing" = 0 ] && ok "every 0.9.0 AND 0.9.1 feature string is inside the shipped bundle"

echo
if [ "$fail" = 0 ]; then echo "RESULT: PASS — 0.9.1 verified"; else echo "RESULT: FAIL"; fi
exit "$fail"
