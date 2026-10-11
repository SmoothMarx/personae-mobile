#!/usr/bin/env bash
# 0.6.1 — the whole release check in one command. Prints a PASS/FAIL line per check, exits non-zero on
# any failure. Safe to re-run; changes nothing.
#
#   bash logs/verify-0.6.1.sh [path/to/personae-0.6.1.apk]
#
# Differences from verify-0.6.0.sh, both deliberate:
#   1. The expected version is DERIVED FROM app.json, not hardcoded. A hardcoded "0.6.0" would happily
#      pass a stale artifact — the check must fail when app.json and the APK disagree.
#   2. Branding is checked for real: the launcher art and the splash are located inside the APK by
#      comparing every packaged bitmap against assets/icon.png, instead of trusting that prebuild ran.
# The live bearer is read from $HERMES_HOME/.env and is NEVER printed — only its occurrence count is.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
APK="${1:-dist/personae-0.6.1.apk}"
IMAGE="${PERSONAE_IMAGE:-personae-android:1}"
SIGNER_050="bd40e00544d6249c90419ac05736c5b988221ab43b2eecf093978ccf6dd37f26"
ENV_BEARER_FILE="${HERMES_HOME:-$HOME/.hermes}/.env"
if [ -z "${LIVE_BEARER:-}" ] && [ -r "$ENV_BEARER_FILE" ]; then
  LIVE_BEARER="$(sed -n 's/^HERMES_PERSONAE_BEARER=//p' "$ENV_BEARER_FILE" | head -1 | sed "s/^[\"']//; s/[\"']\$//")"
fi
export LIVE_BEARER

WANT_V="$(node -p "require('./app.json').expo.version" 2>/dev/null)"
WANT_C="$(node -p "require('./app.json').expo.android.versionCode" 2>/dev/null)"
fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
note() { printf '      %s\n' "$1"; }

echo "=== ${WANT_V} release check — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo

