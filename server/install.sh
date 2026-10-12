#!/usr/bin/env bash
# Deploy the two server plugins Personae Mobile depends on (personae-mobile-auth, messenger) into
# the Hermes user-plugin directory and make sure both are enabled.
#
#   server/install.sh            # deploy changed files + enable (idempotent: a 2nd run changes nothing)
#   server/install.sh --check    # report drift only, change nothing (exit 1 on drift)
#
# Only files that differ are copied (with a diff shown). The plugins' state/ directories
# (credentials.json, ui-state.json) are never touched. No secret is read or printed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGINS="${HERMES_PLUGIN_DIR:-$HOME/.hermes/plugins}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-$HOME/.hermes}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

declare -A FILES=(
  [personae-mobile-auth]="__init__.py plugin.yaml store.py qr.py dashboard/manifest.json dashboard/plugin_api.py"
  [personae-mobile-state]="__init__.py plugin.yaml dashboard/manifest.json dashboard/plugin_api.py dashboard/preferences.py"
  [messenger]="__init__.py plugin.yaml dashboard/manifest.json dashboard/plugin_api.py dashboard/ui_state.py"
)

PLUGIN_NAMES=(personae-mobile-auth personae-mobile-state messenger)

drift=0
changed=0
for plugin in "${PLUGIN_NAMES[@]}"; do
  dest="$PLUGINS/$plugin"
  for f in ${FILES[$plugin]}; do
    src="$HERE/$plugin/$f"
    if [ -f "$dest/$f" ] && diff -q "$src" "$dest/$f" >/dev/null; then
      continue
    fi
    drift=1
    if [ -f "$dest/$f" ]; then
      echo "drift: $plugin/$f"
      [ "$CHECK" = 1 ] || diff -u "$dest/$f" "$src" | head -40 || true
    else
      echo "missing: $plugin/$f"
    fi
    if [ "$CHECK" = 0 ]; then
      install -D -m 0644 "$src" "$dest/$f"
      changed=1
    fi
  done
done

if [ "$CHECK" = 1 ]; then
  [ "$drift" = 0 ] && echo "no drift: deployed plugins match server/"
  exit "$drift"
fi

for plugin in "${PLUGIN_NAMES[@]}"; do
  if ! grep -qE "^\s+- ${plugin}\s*$" "$HERMES_HOME_DIR/config.yaml" 2>/dev/null; then
    HERMES_HOME="$HERMES_HOME_DIR" hermes plugins enable "$plugin"
    changed=1
  fi
done

if ! grep -q '^HERMES_PERSONAE_BEARER=' "$HERMES_HOME_DIR/.env" 2>/dev/null; then
  echo "NOTE: no HERMES_PERSONAE_BEARER in $HERMES_HOME_DIR/.env — the provider registers only"
  echo "      once a device has been paired (fail-closed); see server/README.md."
fi

if [ "$changed" = 1 ]; then
  echo "deployed. New routes / the /pair page mount at dashboard start. Restart it OUTSIDE any"
  echo "process that lives in hermes-serve's cgroup:"
  echo "  systemd-run --user --collect --unit=hs-restart-\$(date +%s) bash -lc 'sleep 2; systemctl --user restart hermes-serve.service'"
else
  echo "nothing to do: deployed plugins already match server/"
fi
