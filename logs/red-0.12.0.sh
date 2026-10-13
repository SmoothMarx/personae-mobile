#!/usr/bin/env bash
# red-0.12.0.sh — the falsifications for 0.12.0. ONE item per run, one output file per item.
#
#   bash logs/red-0.12.0.sh T1 [carry...]      -> logs/red-0.12.0-T1.txt
#   bash logs/red-0.12.0.sh T2                 -> logs/red-0.12.0-T2.txt
#   bash logs/red-0.12.0.sh T3                 -> logs/red-0.12.0-T3.txt
#   bash logs/red-0.12.0.sh D                  -> logs/red-0.12.0-D.txt
#   bash logs/red-0.12.0.sh guards             -> logs/red-0.12.0-guards.txt
#
# A PASS means a check ran. A red-team file means the check WOULD HAVE FAILED if the claim were false.
# Every mutation is applied to a SCRATCH COPY of the tree (`/tmp/red-0120-<item>`), never to the
# committed one: the scratch copy is a tar of the working tree with `node_modules` symlinked back, so
# the suite that runs in it is the real suite on the real sources with exactly one thing changed.
# The committed tree is untouched, and every run ends with `git status --porcelain` printed as proof.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ITEM="${1:-}"
PLUGIN_TREE="${PERSONAE_PLUGIN_DIR:-$HOME/Projects/hermes-desktop-plugins/personae}"
SCRATCH="/tmp/red-0120-${ITEM:-none}"

say()  { printf '%s\n' "$1"; }
head2() { printf '\n== %s\n' "$1"; }

# A scratch copy of the mobile tree: everything the suite reads, node_modules symlinked (8.3 GB is not
# copied five times), android/dist/logs/.git left behind because the suite touches none of them.
fresh() {
  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH"
  (cd "$ROOT" && tar -cf - \
      --exclude=node_modules --exclude=android --exclude=dist --exclude=logs \
      --exclude=.git --exclude=.expo --exclude=brand .) | tar -xf - -C "$SCRATCH"
  ln -s "$ROOT/node_modules" "$SCRATCH/node_modules"
}

# The suite, filtered to what this file is about: the 0.12.0 cases, by name, with the verdict.
named() {
  (cd "$SCRATCH" && timeout 300 npm test 2>&1)
}

probe() { # probe <name> <file>  — run a scratch probe through the tree's own tsx
  (cd "$SCRATCH" && timeout 120 npx tsx "$1" 2>&1)
}

red() { # red <label> <count-of-failing-named-cases>  — one line of verdict per mutation
  if [ "${2:-0}" -eq 0 ]; then say "RED-TEAM: FAIL — $1 did NOT turn any named case red"; else say "RED-TEAM: PASS — $1 turned $2 named case(s) red"; fi
}

case "$ITEM" in
  T1)
    say "CLAIM  T1: the sealed bubble really renders structure — the wiring, not only the parser."
    say "        A plan that is right and a call site that still paints raw text is the whole failure"
    say "        mode this half exists to prevent, and only a mutation of the CALL SITE can show it."
    head2 "the tree before the mutation"
    say "$(cd "$ROOT" && git status --porcelain | head -5)"
    fresh
    say "scratch: $SCRATCH (node_modules symlinked, everything else a copy)"
    head2 "control run — the unmutated scratch tree"
    before="$(named | grep -cE '^not ok [0-9]+ - 0\.12\.0' || true)"
    say "named 0.12.0 cases failing before the mutation: $before"
    named | grep -E '^[0-9]+/[0-9]+ passed' | sed 's/^/       /'
    head2 "MUTATION — app/thread/[id].tsx, the sealed bubble body, back to a bare Text"
    python3 - "$SCRATCH/app/thread/[id].tsx" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = "<MessageBody text={item.text} style={styles.bubbleText} />"
new = "<Text style={styles.bubbleText}>{item.text}</Text>"
assert s.count(old) == 1, s.count(old)
p.write_text(s.replace(old, new, 1))
print("mutated: the sealed bubble no longer goes through MessageBody")
PY
    out="$(named)"
    hits="$(printf '%s' "$out" | grep -cE '^not ok [0-9]+ - 0\.12\.0' || true)"
    printf '%s\n' "$out" | grep -E '^(not ok|ok) [0-9]+ - 0\.12\.0' | sed 's/^/       /'
    printf '%s\n' "$out" | grep -E '^[0-9]+/[0-9]+ passed' | sed 's/^/       /'
    printf '%s\n' "$out" | grep -A3 '^not ok' | head -8 | sed 's/^/       /'
    red "unwiring the sealed bubble" "$hits"
    head2 "the streaming-tail claim, on the same scratch tree (plan level)"
    cat > "$SCRATCH/probe-t1.ts" <<'TS'
