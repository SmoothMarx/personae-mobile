#!/usr/bin/env bash
# The red lane, SERIAL. The suite binds a hardcoded port (tests/run.ts:1771 createMockGateway port 8791),
# so two concurrent runs collide with EADDRINUSE and produce no tally — measured on the first attempt.
set -uo pipefail
cd ~/Projects/personae-mobile
rm -f logs/red-0.11.0-progress.txt
for it in S1 S2 S3 S4 S5 S6 S7 S8; do
  bash logs/red-0.11.0.sh "$it" 'src/logic/slash.ts,mock/dashboard.mjs' c8b2641 > "logs/red-0.11.0-$it.runlog" 2>&1
  echo "done $it" >> logs/red-0.11.0-progress.txt
done
for it in R1 R2 R3 R4 R5 R6 R7 R8; do
  bash logs/red-0.11.0.sh "$it" 'src/logic/slash.ts,mock/dashboard.mjs' HEAD > "logs/red-0.11.0-$it.runlog" 2>&1
  echo "done $it" >> logs/red-0.11.0-progress.txt
done
echo ALL_DONE >> logs/red-0.11.0-progress.txt
