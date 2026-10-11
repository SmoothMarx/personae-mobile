#!/usr/bin/env bash
# Post-prebuild branding patch — run AFTER `npx expo prebuild`, alongside patch-android-signing.sh.
#
# Why this exists: `expo prebuild` regenerates android/ from the template, which ships the bare
# template's PLACEHOLDER splash (a construction grid on white) as the launch window background.
# expo-splash-screen is not a dependency of this project, and the legacy `expo.splash` key has no
# effect under SDK 57, so the launch screen is patched here instead — same pattern as the signing
# config, and for the same reason: prebuild always reverts it.
#
#   bash scripts/patch-android-branding.sh
#
# Idempotent. Exits non-zero if the assets or the generated resources are not in place.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RES=android/app/src/main/res
BG='#0b0f14'          # == app.json android.adaptiveIcon.backgroundColor == the art's own background
LOGO=assets/splash

[ -f "$LOGO/splashscreen_logo-xxxhdpi.png" ] || { echo "missing $LOGO assets"; exit 1; }
[ -d "$RES" ] || { echo "no $RES — run 'npx expo prebuild -p android --no-install' first"; exit 1; }

# 1. the launch mark, one file per density, same pixel dimensions the template used (288dp)
for pair in mdpi:288 hdpi:432 xhdpi:576 xxhdpi:864 xxxhdpi:1152; do
  d=${pair%%:*}
  cp "$LOGO/splashscreen_logo-$d.png" "$RES/drawable-$d/splashscreen_logo.png"
done

# 2. centre it instead of letting windowBackground stretch it across the screen (the template's
#    drawable is a bare bitmap with default fill gravity, i.e. non-uniform scaling on a tall phone)
cat > "$RES/drawable/splashscreen.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:drawable="@color/splashscreen_background" />
  <item>
    <bitmap android:gravity="center" android:src="@drawable/splashscreen_logo" />
  </item>
</layer-list>
XML

# 3. the launch background colour (the template ships #FFFFFF)
python3 - "$RES/values/colors.xml" "$BG" <<'PY'
import re, sys
path, bg = sys.argv[1], sys.argv[2]
src = open(path).read()
out = re.sub(r'(<color name="splashscreen_background">)[^<]*(</color>)', r'\g<1>' + bg + r'\g<2>', src)
open(path, 'w').write(out)
print('colors.xml splashscreen_background ->', bg)
PY

# 4. point the launch theme at the layer-list
python3 - "$RES/values/styles.xml" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()
out = re.sub(r'(@drawable/)splashscreen_logo\b', r'\g<1>splashscreen', src)
open(path, 'w').write(out)
print('styles.xml windowBackground ->', '@drawable/splashscreen')
PY

# 5. verify, do not assume
fail=0
grep -q 'splashscreen_background">#0b0f14' "$RES/values/colors.xml" || { echo "FAIL colours"; fail=1; }
grep -q '@drawable/splashscreen<' "$RES/values/styles.xml" || { echo "FAIL styles"; fail=1; }
[ -f "$RES/drawable/splashscreen.xml" ] || { echo "FAIL layer-list"; fail=1; }
grep -q 'adaptiveIcon' "$ROOT/app.json" || true
[ -f "$RES/mipmap-xxxhdpi/ic_launcher.webp" ] || { echo "FAIL launcher icon (app.json icon)"; fail=1; }
[ -f "$RES/mipmap-xxxhdpi/ic_launcher_foreground.webp" ] || [ -f "$RES/mipmap-xxxhdpi/ic_launcher_foreground.png" ] \
  || echo "note: no adaptive foreground file — expo writes mipmap-anydpi-v26 XML instead; checking that"
[ -f "$RES/mipmap-anydpi-v26/ic_launcher.xml" ] || { echo "FAIL adaptive icon xml"; fail=1; }
[ "$fail" = 0 ] && echo "branding patch: OK (splash + adaptive icon + launcher icon in place)"
exit $fail
