#!/usr/bin/env bash
# Acceptance check (GOAL-UI.md §4.6): no secret reaches the repo.
#
# Greps every tracked file plus every untracked-but-not-ignored file for the live credentials
# this project must never carry, and prints COUNTS only — never a matched value, never the
# secret itself. The live bearer is read from ~/.hermes/.env at run time (the file it is
# allowed to live in); if that file is missing the bearer check is reported as SKIPPED so the
# script never silently claims a pass it did not make.
#
# Usage:  scripts/verify-secrets.sh            (run from anywhere inside the repo)
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${HERMES_ENV_FILE:-$HOME/.hermes/.env}"
FAIL=0

SELF="scripts/verify-secrets.sh"

files() {
  # tracked files first, then untracked ones that are NOT ignored by .gitignore.
  # The scanner itself is excluded from the PATTERN scans: it necessarily spells the
  # patterns out, and matching its own regexes would be a false positive.
  git ls-files -z -- . ":(exclude)$SELF"
  git ls-files --others --exclude-standard -z -- . ":(exclude)$SELF"
}

scan_literal() { # name, value -> prints "<name>: <n> file(s)"
  local name="$1" value="$2" hits
  if [ -z "$value" ]; then
    printf '%-34s SKIPPED (no value available)\n' "$name:"
    return 0
  fi
  hits=$(files | xargs -0 -r grep -lI -F -- "$value" 2>/dev/null | wc -l)
  printf '%-34s %s file(s)\n' "$name:" "$hits"
  if [ "$hits" -ne 0 ]; then
    files | xargs -0 -r grep -lI -F -- "$value" 2>/dev/null | sed 's/^/    HIT /'
    FAIL=1
  fi
}

scan_pattern() { # name, ERE -> prints "<name>: <n> file(s)"
  local name="$1" pattern="$2" hits
  hits=$(files | xargs -0 -r grep -lIE -- "$pattern" 2>/dev/null | wc -l)
  printf '%-34s %s file(s)\n' "$name:" "$hits"
  if [ "$hits" -ne 0 ]; then
    files | xargs -0 -r grep -lIE -- "$pattern" 2>/dev/null | sed 's/^/    HIT /'
    FAIL=1
  fi
}

echo "== repo: $(pwd)  ($(git ls-files | wc -l) tracked files) =="

BEARER=""
if [ -f "$ENV_FILE" ]; then
  BEARER=$(grep -m1 '^HERMES_PERSONAE_BEARER=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ')
else
  echo "note: $ENV_FILE not found — the live-bearer check will be SKIPPED"
fi
KEYSECRET=""
[ -f "$HOME/.personae-android/keystore-password.txt" ] && KEYSECRET=$(tr -d '\r\n' < "$HOME/.personae-android/keystore-password.txt")

scan_literal "live dashboard bearer"          "$BEARER"
scan_literal "release keystore password"      "$KEYSECRET"
# The gateway api_server key lives in config.yaml as a block-YAML value under
# gateway.api_server.extra.key -> lines like "          key: <value>". Collect the values on
# every "  key:" line (a handful at most) and scan for each; values are never printed.
GGW_KEYS=$(grep -E '^[[:space:]]+key:[[:space:]]+[^[:space:]]' "${HERMES_CONFIG_FILE:-$HOME/.hermes/config.yaml}" 2>/dev/null \
            | sed -E 's/^[[:space:]]+key:[[:space:]]+//' | tr -d '\r' || true)
if [ -n "$GGW_KEYS" ]; then
  i=0
  while IFS= read -r k; do
    i=$((i + 1))
    [ "${#k}" -ge 8 ] && scan_literal "config.yaml key value #$i" "$k"
  done <<< "$GGW_KEYS"
else
  printf '%-34s SKIPPED (no value available)\n' "config.yaml key value:"
fi
scan_literal "dashboard basic-auth password"  "$(grep -m1 '^HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"

scan_pattern "sk-/api key shaped tokens"      'sk-[A-Za-z0-9]{16,}'
scan_pattern "Authorization: Bearer <literal>" 'Bearer [A-Za-z0-9_.-]{24,}'
scan_pattern "ws ticket literal"              '"(ticket|ticket_url)":[[:space:]]*"[A-Za-z0-9_-]{20,}"'
# A real assignment has a value character after '='; prose that documents the empty form
# (\`API_SERVER_KEY=\`) or a placeholder (\`<value>\`) must not be flagged.
scan_pattern "API_SERVER_KEY assignment"      'API_SERVER_KEY[[:space:]]*=[[:space:]]*["'\'']?[A-Za-z0-9_-]{8,}'
scan_pattern "keystore store/alias password"  '(storePassword|keyPassword)[[:space:]]*=[[:space:]]*["'"'"'][^"'"'"']+'
scan_pattern "vendored build.env content"     '^(PERSONAE_KEYSTORE|KEYSTORE_PASSWORD|KEY_ALIAS)='
scan_pattern "committed build/token logs"     '^[a-z]+_EXIT=.*(token|key)='

echo
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT: clean — no credential found in tracked or untracked-unignored files."
else
  echo "RESULT: FAIL — see HIT lines above (a real credential reached the repo)."
fi
exit "$FAIL"