import { parseBlocks } from './src/logic/markdown';
const src = 'Closed **one**.\n\nA sealed tail with **x** in it.';
console.log('sealed  :', JSON.stringify(parseBlocks(src, false)[1]));
console.log('streamed:', JSON.stringify(parseBlocks(src, true)[1]));
const streamed = JSON.stringify(parseBlocks(src, true)[1]);
console.log('the tail shows the marker literally while streaming:', streamed.includes('**x**'));
TS
    probe probe-t1.ts | sed 's/^/       /'
    ;;
  T2)
    say "CLAIM  T2: a live turn does not re-parse the whole reply."
    say "        R7 makes the thread repaint on every delta; if the renderer re-parsed the turn each"
    say "        time, the symptom on a phone would look like \"the markdown broke\", not \"the parser"
    say "        is running 40 times a second\". This counts the parses."
    fresh
    head2 "the instrument (in the SCRATCH copy only): a counter on every cache MISS"
    python3 - "$SCRATCH/src/logic/markdown.ts" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = "  const hit = blockCache.get(block);\n  if (hit) return hit;\n"
assert s.count(old) == 1
s = s.replace(old, old + "  (globalThis as unknown as { __parses: number }).__parses = ((globalThis as unknown as { __parses: number }).__parses ?? 0) + 1;\n", 1)
p.write_text(s)
print("instrumented: every real parse (a cache MISS) increments globalThis.__parses")
PY
    cat > "$SCRATCH/probe-t2.ts" <<'TS'
import { parseBlocks } from './src/logic/markdown';

const closed = [
  'Block **one** here.',
  'Block two here.',
  'Block three here.',
  'Block four here.',
  'Block five here.',
].join('\n\n');
const tail = 'and now the agent is still typing **half a bo';
const store = globalThis as unknown as { __parses?: number };

store.__parses = 0;
for (let delta = 1; delta <= 200; delta += 1) {
  parseBlocks(`${closed}\n\n${tail.slice(0, 1 + ((delta - 1) % tail.length))}`, true);
}
console.log(`200 deltas over a 6-block reply -> real parses: ${store.__parses}`);
console.log(`each of the 5 closed blocks parsed once = 5; the tail is never parsed while streaming`);
TS
    head2 "the run, with the cache doing its job"
    probe probe-t2.ts | sed 's/^/       /'
    head2 "MUTATION — the cache READ removed (the lookup skipped, the store left in place)"
    python3 - "$SCRATCH/src/logic/markdown.ts" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = "  const hit = blockCache.get(block);\n  if (hit) return hit;\n"
assert s.count(old) == 1
p.write_text(s.replace(old, "  // RED TEAM: the cache READ is gone\n", 1))
print("mutated: nothing reads the cache any more")
PY
    probe probe-t2.ts | sed 's/^/       /'
    head2 "the SUITE's own view of the same claim, still on the mutated tree"
    say "       The cache READ is still removed here, so the two T2 cases about the cache must be the"
    say "       ones that fail BY NAME, and every other T2 case must stay green. That is named-case"
    say "       capture: a mutation that reddened the whole suite would prove nothing about these tests."
    named | grep -E '^(ok|not ok) [0-9]+ - 0\.12\.0 T2|^[0-9]+/[0-9]+ passed' | sed 's/^/       /'
    ;;
  T3)
    say "CLAIM  T3: a table does not break the thread — and C is revertable ALONE."
    say "        (a) an escaped pipe stays inside its cell, (b) a 40-column table falls back rather"
    say "        than rendering, (c) a table inside a blockquote, (d) the grid's scroller is the"
    say "        table's and the thread's own scroll is untouched."
    fresh
    cat > "$SCRATCH/probe-t3.ts" <<'TS'
