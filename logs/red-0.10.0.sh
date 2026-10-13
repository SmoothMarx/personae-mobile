#!/usr/bin/env bash
# Produce the RED proof for one 0.10.0 item.
#
#   bash logs/red-0.10.0.sh S0 [path,path,...]
#
# The harness, in the shape 0.9.1 used: take `git archive HEAD` — the committed source, i.e. the state
# BEFORE the item's change — and drop the CURRENT `tests/run.ts` into it, so the new test runs against
# the old source. That is exactly the claim "this test fails before the change".
#
# The optional second argument names files the item ADDS and the test imports. They are copied in so
# the suite can still LOAD (a module that does not exist yet would abort the whole run at import time
# and prove nothing about the test itself). Nothing else is carried over: the i18n entries, the screen
# wiring and the plan data the item is about are all still the OLD ones, which is what the test then
# fails on. The header records what was carried and why.
#
# Output: `logs/red-0.10.0-<item>.txt`. `node_modules` is symlinked, never copied.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ITEM="${1:?usage: bash logs/red-0.10.0.sh S0 [path,path,...]}"
CARRY="${2:-}"
TREE="${TMPDIR:-/tmp}/red-0.10.0-${ITEM}"
OUT="$ROOT/logs/red-0.10.0-${ITEM}.txt"

rm -rf "$TREE"
mkdir -p "$TREE"
git -C "$ROOT" archive HEAD | tar -x -C "$TREE"
cp "$ROOT/tests/run.ts" "$TREE/tests/run.ts"
if [ -n "$CARRY" ]; then
  IFS=',' read -r -a files <<< "$CARRY"
  for f in "${files[@]}"; do
    mkdir -p "$TREE/$(dirname "$f")"
    cp "$ROOT/$f" "$TREE/$f"
  done
fi
ln -s "$ROOT/node_modules" "$TREE/node_modules"

cd "$TREE"
{
  echo "# RED proof for 0.10.0 ${ITEM}"
  echo "# tree: git archive HEAD (src/app/app.json as they were BEFORE the change) + the current tests/run.ts"
  if [ -n "$CARRY" ]; then
    echo "# carried in so the suite can load (the files this item ADDS): $CARRY"
    echo "# everything else — the string table, the screen wiring, the plan data — is the OLD state"
  else
    echo "# nothing carried in: the item's own module does not exist yet, which is the failure"
  fi
  echo "# command: npx tsx tests/run.ts   in the archived tree"
  echo
  npx tsx tests/run.ts
  echo "EXIT=$?"
} > "$OUT" 2>&1

echo "wrote $OUT"
grep -E '^not ok|passed,|EXIT=|MODULE_NOT_FOUND' "$OUT" | head -20
