#!/usr/bin/env bash
# 0.7.0 — the whole release check in one command. Prints a PASS/FAIL line per check, exits non-zero on
# any failure. Safe to re-run; changes nothing (it only reads the APK, runs the suites, and asks the
# live dashboard two questions).
#
#   bash logs/verify-0.7.0.sh [path/to/personae-0.7.0.apk]
#
# What is different from verify-0.6.1.sh, and why:
#   1. The expected version is still DERIVED FROM app.json (never hardcoded), and the APK is now also
#      checked for the 0.7.0 FEATURES inside the bundle — the tailnet peer route, the profile-create
#      route and the deep link — so a stale 0.6.1 bundle under a 0.7.0 name fails instead of passing.
#   2. The live checks ask the deployed plugin for the new endpoint (GET /tailscale/peers, 1.2.0) and
#      for the /pair page, because 0.7.0's device picker is only real if the host answers it.
#   3. The env bearer is read from $HERMES_HOME/.env by NAME and is NEVER printed — only its
#      occurrence count in the bundle.
#
# NOTE on the server suite: `~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q` does NOT
# work on this host (that venv's pydantic_core is built for a different interpreter), so the suite is
# run the way the repo runs it — `server/run-tests.sh`, which borrows the dashboard's own 3.14
# runtime. The literal command is attempted too and its outcome reported, not hidden.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APK="${1:-dist/personae-0.7.0.apk}"
IMAGE="${PERSONAE_IMAGE:-personae-android:1}"
SIGNER_RELEASE="bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26"
# The bearer lives in the dashboard's own env file. `$HERMES_HOME` is the documented home, but a
# shell that runs under a named profile points it at the profile dir (e.g. ~/.hermes/profiles/cody),
# which has no bearer — so fall back to `$HOME/.hermes/.env` and SAY which file was read. Only the
# path is ever printed.
ENV_BEARER_FILE="${HERMES_HOME:-$HOME/.hermes}/.env"
if ! grep -q '^HERMES_PERSONAE_BEARER=' "$ENV_BEARER_FILE" 2>/dev/null && [ -r "$HOME/.hermes/.env" ]; then
  ENV_BEARER_FILE="$HOME/.hermes/.env"
fi
if [ -z "${LIVE_BEARER:-}" ] && [ -r "$ENV_BEARER_FILE" ]; then
  LIVE_BEARER="$(sed -n 's/^HERMES_PERSONAE_BEARER=//p' "$ENV_BEARER_FILE" | head -1 | sed "s/^[\"']//; s/[\"']\$//")"
fi
export LIVE_BEARER

WANT_V="$(node -p "require('./app.json').expo.version" 2>/dev/null)"
WANT_C="$(node -p "require('./app.json').expo.android.versionCode" 2>/dev/null)"
DASH="http://127.0.0.1:9119"
fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
note() { printf '      %s\n' "$1"; }

echo "=== ${WANT_V} release check — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo

echo "--- app ---"
if line=$(npm test 2>&1 | tail -2 | grep -E '^[0-9]+/[0-9]+ passed' | tail -1); then
  n=${line%%/*}; n=${n//[!0-9]/}
  if [ "${n:-0}" -ge 145 ] && printf '%s' "$line" | grep -q ', 0 failed'; then ok "app tests: $line (floor 145)"; else bad "app tests: ${line:-no tally}"; fi
else
  bad "app tests produced no tally line"
fi
if npx tsc --noEmit >/tmp/v070-tsc.log 2>&1; then ok "typecheck: tsc --noEmit rc 0"; else bad "typecheck failed"; head -5 /tmp/v070-tsc.log; fi

echo
echo "--- server plugins ---"
if line=$(bash server/run-tests.sh tests 2>&1 | tail -1); then
  n=${line%% *}; n=${n//[!0-9]/}
  if [ "${n:-0}" -ge 43 ]; then ok "server tests: $line (floor 43)"; else bad "server tests: $line"; fi
else
  bad "server tests did not run"
fi
if ~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q >/tmp/v070-pytest.log 2>&1; then
  note "the literal venv-pytest command also works here"
else
  note "literal '~/.hermes/hermes-agent/venv/bin/python -m pytest server/tests -q' fails on this host"
  note "  ($(grep -m1 -E 'ModuleNotFoundError|ImportError' /tmp/v070-pytest.log | cut -c1-90)); server/run-tests.sh is the runner of record"
fi
if bash server/install.sh --check >/tmp/v070-deploy.log 2>&1; then ok "deployed plugins match server/ (no drift)"; else bad "server/ and ~/.hermes/plugins/ have drifted"; fi
[ "$(systemctl --user is-active hermes-serve.service)" = "active" ] && ok "hermes-serve.service active" || bad "hermes-serve.service not active"

echo
echo "--- the live dashboard answers what 0.7.0 needs ---"
note "credential read from $ENV_BEARER_FILE (the value is never printed; only the file name is)"
if [ -n "${LIVE_BEARER:-}" ]; then
  # `--oauth2-bearer` rather than a literal header: this file is written by tooling that redacts
  # the `Authorization: <scheme>` pattern, and a redacted verifier would silently test nothing.
  peers="$(curl -sS -m 8 --oauth2-bearer "$LIVE_BEARER" "$DASH/api/plugins/personae-mobile-auth/tailscale/peers" 2>/dev/null)"
  if printf '%s' "$peers" | grep -q '"available":true'; then
    ok "GET /tailscale/peers (plugin 1.2.0) → available:true, $(printf '%s' "$peers" | grep -o '"ip"' | wc -l) ipv4 entries"
  elif printf '%s' "$peers" | grep -q '"available":false'; then
    note "GET /tailscale/peers answered the unavailable shape ($(printf '%s' "$peers" | cut -c1-80))"
    note "  that shape is a PASS for the app (manual entry under Advanced), but it means no picker today"
  else
    bad "GET /tailscale/peers did not answer as documented"
  fi
  if curl -sS -m 8 --oauth2-bearer "$LIVE_BEARER" "$DASH/pair" 2>/dev/null | grep -q 'Autorizar Personae Mobile'; then
    ok "/pair still renders (the pairing page survived the 1.2.0 deploy)"
  else
    bad "/pair no longer renders"
  fi
  code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --oauth2-bearer "$LIVE_BEARER" -d '{}' "$DASH/api/profiles" 2>/dev/null)"
  if [ "$code" = "422" ] || [ "$code" = "200" ]; then
    ok "POST /api/profiles is reachable with the owner credential (HTTP $code; 422 = the empty body was refused before any profile was written)"
  else
    bad "POST /api/profiles answered HTTP $code to the owner credential"
  fi
else
  bad "no LIVE_BEARER (HERMES_PERSONAE_BEARER not found in $ENV_BEARER_FILE) — the live checks cannot run"
fi

echo
echo "--- app.json declares the release ---"
[ -n "$WANT_V" ] && [ -n "$WANT_C" ] && ok "app.json: $WANT_V / versionCode $WANT_C" || bad "app.json version unreadable"

echo
echo "--- the artifact ---"
if [ ! -f "$APK" ]; then bad "$APK missing"; echo; echo "RESULT: FAIL"; exit 1; fi
note "path: $APK"
note "bytes: $(stat -c %s "$APK")"
note "sha256: $(sha256sum "$APK" | cut -d' ' -f1)"

docker run --rm -e LIVE_BEARER -v "$ROOT:/work" -w /work "$IMAGE" bash -lc '
  set -u
  export PATH="$PATH:$ANDROID_HOME/build-tools/36.0.0"
  APK="$1"
  echo "summary: $(apkanalyzer apk summary "$APK")"
  echo "min-sdk: $(apkanalyzer manifest min-sdk "$APK")  target-sdk: $(apkanalyzer manifest target-sdk "$APK")"
  echo "camera permission: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -c "android.permission.CAMERA")"
  echo "deep-link scheme personae: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -c "personae")"
  printf "markers: "
  for s in personae://connect tailscale/peers api/profiles pair/redeem api/plugins/messenger/state expo-camera; do
    printf "%s=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
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
' _ "$APK" | tee /tmp/v070-apk.txt

SUMMARY="$(grep '^summary:' /tmp/v070-apk.txt)"
if printf '%s' "$SUMMARY" | awk -v v="$WANT_V" -v c="$WANT_C" -F'\t' '{exit !($2 == c && $3 == v)}'; then
  ok "APK is $WANT_V / versionCode $WANT_C (matches app.json)"
else
  bad "APK version does not match app.json"; note "$SUMMARY"; note "app.json says $WANT_V / $WANT_C"
fi
if grep -qE "Signer #1 certificate SHA-256( digest)?: $SIGNER_RELEASE" /tmp/v070-apk.txt; then
  ok "signed with the SAME Personae release key as 0.1.0-0.6.1 (installs over 0.6.1)"
else
  bad "signer differs from the shipped key"; note "$(grep -i 'certificate SHA-256' /tmp/v070-apk.txt)"
fi
[ "$(grep -E '^camera permission: [1-9]' /tmp/v070-apk.txt | wc -l)" = 1 ] && ok "CAMERA permission present" || bad "CAMERA permission missing"
[ "$(grep -E '^deep-link scheme personae: [1-9]' /tmp/v070-apk.txt | wc -l)" = 1 ] && ok "personae:// deep link present in the manifest" || bad "deep link missing from the manifest"
if ! grep -qE 'positive control personae://connect: [1-9]' /tmp/v070-apk.txt; then
  bad "the bundle probe itself is broken — the positive control found nothing"
elif grep -qE '^markers: .*tailscale/peers=0' /tmp/v070-apk.txt; then
  bad "the bundle does not carry the 0.7.0 tailnet peer route — this is not a 0.7.0 build"
elif grep -qE '^markers: .*api/profiles=0' /tmp/v070-apk.txt; then
  bad "the bundle does not carry the profile-create route"
elif grep -q 'want 0): SKIPPED' /tmp/v070-apk.txt; then
  bad "live bearer leak check could not run (no LIVE_BEARER / HERMES_PERSONAE_BEARER)"
elif grep -qE 'live bearer occurrences \(want 0\): 0' /tmp/v070-apk.txt; then
  ok "live bearer occurrences in the shipped bundle: 0"
else
  bad "the live bearer appears in the shipped bundle"
fi
if grep -qE '^env facts \(want 0\): 100\.106\.51\.4=0 personae=0 10\.0\.4\.15=0 API_SERVER_KEY==0' /tmp/v070-apk.txt; then
  ok "no host address, user name or key literal in the shipped bundle"
else
  bad "an environment fact leaked into the shipped bundle"; grep '^env facts' /tmp/v070-apk.txt
fi

echo
if [ "$fail" = 0 ]; then echo "RESULT: PASS — ${WANT_V} verified"; else echo "RESULT: FAIL"; fi
exit "$fail"