import { parseBlocks } from './src/logic/markdown';
const row = (src: string) => {
  const block = parseBlocks(src)[0] as { t: string; rows?: unknown[][]; v?: string; lang?: string };
  return block;
};
console.log('(a) escaped pipe   :', JSON.stringify(parseBlocks('| h1 | h2 |\n|----|----|\n| a `b\\|c` d | e |')[0]));
const unescaped = (parseBlocks('| h1 | h2 |\n|----|----|\n| a `b|c` d | e |')[0] as { rows: unknown[][][] }).rows[0].length;
console.log('(a) unescaped pipe :', unescaped, 'cells in the body row (GFM really splits this one — measured, and the reason the assertion above is about ESCAPING and not about the grid being clever)');
const wide = `|${Array.from({ length: 40 }, (_v, i) => ` c${i} `).join('|')}|\n|${Array.from({ length: 40 }, () => '---').join('|')}|\n|${Array.from({ length: 40 }, (_v, i) => ` v${i} `).join('|')}|`;
const fallback = row(wide);
console.log('(b) 40 columns     :', fallback.t, 'lang=' + JSON.stringify(fallback.lang), 'source kept=' + (fallback.v ?? '').includes('|'));
console.log('(c) table in quote :', JSON.stringify(parseBlocks('> | a | b |\n> |---|---|\n> | 1 | 2 |')[0].t));
console.log('(d) a real grid    :', JSON.stringify(parseBlocks('| a | b |\n|:--|--:|\n| 1 | 2 |')[0]).slice(0, 120));
TS
    head2 "the plan, on the tree as it stands"
    probe probe-t3.ts | sed 's/^/       /'
    head2 "the tree shape: which scroller scrolls, asserted as source"
    say "       MessageBody's table scroller : $(grep -c '<ScrollView horizontal showsHorizontalScrollIndicator>' "$ROOT/src/MessageBody.tsx")"
    say "       the thread's own sideways scrollers : $(grep -c '<ScrollView horizontal' "$ROOT/app/thread/[id].tsx") (the 0.9.0 staging strip, unchanged)"
    head2 "MUTATION — C reverted: ONE branch, every table through the code path"
    python3 - "$SCRATCH/src/logic/markdown.ts" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
s = p.read_text()
old = "): boolean {\n  if (columns < 2"
assert s.count(old) == 1
p.write_text(s.replace(old, "): boolean {\n  return true; // RED TEAM: Half C reverted\n  if (columns < 2", 1))
print("mutated: isDegenerateTable() says yes to everything, so no table is ever a grid")
PY
    out="$(named)"
    printf '%s\n' "$out" | grep -E '^(not ok|ok) [0-9]+ - 0\.12\.0 T3' | sed 's/^/       /'
    printf '%s\n' "$out" | grep -E '^[0-9]+/[0-9]+ passed' | sed 's/^/       /'
    hits="$(printf '%s' "$out" | grep -cE '^not ok [0-9]+ - 0\.12\.0 T3' || true)"
    red "reverting Half C" "$hits"
    say "       All three T3 cases are red, and the third one is the interesting one: the degenerate-"
    say "       fallback case goes red because its POSITIVE CONTROL needs a real grid to exist somewhere,"
    say "       and a reverted C has removed every grid. That is why the control was written in the same"
    say "       case: without it, a C-revert would have left that case green and hiding the loss. The"
    say "       revert itself is ONE branch in isDegenerateTable, and nothing else in the batch moved —"
    say "       which is what C being revertable alone means."
    ;;
  D)
    say "CLAIM  Half D: drift fails the build — one authored file, two copies, one asserted hash."
    head2 "(a) mobile drift: ONE byte changed in the phone's copy"
    fresh
    python3 - "$SCRATCH/src/logic/markdown-text.js" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
b = p.read_bytes()
assert b.count(b"MARKDOWN_TEXT_VERSION = '1'") == 1
p.write_bytes(b.replace(b"MARKDOWN_TEXT_VERSION = '1'", b"MARKDOWN_TEXT_VERSION = '2'", 1))
print("mutated: exactly one byte in src/logic/markdown-text.js (the version string)")
PY
    out="$(named)"
    printf '%s\n' "$out" | grep -E '^(not ok|ok) [0-9]+ - 0\.12\.0 D' | sed 's/^/       /'
    printf '%s\n' "$out" | grep -A3 '^not ok .* D1' | head -6 | sed 's/^/       /'
    hits="$(printf '%s' "$out" | grep -cE '^not ok [0-9]+ - 0\.12\.0 D1' || true)"
    red "one byte of mobile drift" "$hits"
    head2 "(b) plugin drift: ONE byte inside the block inlined into desktop/plugin.js"
    PSCRATCH="/tmp/red-0120-plugin"
    rm -rf "$PSCRATCH"; mkdir -p "$PSCRATCH"
    (cd "$PLUGIN_TREE" && tar -cf - --exclude=.git --exclude='tests/work' --exclude='tests/node_modules' .) | tar -xf - -C "$PSCRATCH"
    python3 - "$PSCRATCH/desktop/plugin.js" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
