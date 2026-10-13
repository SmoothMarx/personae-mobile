#!/usr/bin/env bash
# Produce the RED proof for one 0.11.0 item — the evidence that its test FAILS before the change.
#
#   bash logs/red-0.11.0.sh <S1..S8|R1..R8> [carry,carry,...] [base-ref]
#
# The harness, in the shape 0.10.0 used: take `git archive <base-ref>` — the source as it was BEFORE
# the item's change — and drop the CURRENT `tests/run.ts` into it, so the new test runs against the old
# source. That is exactly the claim "this test fails before the change".
#
# TWO BASES, because this release is two batches with two histories:
#   * the R items are 0.11.0's own work and the batch is UNCOMMITTED when these run, so the default
#     base is HEAD — the committed tree, which already holds Half A but none of Half B/C.
#   * the S items are Half A (the 0.10.1 review batch, committed in 6c97816 + f1c2972), so their
#     falsification needs the tree BEFORE Half A: pass `c8b2641` (the 0.10.0 tip) as the third argument.
#     Re-run them with the default base and they PASS — which would prove nothing.
#
# The optional second argument names files the item ADDS and the test imports. They are copied in so
# the suite can still LOAD: a module that does not exist yet aborts the run at import time and proves
# nothing about the test itself. `src/logic/slash.ts` must be carried for EVERY item of this release
# (the suite imports it). Nothing else is carried over: the i18n entries, the screen wiring, the plan
# data and the mock the item is about are all still the OLD ones, which is what the test then fails on.
#
# Output: `logs/red-0.11.0-<item>.txt`. `node_modules` is symlinked, never copied.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ITEM="${1:?usage: bash logs/red-0.11.0.sh S1|R1|... [carry,carry,...] [base-ref]}"
CARRY="${2:-}"
BASE="${3:-HEAD}"
TREE="${TMPDIR:-/tmp}/red-0.11.0-${ITEM}"
OUT="$ROOT/logs/red-0.11.0-${ITEM}.txt"

rm -rf "$TREE"
mkdir -p "$TREE"
git -C "$ROOT" archive "$BASE" | tar -x -C "$TREE"
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
  echo "# RED proof for 0.11.0 ${ITEM}"
  echo "# base: $BASE — $(git -C "$ROOT" log -1 --format='%h %s' "$BASE")"
  echo "# tree: git archive $BASE (src/app/app.json as they were BEFORE the item) + the current tests/run.ts"
  if [ -n "$CARRY" ]; then
    echo "# carried in so the suite can load (files the item ADDS, or the test instrument it extends): $CARRY"
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
echo "--- named failures ---"
grep -E '^not ok' "$OUT" || true
grep -E 'passed,|EXIT=|MODULE_NOT_FOUND' "$OUT" | tail -3
