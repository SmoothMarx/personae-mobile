#!/usr/bin/env bash
# Deploy server/personae-mobile-auth into the Hermes user-plugin directory and enable it.
# Idempotent; prints a diff when the deployed copy has drifted from this source of record.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="${HERMES_PLUGIN_DIR:-$HOME/.hermes/plugins}/personae-mobile-auth"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-$HOME/.hermes}"

mkdir -p "$PLUGIN_DIR"
for f in __init__.py plugin.yaml; do
  if [ -f "$PLUGIN_DIR/$f" ] && ! diff -q "$HERE/personae-mobile-auth/$f" "$PLUGIN_DIR/$f" >/dev/null; then
    echo "drift detected in $f — deployed copy differs, overwriting with the repo copy:"
    diff -u "$PLUGIN_DIR/$f" "$HERE/personae-mobile-auth/$f" || true
  fi
  install -m 0644 "$HERE/personae-mobile-auth/$f" "$PLUGIN_DIR/$f"
done
echo "installed -> $PLUGIN_DIR"

if ! grep -q 'HERMES_PERSONAE_BEARER=' "$HERMES_HOME_DIR/.env" 2>/dev/null; then
  echo "NOTE: $HERMES_HOME_DIR/.env has no HERMES_PERSONAE_BEARER line yet — the provider stays"
  echo "      disabled (fail-closed) until one is added; see server/README.md."
fi

HERMES_HOME="$HERMES_HOME_DIR" hermes plugins enable personae-mobile-auth
echo "done. Restart hermes-serve.service to pick up an env change; plugin edits alone do not need it."