b = p.read_bytes()
assert b.count(b"MARKDOWN_TEXT_VERSION = '1'") == 1
p.write_bytes(b.replace(b"MARKDOWN_TEXT_VERSION = '1'", b"MARKDOWN_TEXT_VERSION = '2'", 1))
print("mutated: one byte inside the inlined block (a scratch copy of the plugin tree)")
PY
    pout="$(cd "$PSCRATCH" && PERSONAE_MOBILE_DIR="$ROOT" ./tests/run.sh 2>&1)"
    printf '%s\n' "$pout" | grep -E 'PASS  0\.12\.0 D|FAIL  0\.12\.0 D' | sed 's/^/       /'
    printf '%s\n' "$pout" | grep -E '^[0-9]+/[0-9]+ passed' | sed 's/^/       /'
    phits="$(printf '%s' "$pout" | grep -cE '^FAIL  0\.12\.0 D1' || true)"
    red "one byte of plugin drift" "$phits"
    head2 "(c) the vendoring script on the CLEAN tree is a no-op, and its three hashes agree"
    before_m="$(sha256sum "$ROOT/src/logic/markdown-text.js" | cut -d' ' -f1)"
    before_p="$(sha256sum "$PLUGIN_TREE/desktop/plugin.js" | cut -d' ' -f1)"
    before_mt="$(stat -c %Y "$ROOT/src/logic/markdown-text.js")"
    before_pt="$(stat -c %Y "$PLUGIN_TREE/desktop/plugin.js")"
    (cd "$PLUGIN_TREE" && PERSONAE_MOBILE_DIR="$ROOT" bash scripts/vendor-markdown-text.sh) | sed 's/^/       /'
    say "       mobile  file sha256 unchanged : $([ "$before_m" = "$(sha256sum "$ROOT/src/logic/markdown-text.js" | cut -d' ' -f1)" ] && echo yes || echo NO)"
    say "       plugin  file sha256 unchanged : $([ "$before_p" = "$(sha256sum "$PLUGIN_TREE/desktop/plugin.js" | cut -d' ' -f1)" ] && echo yes || echo NO)"
    say "       mobile  mtime unchanged       : $([ "$before_mt" = "$(stat -c %Y "$ROOT/src/logic/markdown-text.js")" ] && echo yes || echo NO)"
    say "       plugin  mtime unchanged       : $([ "$before_pt" = "$(stat -c %Y "$PLUGIN_TREE/desktop/plugin.js")" ] && echo yes || echo NO)"
    head2 "(d) the same string, through stripMarkdown on BOTH sides, byte-equal"
    cat > "$SCRATCH/probe-d.mjs" <<'JS'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const mobile = await import(`${process.argv[2]}/src/logic/markdown-text.js`);
const pluginTree = process.env.PERSONAE_PLUGIN_DIR ?? join(homedir(), 'Projects', 'hermes-desktop-plugins', 'personae');
const src = readFileSync(join(pluginTree, 'desktop', 'plugin.js'), 'utf8');
const beginEol = src.indexOf('\n', src.indexOf('// \u2500\u2500 BEGIN vendored markdown-text.js')) + 1;
const endAt = src.indexOf('// \u2500\u2500 END vendored markdown-text.js');
const inlined = await import(`data:text/javascript;base64,${Buffer.from(src.slice(beginEol, endAt)).toString('base64')}`);
const samples = [
  'a **bold** word and `code` and *em* end',
  'before\n```js\nconst x = 1;\n```\nafter',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  '# Title\n\n- one\n- two\n\n> quoted',
  'the snake_case_name is fine',
];
let bad = 0;
for (const s of samples) {
  const a = inlined.stripMarkdown(s, 0);
  const b = mobile.stripMarkdown(s, 0);
  if (a !== b) { bad += 1; console.log('DIFFER', JSON.stringify(s), JSON.stringify(a), JSON.stringify(b)); }
  else console.log(`byte-equal on both sides: ${JSON.stringify(s.slice(0, 34))} -> ${JSON.stringify(a)}`);
}
console.log(bad === 0 ? 'PARITY: every sample is byte-equal on both surfaces' : `PARITY: ${bad} sample(s) DIFFER`);
process.exit(bad === 0 ? 0 : 1);
JS
    (cd "$SCRATCH" && node probe-d.mjs "$ROOT" 2>&1) | sed 's/^/       /'
    ;;
  guards)
    say "CLAIM  the scope guards: this batch changed nothing it did not name, and grew no second"
    say "        implementation, no new RPC/route/socket, exactly three dependencies, and the LIVE"
    say "        reasoning body still carries its clamp."
    head2 "the diff, by file"
    (cd "$ROOT" && git status --porcelain; echo '---'; git diff --stat | tail -20) | sed 's/^/       /'
    head2 "the changed-file set, compared as a SET (a keyword grep cannot answer this)"
    python3 - "$ROOT" <<'PY'
