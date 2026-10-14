/**
 * 0.14.0 W2 — the dedupe rule measured against the PRE-FIX `rosterFeed.ts`.
 *
 * `src/logic/prefixRosterFeed.ts` is `git show HEAD:src/logic/rosterFeed.ts` — the revision that
 * shipped the doubled row. This probe runs the check's OWN fixture through that revision and prints
 * what it draws, so the RED is a measurement of the real artifact rather than of a fixture.
 *
 *   git show <the commit before 0.14.0 W2>:src/logic/rosterFeed.ts > src/logic/prefixRosterFeed.ts
 *   npx tsx logs/prefix-w2-probe.ts ; rm src/logic/prefixRosterFeed.ts
 */
import { buildRoster } from '../src/logic/prefixRosterFeed';

const now = 1_700_000_000_000;
const contacts = [{ name: 'cody', label: 'Cody', isDefault: false, hasAvatar: null }];
const recents = [
  { id: 'dup-1', profile: 'cody', source: 'desktop', title: 'A mesma', last_active: 1_700_000_300 },
  { id: 'recent-2', profile: 'cody', source: 'desktop', title: 'Só nos recents', last_active: 1_700_000_200 },
];
const page = [
  { id: 'dup-1', profile: 'cody', source: 'desktop', title: 'A mesma', last_active: 1_700_000_300 },
  { id: 'page-3', profile: 'cody', source: 'desktop', title: 'Só na página', last_active: 1_700_000_250 },
];

const model = buildRoster({
  contacts,
  sessions: recents as never[],
  loaded: { cody: page } as never,
  expanded: ['cody'],
  perProfile: 10,
  now,
});
const row = model.rows.find((entry) => entry.name === 'cody');
const ids = (row?.sessions ?? []).map((hit) => hit.sessionId);
const keys = ids.map((id) => `session:cody:${id}`);

console.log(`drawn ids:  ${JSON.stringify(ids)}`);
console.log(`row keys:   ${JSON.stringify(keys)}`);
console.log(`dup-1 drawn ${ids.filter((id) => id === 'dup-1').length} time(s); unique ids ${new Set(ids).size}, rows ${ids.length}`);
console.log(`unique keys ${new Set(keys).size} of ${keys.length}`);
console.log(
  ids.filter((id) => id === 'dup-1').length === 1
    ? 'DEDUPE: PASS (this revision is clean)'
    : 'DEDUPE: FAIL (the same session is drawn twice — the 0.14.0 W2 check names this)',
);