echo "--- app ---"
if line=$(npm test 2>&1 | tail -2 | grep -E '^[0-9]+/[0-9]+ passed' | tail -1); then
  n=${line%%/*}; n=${n//[!0-9]/}
  if [ "${n:-0}" -ge 132 ] && printf '%s' "$line" | grep -q ', 0 failed'; then ok "app tests: $line (floor 132)"; else bad "app tests: ${line:-no tally}"; fi
else
  bad "app tests produced no tally line"
fi
if npx tsc --noEmit >/tmp/v061-tsc.log 2>&1; then ok "typecheck: tsc --noEmit rc 0"; else bad "typecheck failed"; head -5 /tmp/v061-tsc.log; fi

echo
echo "--- server plugins ---"
if line=$(bash server/run-tests.sh tests 2>&1 | tail -1); then
  n=${line%% *}; n=${n//[!0-9]/}
  if [ "${n:-0}" -ge 43 ]; then ok "server tests: $line (floor 43)"; else bad "server tests: $line"; fi
else
  bad "server tests did not run"
fi
if bash server/install.sh --check >/tmp/v061-deploy.log 2>&1; then ok "deployed plugins match server/ (no drift)"; else bad "server/ and ~/.hermes/plugins/ have drifted"; fi
[ "$(systemctl --user is-active hermes-serve.service)" = "active" ] && ok "hermes-serve.service active" || bad "hermes-serve.service not active"

echo
echo "--- app.json declares the release and the brand ---"
[ -n "$WANT_V" ] && [ -n "$WANT_C" ] && ok "app.json: $WANT_V / versionCode $WANT_C" || bad "app.json version unreadable"
[ "$(node -p "require('./app.json').expo.icon" 2>/dev/null)" = "./assets/icon.png" ] && ok "icon -> assets/icon.png" || bad "app.json icon not wired"
[ "$(node -p "require('./app.json').expo.android.adaptiveIcon.foregroundImage" 2>/dev/null)" = "./assets/adaptive-icon.png" ] && ok "adaptiveIcon.foregroundImage wired" || bad "adaptive foreground not wired"
for f in assets/icon.png assets/adaptive-icon.png assets/splash/splashscreen_logo-xxxhdpi.png; do
  [ -f "$f" ] || bad "missing asset $f"
done
# the icon must be alpha-free: the App Store rejects an alpha channel on the 1024 icon
if [ -f assets/icon.png ] && ! identify -format '%[channels]' assets/icon.png | grep -q a; then
  ok "assets/icon.png has no alpha channel (App Store requirement)"
else
  bad "assets/icon.png carries an alpha channel"
fi

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
  echo "adaptive-icon xml entries: $(aapt2 dump resources "$APK" 2>/dev/null | grep -c "ic_launcher_foreground")"
  echo "splashscreen drawable entries: $(aapt2 dump resources "$APK" 2>/dev/null | grep -c "splashscreen_logo")"
  printf "markers: "
  for s in personae://connect pair/redeem api/plugins/messenger/state expo-camera; do
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
' _ "$APK" | tee /tmp/v061-apk.txt

SUMMARY="$(grep '^summary:' /tmp/v061-apk.txt)"
if printf '%s' "$SUMMARY" | awk -v v="$WANT_V" -v c="$WANT_C" -F'\t' '{exit !($2 == c && $3 == v)}'; then
  ok "APK is $WANT_V / versionCode $WANT_C (matches app.json)"
else
  bad "APK version does not match app.json"; note "$SUMMARY"; note "app.json says $WANT_V / $WANT_C"
fi
if grep -qE "Signer #1 certificate SHA-256( digest)?: $SIGNER_050" /tmp/v061-apk.txt; then
  ok "signed with the SAME Personae release key as 0.5.0/0.6.0 (installs over it)"
else
  bad "signer differs from the shipped key"; note "$(grep -i 'certificate SHA-256' /tmp/v061-apk.txt)"
fi
[ "$(grep -E '^adaptive-icon xml entries: [1-9]' /tmp/v061-apk.txt | wc -l)" = 1 ] && ok "adaptive launcher icon packaged" || bad "no adaptive launcher icon in the APK"
[ "$(grep -E '^splashscreen drawable entries: [1-9]' /tmp/v061-apk.txt | wc -l)" = 1 ] && ok "splash screen asset packaged" || bad "no splash asset in the APK"
if ! grep -qE 'positive control personae://connect: [1-9]' /tmp/v061-apk.txt; then
  bad "the bundle probe itself is broken — the positive control found nothing"
elif grep -q 'want 0): SKIPPED' /tmp/v061-apk.txt; then
  bad "live bearer leak check could not run (no LIVE_BEARER / HERMES_PERSONAE_BEARER)"
elif grep -qE 'live bearer occurrences \(want 0\): 0' /tmp/v061-apk.txt; then
  ok "live bearer occurrences in the shipped bundle: 0"
else
  bad "the live bearer appears in the shipped bundle"
fi

echo
echo "--- the brand is really inside the APK (every packaged bitmap vs assets/icon.png) ---"
rm -rf /tmp/v061-res && mkdir -p /tmp/v061-res
unzip -o -q "$APK" 'res/*' -d /tmp/v061-res 2>/dev/null
convert assets/icon.png -resize 512x512! /tmp/v061-src.png
best=99; bestf=""; hits=0
for f in $(find /tmp/v061-res -type f \( -name '*.webp' -o -name '*.png' \) -size -400k | head -120); do
  t=$(mktemp /tmp/v061-c.XXXXXX.png); convert "$f" -resize 512x512! "$t" 2>/dev/null || { rm -f "$t"; continue; }
  r=$(compare -metric RMSE /tmp/v061-src.png "$t" null: 2>&1 | sed 's/.*(\(.*\))/\1/')
  awk -v a="$r" -v b="$best" 'BEGIN{exit !(a+0 < b+0)}' && { best="$r"; bestf="$f"; }
  awk -v a="$r" 'BEGIN{exit !(a+0 < 0.05)}' && hits=$((hits+1))
  rm -f "$t"
done
note "bitmaps compared: $(find /tmp/v061-res -type f \( -name '*.webp' -o -name '*.png' \) -size -400k | wc -l)"
note "best match: RMSE $best  ($(basename "$bestf"))"
if awk -v a="$best" 'BEGIN{exit !(a+0 < 0.10)}'; then
  ok "the Personae launcher mark is inside the APK ($hits packaged bitmaps match assets/icon.png)"
else
  bad "no packaged bitmap matches the Personae mark — the placeholder icon may still be shipping"
fi

echo
if [ "$fail" = 0 ]; then echo "RESULT: PASS — ${WANT_V} verified"; else echo "RESULT: FAIL"; fi
exit "$fail"