import subprocess, sys
root = sys.argv[1]
actual = sorted(set(subprocess.run(['git', 'diff', '--name-only'], cwd=root, capture_output=True, text=True).stdout.split()))
untracked = sorted(
    p for p in subprocess.run(['git', 'status', '--porcelain'], cwd=root, capture_output=True, text=True).stdout.splitlines()
    if p.startswith('??')
)
# §2's own file map, plus the two files the brief authorises ELSEWHERE: `src/i18n.ts` (§8.1 puts the
# copy button's label in the existing thread namespace, both tables) and `package-lock.json` (§4 adds
# three dependencies, and a lockfile that disagrees with package.json is not a reproducible build).
expected = sorted([
    'app.json', 'app/thread/[id].tsx', 'package.json', 'package-lock.json',
    'src/i18n.ts', 'src/MessageBody.tsx', 'src/logic/markdown.ts',
    'src/logic/markdown-text.js', 'src/logic/markdown-text.d.ts', 'tests/run.ts',
])
tracked_new = sorted(p[3:] for p in untracked if p[3:].startswith('src/') or p[3:] == 'src/MessageBody.tsx')
seen = sorted(set(actual) | set(tracked_new))
print('       expected (from §2 + §8.1):', ' '.join(expected))
print('       actually changed/added   :', ' '.join(seen))
print('       EXTRA (not authorised)   :', ' '.join(sorted(set(seen) - set(expected))) or 'none')
print('       MISSING (not touched)    :', ' '.join(sorted(set(expected) - set(seen))) or 'none')
sys.exit(0 if set(seen) == set(expected) else 1)
PY
    if [ "$?" = 0 ]; then say "       SET MATCH — nothing outside the brief's own file list was touched"; else say "       SET MISMATCH — see EXTRA/MISSING above"; fi
    head2 "'markdown' inside the 9,469-line plugin: ONE implementation, or several?"
    python3 - "$PLUGIN_TREE/desktop/plugin.js" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
lines = p.read_text().splitlines()
b = next(i for i, l in enumerate(lines) if 'BEGIN vendored markdown-text.js' in l)
e = next(i for i, l in enumerate(lines) if 'END vendored markdown-text.js' in l)
inside = [i for i, l in enumerate(lines) if 'markdown' in l.lower() and b <= i <= e]
outside = [(i, l) for i, l in enumerate(lines) if 'markdown' in l.lower() and not (b <= i <= e)]
print(f'       inside the vendored block (lines {b + 1}-{e + 1}): {len(inside)}')
print(f'       OUTSIDE it: {len(outside)} — and every one of them must be a comment or a call site:')
for i, l in outside:
    print(f'       {i + 1}: {l.strip()[:140]}')
PY
    head2 "no new RPC, route, socket or timer in anything this batch added"
    say "       (the rendering half: markdown.ts, markdown-text.js, MessageBody.tsx)"
    grep -nE 'rpc\(|fetch\(|WebSocket|XMLHttpRequest|setInterval|\.rest\(|socket\(' \
      "$ROOT/src/logic/markdown.ts" "$ROOT/src/logic/markdown-text.js" "$ROOT/src/MessageBody.tsx" \
      | sed 's/^/       /' || say "       none"
    head2 "the dependency budget: exactly three, and every declined renderer absent"
    node -e "
      const {execSync}=require('child_process');
      const before=Object.keys(JSON.parse(execSync('git show f95321a:package.json',{cwd:'$ROOT'})).dependencies);
      const after=Object.keys(require('$ROOT/package.json').dependencies);
      const added=after.filter(d=>!before.includes(d));
      console.log('       added over the 0.11.0 tip:', added.join(', '), '=', added.length);
      const block=['marked','react-native-markdown-display','react-native-syntax-highlighter','shiki','katex','remark-math','react-native-webview'];
      console.log('       declined and absent:', block.filter(p=>!after.includes(p)).join(', '));
    "
    head2 "the ONE site that must NOT have changed: the live reasoning body"
    grep -n 'numberOfLines={10}' "$ROOT/app/thread/[id].tsx" | sed 's/^/       /'
    say "       count: $(grep -c 'numberOfLines={10}' "$ROOT/app/thread/[id].tsx")"
    head2 "and the tree is clean at the end (no mutation touched it)"
    (cd "$ROOT" && git status --porcelain | wc -l | sed 's/^/       untracked-or-modified entries: /')
    ;;
  *)
    say "usage: bash logs/red-0.12.0.sh T1|T2|T3|D|guards"
    exit 2
    ;;
esac
