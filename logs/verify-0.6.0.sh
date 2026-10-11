#!/usr/bin/env bash
# 0.6.0 — the whole release check in one command. Prints a PASS/FAIL line per check and exits
# non-zero if anything failed. Safe to re-run; changes nothing.
#
#   bash logs/verify-0.6.0.sh [path/to/personae-0.6.0.apk]
#
# Inside the container it runs the artifact forensics (apkanalyzer/apksigner/aapt2 live there), so the
# APK checks shell out to docker rather than being skipped. The live bearer is read from
# $HERMES_HOME/.env and is NEVER printed — only the count of its occurrences is.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APK="${1:-dist/personae-0.6.0.apk}"
IMAGE="${PERSONAE_IMAGE:-personae-android:1}"
ENV_FILE="${PERSONAE_ENV:-$HOME/.personae-android/build.env}"
# The Personae release key 0.1.0-0.5.0 shipped with: a 0.6.0 APK signed by anything else will not
# install over 0.5.0.  (logs/verify-0.5.0.txt)
SIGNER_050="bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26"
ENV_BEARER_FILE="${HERMES_HOME:-$HOME/.hermes}/.env"
# The bearer's documented source IS ENV_BEARER_FILE. Load it here: without this the leak check below
# degrades to SKIPPED and then reports a FAIL with the wrong reason ("the live bearer appears in the
# bundle") on any machine that has not exported LIVE_BEARER by hand. Never printed — only the count
# of its occurrences reaches the log.
if [ -z "${LIVE_BEARER:-}" ] && [ -r "$ENV_BEARER_FILE" ]; then
  LIVE_BEARER="$(sed -n 's/^HERMES_PERSONAE_BEARER=//p' "$ENV_BEARER_FILE" | head -1 | sed "s/^[\"']//; s/[\"']\$//")"
fi
export LIVE_BEARER
fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
note() { printf '      %s\n' "$1"; }

echo "=== 0.6.0 release check — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo

echo "--- app ---"
if out=$(npm test 2>&1 | tail -2); then
  line=$(printf '%s\n' "$out" | grep -E '^[0-9]+/[0-9]+ passed' | tail -1)
  n=${line%%/*}; n=${n//[!0-9]/}
  if [ "${n:-0}" -ge 132 ] && printf '%s' "$line" | grep -q ', 0 failed'; then
    ok "app tests: $line (floor 132)"
  else
    bad "app tests: ${line:-no tally line}"; note "$out"
  fi
fi
if npx tsc --noEmit >/tmp/verify-060-tsc.log 2>&1; then ok "typecheck: tsc --noEmit rc 0"; else bad "typecheck failed"; head -5 /tmp/verify-060-tsc.log; fi

echo
echo "--- server plugins ---"
if line=$(bash server/run-tests.sh tests 2>&1 | tail -1); then
  n=${line%% *}; n=${n//[!0-9]/}
  if [ "${n:-0}" -ge 43 ]; then ok "server tests: $line (floor 43)"; else bad "server tests: $line"; fi
else
  bad "server tests did not run"
fi
if bash server/install.sh --check >/tmp/verify-060-deploy.log 2>&1; then
  ok "deployed plugins match server/ (no drift)"
else
  bad "server/ and ~/.hermes/plugins/ have drifted"; note "$(head -5 /tmp/verify-060-deploy.log)"
fi
if [ "$(systemctl --user is-active hermes-serve.service)" = "active" ]; then ok "hermes-serve.service active"; else bad "hermes-serve.service not active"; fi

echo
echo "--- the app repo knows 0.6.0 ---"
if [ "$(node -p "require('./app.json').expo.version")" = "0.6.0" ] && [ "$(node -p "require('./app.json').expo.android.versionCode")" = "6" ]; then
  ok "app.json: 0.6.0 / versionCode 6"
else
  bad "app.json is not 0.6.0 / versionCode 6"
fi
if grep -q '"personae"' app.json; then ok "scheme personae declared"; else bad "scheme personae missing"; fi
if [ -f scripts/pair-harness.ts ] && [ -f src/sync/uiSync.ts ] && [ -f app/connect.tsx ]; then
  ok "0.6.0 sources present (pairing client, sync client, connect wizard)"
else
  bad "a 0.6.0 source file is missing"
fi

echo
echo "--- the artifact ---"
if [ ! -f "$APK" ]; then
  bad "$APK missing"
  echo; echo "RESULT: FAIL"; exit 1
fi
note "path: $APK"
note "bytes: $(stat -c %s "$APK")"
note "sha256: $(sha256sum "$APK" | cut -d' ' -f1)"

# Everything below needs the Android tools, which live in the build image.
docker run --rm -e LIVE_BEARER -v "$ROOT:/work" -w /work "$IMAGE" bash -lc '
  set -u
  export PATH="$PATH:$ANDROID_HOME/build-tools/36.0.0"
  APK="$1"
  echo "summary: $(apkanalyzer apk summary "$APK")"
  echo "min-sdk: $(apkanalyzer manifest min-sdk "$APK")  target-sdk: $(apkanalyzer manifest target-sdk "$APK")"
  echo "cleartext: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -ci usesCleartextTraffic)"
  echo "camera permission: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -c "android.permission.CAMERA")"
  echo "deep-link scheme personae: $(aapt2 dump xmltree --file AndroidManifest.xml "$APK" 2>/dev/null | grep -c "personae")"
  echo "ionicons packaged resource: $(aapt2 dump resources "$APK" 2>/dev/null | grep -io "ionicons[a-z_0-9]*" | sort -u | tr "\n" " ")"
  B=$(unzip -p "$APK" assets/index.android.bundle | wc -c)
  echo "bundle bytes: $B"
  printf "markers: "
  for s in personae.sections.v1 personae.colours.v1 personae.sync.meta.v1 api/plugins/messenger/state \
           api/plugins/personae-mobile-auth pair/redeem personae://connect expo-camera ExpoCamera; do
    printf "%s=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
  echo
  printf "env facts (want 0): "
  for s in 100.64.0.11 personae 10.0.0.15 API_SERVER_KEY=; do
    printf "%s=%s " "$s" "$(unzip -p "$APK" assets/index.android.bundle | grep -ac "$s")"
  done
  echo
  # Positive control: the same pipeline must find a string that IS in the bundle, otherwise a 0 on the
  # bearer line means "grep is broken", not "no leak".
  echo "positive control personae://connect: $(unzip -p "$APK" assets/index.android.bundle | grep -ac "personae://connect")"
  printf "live bearer occurrences (want 0): "
  if [ -n "${LIVE_BEARER:-}" ]; then
    unzip -p "$APK" assets/index.android.bundle | grep -ac "${LIVE_BEARER}" || true
  else
    echo "SKIPPED (no LIVE_BEARER in the environment)"
  fi
  apksigner verify --print-certs "$APK" 2>/dev/null | grep -E "Signer #1 certificate (DN|SHA-256)"
' _ "$APK" | tee /tmp/verify-060-apk.txt

if awk -F'\t' '$1 ~ /^summary:/ && $2 == 6 && $3 == "0.6.0" {found=1} END {exit !found}' /tmp/verify-060-apk.txt; then
  ok "APK is 0.6.0 / versionCode 6"
else
  bad "APK version does not read 0.6.0 / versionCode 6"; note "$(grep summary: /tmp/verify-060-apk.txt)"
fi
if grep -qE "Signer #1 certificate SHA-256( digest)?: $SIGNER_050" /tmp/verify-060-apk.txt; then
  ok "signed with the SAME Personae release key as 0.5.0 (installs over it)"
else
  bad "signer differs from 0.5.0"; note "$(grep -i 'certificate SHA-256' /tmp/verify-060-apk.txt)"
fi
if ! grep -qE 'positive control personae://connect: [1-9]' /tmp/verify-060-apk.txt; then
  bad "the bundle probe itself is broken — the positive control found nothing"
elif grep -q 'want 0): SKIPPED' /tmp/verify-060-apk.txt; then
  bad "live bearer leak check could not run: no LIVE_BEARER and no HERMES_PERSONAE_BEARER in $ENV_BEARER_FILE"
elif grep -qE 'live bearer occurrences \(want 0\): 0' /tmp/verify-060-apk.txt; then
  ok "live bearer occurrences in the shipped bundle: 0"
else
  bad "the live bearer appears in the shipped bundle"
fi

echo
echo "--- the bundle speaks 0.6.0 ---"
for probe in 'api/plugins/personae-mobile-auth=[1-9]' 'pair/redeem=[1-9]' 'personae://connect=[1-9]' 'api/plugins/messenger/state=[1-9]' 'expo-camera=[1-9]'; do
  key=${probe%%=*}
  if grep -qE "$probe" /tmp/verify-060-apk.txt; then ok "bundle marker $key"; else bad "bundle marker $key missing"; fi
done

echo
if [ "$fail" = 0 ]; then echo "RESULT: PASS — 0.6.0 verified"; else echo "RESULT: FAIL"; fi
exit "$fail"
