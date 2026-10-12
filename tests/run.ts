/**
 * Offline test suite: `npm test`.
 *
 * Everything here runs against mock/server.mjs on 127.0.0.1 and the real client modules. It proves
 * the client speaks the shapes derived from api_server.py, survives error states, and streams.
 * It says NOTHING about the live gateway — see PROGRESS.md ("what could not be verified").
 *
 * Pure logic (SSE frames, roster derivations, dates) runs standalone.
 * The stream path uses `nodeTransport` (Node has no XMLHttpRequest); both transports share
 * src/api/sse.ts, so the parser under test is the parser the phone runs.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { createMockGateway } from '../mock/server.mjs';
import { createMockDashboard, profileFixture, sessionFixture } from '../mock/dashboard.mjs';
import { createDashboardClient, type GatewayEvent } from '../src/api/dashboard';
import { createBackend } from '../src/api/backend';
import { SSEParser, parseFrame } from '../src/api/sse';
import { createApi } from '../src/api/client';
import { nodeTransport } from '../src/api/transportNode';
import { xhrTransport } from '../src/api/transport';
import { installRnXhr, SSE_OK } from './rnXhr';
import { ApiError } from '../src/api/errors';
import { attemptWithPolicy, classifyStatus, nextDelayMs, parseRetryAfter, retryDelayMs, shouldRetry } from '../src/api/failures';
import { connectThrough, createProbeCache, probeRoute, tailscalePolicy } from '../src/connectivity';
import {
  checkRoute,
  effectiveRoutes,
  inferRole,
  isCgnatHost,
  moveRoute,
  normalizeRoutes,
  orderRoutes,
  pickByPriority,
  renumberRoutes,
  routesFromBaseUrl,
  selectRoute,
  transportSecurityNote,
  type RouteCandidate,
} from '../src/routes';
import { checkBaseUrl, DEFAULT_NOTIFY, DEFAULT_SESSION_TYPES, DEFAULT_SETTINGS, healSurface, normalizeNotify, normalizeSessionTypes, splitProfiles, profilePrefix, surfaceForUrl, type Settings } from '../src/settings';
import { loadSettings, saveSettings, loadLastSeen, saveLastSeen } from '../src/settingsStore';
import { __resetStoreProbe } from '../src/storage';
import { candidateAddresses, dashboardAddressFor, pairPageUrl, parseConnectLink, settingsAfterPairing, PairingError, probeService, redeemPairing, REDEEM_PATH } from '../src/pairing';
import { buildPut, createUiSync, EMPTY_META, type PutBody, type Remote, type SyncMeta } from '../src/sync/uiSync';
import {
  contactsOf, countNew, groupByDay, pageLabel, paginate, probeFromHealth, toRow, statusColor,
} from '../src/logic/roster';
import {
  buildItems,
  prettyArgs,
  reasoningText,
  resultOk,
  sortMessages,
  truncate,
} from '../src/logic/thread';
import {
  AVATAR_SIZE,
  avatarKey,
  createAvatarCache,
  isImageDataUrl,
  monogramFor,
  parseAvatarDataUrl,
  shouldProbeAvatar,
} from '../src/logic/avatars';
import { threadTitle } from '../src/logic/roster';
import { peersPort, peerRoute, peersState, normalizePeers, type PeerRow } from '../src/logic/peers';
import { isInlineWizard, wizardStepIds, wizardSteps, WIZARD_STEP_IDS } from '../src/connect/wizard';
import {
  ADVANCED_OPEN_BY_DEFAULT,
  SETTINGS_FIELDS,
  advancedFieldIds,
  connectionRendersWizard,
  isAdvanced,
  visibleFieldIds,
  type SettingsFieldId,
} from '../src/settingsLayout';
import { DIVIDER_REFERENCE_INSET, HEADER_ICON_SCALE, MIN_TOUCH_TARGET, ROW_CHROME, ROW_WIDTH, SESSION_DOT_COLUMN, estimatedTextWidth, faceCentre, headerMetrics, rosterRowGeometry, sessionRowGeometry, titleFits } from '../src/roster/geometry';
import {
  WATERMARK_MAX_AGE_MS,
  WATERMARK_MAX_ENTRIES,
  activityMs,
  capabilityOfSnapshot,
  checkpointKey,
  detectCheckpoints,
  markNotified,
  notificationFor,
  notificationsWanted,
  permissionLabel,
  permissionStateOf,
  pruneWatermark,
  snapshotOf,
  surfaceCapability,
  type CheckpointSession,
  type Watermark,
} from '../src/logic/checkpoints';
import { DEFAULT_POLL_MS, createCheckpointWatcher } from '../src/logic/watcher';
import {
  UNASSIGNED,
  addSection,
  deleteSection,
  groupsFor,
  normalizeSections,
  renameSection,
  sectionOf,
} from '../src/logic/sections';
import { dotStateFor, isUnread, profileRollup, showBadge } from '../src/logic/lights';
import {
  SESSION_TYPE_DEFAULT,
  anySessionType,
  attributeBodyHits,
  automaticRuns,
  bodySearchPlan,
  buildRoster,
  coloursFor,
  conversations,
  filterSessionTypes,
  isAutomatic,
  mergeBodyHits,
  rosterContacts,
  searchRoster,
  sessionTypeChoices,
  sessionTypeEnabled,
  sessionTypeOf,
  sessionVisible,
} from '../src/logic/rosterFeed';
import {
  EMPTY_PREFS,
  SWATCHES,
  expandedNames,
  isHidden,
  loadRosterPrefs,
  normalizeExpanded,
  saveRosterPrefs,
  setProfileColour,
  setSessionColour,
  toggleExpanded,
  toggleHidden,
} from '../src/rosterPrefs';
import { addSecret, buildLogDocument, createLog, redact } from '../src/logging';
import { contentToText, formatAge, formatDate, formatDateTime, formatHours, initialOf } from '../src/format';
import { getLanguage, setLanguage, stringsFor, t } from '../src/i18n';
import { colors, space } from '../src/theme';
import { TYPICAL_BUTTON_INSET, TYPICAL_GESTURE_INSET, sheetPadding } from '../src/roster/sheet';
import {
  CLOSED_SWIPE,
  SWIPE,
  actionAvailability,
  actionColour,
  armDelete,
  clampDrag,
  closeIfOpen,
  closeRow,
  confirmDelete,
  disarm,
  isArmed,
  isOpen,
  openRow,
  restX,
  rowAccessibilityActions,
  settle,
  shouldClaim,
} from '../src/logic/swipe';
import { profileMenuEntries, sectionMenuEntries, sessionMenuEntries, sortEntries } from '../src/roster/menus';
import { PLUS_KEYS, profileFromPickerKey, profilePickerEntries, profileSlug, plusMenuEntries } from '../src/roster/plusMenu';

// Most assertions below were written against the Portuguese copy, so the suite runs in PT
// explicitly. The language tests switch on purpose and always restore 'pt' afterwards.
setLanguage('pt');

/** Run `fn` in a given language, then put the suite's language back. */
async function inLanguage(language: 'en' | 'pt', fn: () => void | Promise<void>): Promise<void> {
  const before = getLanguage();
  setLanguage(language);
  try {
    await fn();
  } finally {
    setLanguage(before);
  }
}

type TestFn = () => void | Promise<void>;
const tests: { name: string; fn: TestFn }[] = [];
let failures = 0;

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function approx(actual: number, expected: number, tolerance = 120): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`);
}

async function expectApiError(fn: () => Promise<unknown>, check: (error: ApiError) => void): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    check(error);
    return;
  }
  assert.fail('expected the call to reject, it resolved');
}


/** Open a bare WebSocket (no client wrapper) — used to prove the ticket rules on the wire. */
async function openRawSocket(url: string): Promise<{ send: (data: string) => void; close: () => void }> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not open')), 3000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('socket errored before opening'));
    };
  });
  return { send: (data: string) => socket.send(data), close: () => socket.close() };
}

async function expectRawSocketFailure(url: string): Promise<void> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('a refused upgrade must not open a socket')), 3000);
    socket.onopen = () => {
      clearTimeout(timer);
      reject(new Error('the socket opened with a spent ticket'));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onclose = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// ─────────────────────────────────────────────────────────── SSE parser ──
test('sse: parses a named frame', () => {
  const parser = new SSEParser();
  const frames = parser.push('event: assistant.delta\ndata: {"delta":"olá"}\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'assistant.delta');
  assert.deepEqual(JSON.parse(frames[0].data), { delta: 'olá' });
});

test('sse: holds a frame split across chunks', () => {
  const parser = new SSEParser();
  assert.equal(parser.push('event: assistant.delta\ndata: {"del').length, 0);
  assert.ok(parser.pending.includes('del'));
  const frames = parser.push('ta":"x"}\n\n');
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0].data), { delta: 'x' });
});

test('sse: ignores keepalive comments and blank lines', () => {
  const parser = new SSEParser();
  const frames = parser.push(': keepalive\n\n\n\n: keepalive\n\n');
  assert.equal(frames.length, 0);
  assert.equal(parser.pending, '');
});

test('sse: handles CRLF and multiple frames in one chunk', () => {
  const parser = new SSEParser();
  const frames = parser.push('event: a\r\ndata: {"n":1}\r\n\r\nevent: b\r\ndata: {"n":2}\r\n\r\n');
  assert.deepEqual(frames.map((f) => f.event), ['a', 'b']);
});

test('sse: joins multi-line data and defaults an unnamed frame to "message"', () => {
  const frames = new SSEParser().push('data: one\ndata: two\n\n');
  assert.equal(frames[0].event, 'message');
  assert.equal(frames[0].data, 'one\ntwo');
});

test('sse: parseFrame rejects a frame with no data and drops unknown fields', () => {
  assert.equal(parseFrame('event: x\nretry: 100'), null);
  assert.equal(parseFrame('event: x\ndata: 1')?.event, 'x');
});


// ─────────────────────────────────── F3: thread details ──
// The 0.3.0 builder produced {kind:'tools', count, names} and nothing else, so "Ver detalhes"
// could only change a label. These tests pin the payloads now that they are carried.

const PNG = `data:image/png;base64,${Buffer.from('not-really-a-png').toString('base64')}`;

function msg(overrides: Record<string, unknown>): Record<string, unknown> {
  return { role: 'assistant', timestamp: 1_700_000_000, ...overrides };
}

test('f3: a tool run joins each call to its result by tool_call_id', () => {
  const items = buildItems([
    msg({ id: 'a1', content: 'vou ler o ficheiro', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }),
    msg({ id: 't1', role: 'tool', tool_call_id: 'call_1', tool_name: 'read_file', content: 'conteúdo do ficheiro' }),
    msg({ id: 'm2', content: 'está feito', timestamp: 1_700_000_010 }),
  ] as never);

  const tools = items.find((item) => item.kind === 'tools');
  assert.ok(tools && tools.kind === 'tools');
  assert.equal(tools.count, 1);
  assert.equal(tools.calls[0].id, 'call_1');
  assert.equal(tools.calls[0].name, 'read_file');
  assert.match(tools.calls[0].args, /"path": "README\.md"/, 'arguments are pretty-printed');
  assert.equal(tools.calls[0].result, 'conteúdo do ficheiro');
  assert.equal(tools.calls[0].ok, true);
  assert.deepEqual(tools.names, ['read_file']);
  // The surrounding bubbles are untouched.
  assert.equal(items.filter((item) => item.kind === 'message').length, 2);
});

test('f3: reasoning-only produces a Pensamento item and no tools item', () => {
  const items = buildItems([
    msg({ id: 'r1', content: '', reasoning: 'O utilizador quer as horas.' }),
    msg({ id: 'm2', content: 'São 14h', timestamp: 1_700_000_020 }),
  ] as never);
  const reasoning = items.find((item) => item.kind === 'reasoning');
  assert.ok(reasoning && reasoning.kind === 'reasoning');
  assert.equal(reasoning.text, 'O utilizador quer as horas.');
  assert.equal(items.filter((item) => item.kind === 'tools').length, 0, 'no calls, no tools row');
});

test('f3: reasoning_content is read too (the second field the gateway sends)', () => {
  assert.equal(reasoningText({ reasoning_content: 'pensamento' } as never), 'pensamento');
  assert.equal(reasoningText({ reasoning: '  espaço  ' } as never), 'espaço');
});

test('f3: an orphan tool result still renders instead of vanishing', () => {
  const items = buildItems([
    msg({ id: 't1', role: 'tool', tool_call_id: 'call_missing', tool_name: 'orphan_tool', content: 'resultado órfão' }),
  ] as never);
  const tools = items.find((item) => item.kind === 'tools');
  assert.ok(tools && tools.kind === 'tools');
  assert.equal(tools.calls.length, 1);
  assert.equal(tools.calls[0].id, 'call_missing');
  assert.equal(tools.calls[0].name, 'orphan_tool');
  assert.equal(tools.calls[0].result, 'resultado órfão');
});

test('f3: hidden scaffolding never renders — not as a bubble, not as a tool result', () => {
  const items = buildItems([
    msg({ id: 'h1', content: 'ruído de scaffolding', display_kind: 'hidden' }),
    msg({
      id: 'h2',
      content: '',
      display_kind: 'hidden',
      tool_calls: [{ id: 'call_hidden', function: { name: 'internal', arguments: '{}' } }],
    }),
    msg({ id: 'h3', role: 'tool', tool_call_id: 'call_hidden', tool_name: 'internal', content: 'segredo', display_kind: 'hidden' }),
    msg({ id: 'm1', content: 'visível', timestamp: 1_700_000_030 }),
  ] as never);
  assert.equal(items.length, 1, 'only the real bubble survives');
  assert.equal(items[0].kind, 'message');
  const serialized = JSON.stringify(items);
  assert.ok(!serialized.includes('scaffolding'), 'hidden text must not leak into the render list');
  assert.ok(!serialized.includes('call_hidden'), 'a hidden call must not become a tool row');
});

test('f3: two runs get distinct item keys — the screen keys its per-run expansion on them', () => {
  const items = buildItems([
    msg({ id: 'a1', tool_calls: [{ id: 'c1', function: { name: 'one', arguments: '{}' } }] }),
    msg({ id: 'a2', content: 'meio', timestamp: 1_700_000_005 }),
    msg({ id: 'a3', timestamp: 1_700_000_010, tool_calls: [{ id: 'c2', function: { name: 'two', arguments: '{}' } }] }),
  ] as never);
  const tools = items.filter((item) => item.kind === 'tools');
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0].key, tools[1].key);
  const keys = items.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length, 'every key is unique, or Set-based state would collide');
});

test('f3: long arguments and results are truncated with a visible marker', () => {
  const long = 'x'.repeat(2000);
  const items = buildItems([
    msg({ id: 'a1', tool_calls: [{ id: 'c1', function: { name: 'big', arguments: JSON.stringify({ body: long }) } }] }),
    msg({ id: 't1', role: 'tool', tool_call_id: 'c1', tool_name: 'big', content: long }),
  ] as never);
  const tools = items.find((item) => item.kind === 'tools');
  assert.ok(tools && tools.kind === 'tools');
  assert.ok(tools.calls[0].args.length < long.length + 200);
  assert.match(tools.calls[0].args, /\(\+\d+ caracteres\)/);
  assert.match(String(tools.calls[0].result), /\(\+\d+ caracteres\)/);
});

test('f3: a failed result is marked, a normal one is not', () => {
  assert.equal(resultOk({ content: 'Error: ficheiro não encontrado' } as never), false);
  assert.equal(resultOk({ content: 'tudo bem' } as never), true);
  assert.equal(resultOk({ content: { error: 'boom' } } as never), false);
  assert.equal(resultOk({ content: '', finish_reason: null } as never), true, 'unknown is not a failure');
});

test('f3: prettyArgs survives a non-JSON argument string', () => {
  assert.equal(prettyArgs('não é json'), 'não é json');
  assert.equal(prettyArgs(''), '');
  assert.match(prettyArgs({ a: 1 }), /"a": 1/);
  assert.ok(truncate('abcdef', 3).startsWith('abc'));
});

// ─────────────────────────────────── F1: avatars ──

test('f1: the cache key is profile + size, and the monogram is the fallback', () => {
  assert.equal(avatarKey('cody', 28), 'personae.avatar.v1.28.cody');
  assert.notEqual(avatarKey('cody', 28), avatarKey('cody', 40));
  assert.equal(monogramFor('cody'), 'C');
  assert.equal(monogramFor('cody', 'Beta'), 'B');
  assert.equal(monogramFor(''), '?');
  assert.equal(AVATAR_SIZE, 62, '0.8.0 B: 54 × 1.15 = 62.1, taken down to a whole number');
  assert.equal(
    avatarKey('cody'),
    'personae.avatar.v1.62.cody',
    'the default size IS the row size, so a 54 px blob in AsyncStorage can never be served again',
  );
});

// ─────────────────────────────── 0.7.0 A: the roster row's measured geometry ──

test('0.7.0 A: the row is 54 / 16 / 70, the divider clears the avatar, and a long name fits', () => {
  const g = rosterRowGeometry();
  // SUPERSEDED IN 0.8.0 (phase B): this read `assert.equal(g.avatar, 54, ...)`. The operator asked
  // for faces 15% bigger, so the live value is 62 — see the 0.8.0 B test below.
  assert.equal(g.avatar, 62, '0.8.0 B: 54 → 62');
  assert.equal(g.avatarGap, 16, 'the reference gap between avatar and text');
  assert.equal(g.inset, 16, 'the reference inset');
  assert.equal(g.textX, g.inset + g.avatar + g.avatarGap, 'textX is DERIVED — it cannot drift from the three measured numbers');
  // SUPERSEDED IN 0.8.0 (phase A). This assertion read `assert.equal(g.height, 70, 'the reference
  // chat row 8:4771 is 360 × 70')` through 0.7.x. It moved to 76 for "more air between profile
  // rows"; the 0.8.0 A test below is the live one. Kept here so the move is visible in the history.
  assert.equal(g.height, 76, '0.8.0 A: 70 → 76, for more air between profile rows');
  assert.equal(g.height, g.linePitch * 2 + g.paddingVertical * 2, 'two 27 dp lines + padding make the height');
  assert.equal(g.dividerInset, 78, "the reference divider's own inset");
  // SUPERSEDED IN 0.8.0 (phase B): this demanded a strict `>` — "clears the avatar". At 62 dp the
  // face's right edge lands exactly ON 78, so the honest predicate is "does not sit under the face"
  // (>=). The divider is the cell's bottom border, drawn below the avatar, so flush is fine and the
  // 0.7.0 value is what the derivation keeps as its floor.
  assert.ok(g.dividerInset >= g.inset + g.avatar, 'the divider never starts under the avatar');
  assert.equal(g.titleSize, 19);
  assert.equal(g.previewSize, 18);
  // The widest profile name on this box is 15 characters (`design-guardian`, measured 2026-10-11
  // and re-measured 2026-10-12 against the live /api/profiles: only `default` carries a
  // display_name, so every other row's label IS its profile name).
  const LONG = 'personae-mobile-cody';
  assert.equal(LONG.length, 20);
  assert.ok(titleFits('design-guardian', g), 'the longest real profile name fits');
  // SUPERSEDED IN 0.8.0 (phase B): at a 62 dp face this 20-character string no longer fits — it
  // needs 190 dp of the 188 dp column, and 19 characters is the limit. The real names are 15
  // characters or fewer, so nothing on this box truncates; see the 0.8.0 B test.
  assert.ok(
    estimatedTextWidth(LONG, g.titleSize) > g.titleMaxWidth,
    '20 characters now overflow by 2 dp — the +8 dp the face took came out of the title column',
  );
  assert.ok(titleFits('personae-mobile-cod', g), '19 characters is the limit at 62 dp');
  // Falsifiable: the 26 dp the avatar took (28 → 54) had to come out of the CHROME. At the
  // reference's 19 dp title, the pre-0.7.0 age column (84 dp) would not have held this name.
  const withOldChrome = 360 - (16 + 54 + 16) - 6 - 84 - 4 - 12;
  assert.ok(
    estimatedTextWidth(LONG, g.titleSize) > withOldChrome,
    'the trimmed age column is load-bearing, not decoration',
  );
  assert.equal(ROW_CHROME.ageWidth, 56);
  assert.equal(ROW_WIDTH, 360);
  // A narrow phone is still not a truncation: the geometry is width-parametric.
  assert.ok(rosterRowGeometry(320).titleMaxWidth < g.titleMaxWidth);
  // SUPERSEDED IN 0.8.0 (phase B): this demanded >= 156 (16 characters at 54 dp). At 62 dp a 320 dp
  // canvas leaves 148 dp, i.e. 15 characters — still enough for the longest real name on this box.
  assert.ok(rosterRowGeometry(320).titleMaxWidth >= 143, 'even at 320 dp the column holds 15 characters');
  assert.ok(titleFits('design-guardian', rosterRowGeometry(320)), 'and that is the longest real name');
});

test('0.7.0 A: the row is built from geometry.ts — no pre-0.7.0 magic numbers survive', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'roster', 'components.tsx'), 'utf8');
  assert.match(src, /rosterRowGeometry/, "the row's numbers come from the measured geometry module");
  assert.match(src, /props\.size \?\? AVATAR_SIZE/, 'Face defaults to the 54 dp avatar');
  assert.match(src, /marginLeft: ROW_METRICS\.dividerInset/, 'the divider is inset past the avatar');
  // SUPERSEDED IN 0.8.0 (phase C): this read `assert.match(src, /paddingLeft: ROW_METRICS\.textX/,
  // 'the sessions under a row align to the text column')`. The operator asked for a less indented
  // session list, so the sessions now align to the DOT column. See the 0.8.0 C test.
  assert.match(src, /paddingLeft: SESSION_METRICS\.dotX/, 'the sessions align to the dot column instead');
  assert.match(src, /minHeight: ROW_METRICS\.height/, 'the row cannot collapse below its height');
  assert.ok(
    !/size \?\? 32|width: 84|paddingLeft: 60|marginLeft: 60/.test(src),
    'the 32 dp face, the 84 dp age column and the 60 dp text offsets are gone',
  );
});

// ─────────────────────────────── 0.8.0 A: more air between profile rows ──

test('0.8.0 A: the profile cell is 76 dp — "a little bit more space between rows" is the height', () => {
  const g = rosterRowGeometry();
  assert.equal(g.paddingVertical, 11, 'the vertical padding moved 8 → 11 per side');
  assert.equal(g.height, 76, 'so the cell renders 76 dp');
  assert.ok(g.height > 70, 'it grew — 0.7.0 rendered a 70 dp cell');
  assert.ok(g.height < 80, 'and not so much that it reads as a layout bug (+8.6%)');
  assert.equal(g.linePitch, 27, 'the title/preview pitch is untouched');
  assert.equal(g.linePitch * 2 + g.paddingVertical * 2, g.height, 'the height is still exactly its parts');
  // What did NOT move: the horizontal inset, the divider inset, the avatar and the text sizes.
  assert.equal(g.inset, 16);
  assert.equal(g.dividerInset, 78);
  assert.equal(g.titleSize, 19);
  assert.equal(g.previewSize, 18);
  // The rise is parametric: a narrow phone gets the same air, and the same arithmetic.
  assert.equal(rosterRowGeometry(320).height, 76);
});

// ─────────────────────────────── 0.8.0 B: profile pictures 15% bigger ──

test('0.8.0 B: the face is 62 dp and every knock-on is DERIVED from it', () => {
  const g = rosterRowGeometry();
  assert.equal(AVATAR_SIZE, 62, '54 × 1.15 = 62.1, taken down to 62 so no face has a half-pixel edge');
  assert.equal(g.avatar, 62, 'the row draws the constant instead of restating the number');
  assert.equal(g.textX, 94, 'textX follows: 16 inset + 62 face + 16 gap');
  assert.equal(g.textX, g.inset + g.avatar + g.avatarGap, 'and it is still DERIVED, never a literal');
  assert.ok(g.dividerInset >= 78, 'the divider clears the face, whose right edge is at 16 + 62 = 78');
  assert.equal(g.dividerInset, Math.max(DIVIDER_REFERENCE_INSET, g.inset + g.avatar), 'derived, with 78 as the floor');
  // The departure from the Telegram reference measured for 0.7.0 is written down where the number
  // lives, so the next reader does not "fix" 62 back to 54.
  const src = readFileSync(join(process.cwd(), 'src', 'logic', 'avatars.ts'), 'utf8');
  assert.match(src, /DELIBERATE departure/, 'the departure from Telegram\'s 54 dp is recorded in avatars.ts');
  assert.match(src, /AVATAR_SIZE = 62/);
  const row = readFileSync(join(process.cwd(), 'src', 'roster', 'components.tsx'), 'utf8');
  assert.match(row, /const G = rosterRowGeometry\(\)/, 'the two rows keep taking their numbers from geometry.ts');
});

test('0.8.0 B: cached art cannot survive the resize — avatarKey() carries the size', async () => {
  const written: Record<string, string> = {};
  const store = {
    getItem: async (key: string) => written[key] ?? null,
    setItem: async (key: string, value: string) => {
      written[key] = value;
    },
  };
  let calls = 0;
  const fetchOnce = async () => {
    calls += 1;
    return PNG;
  };
  // A 0.7.0 install leaves a 54 px blob behind; the 0.8.0 face must not be served it.
  const old = createAvatarCache({ store });
  assert.equal(await old.load('cody', 54, fetchOnce), PNG);
  assert.equal(written[avatarKey('cody', 54)], PNG, 'the 54 px blob is in the store');
  assert.equal(calls, 1);

  const fresh = createAvatarCache({ store });
  assert.equal(await fresh.load('cody', 62, fetchOnce), PNG, 'the new size is fetched, not inherited');
  assert.equal(calls, 2, 'the stale blob was not served for the 62 dp face');
  assert.equal(written[avatarKey('cody', 62)], PNG, 'and it caches under its own key');
  assert.equal(fresh.peek('cody', 62), PNG, 'so the next paint is served from memory');
  assert.equal(fresh.peek('cody', 54), null, 'while 54 is a different entry entirely');
});

test('0.8.0 B: the longest real profile label on this box still renders in full at 62 dp', () => {
  const g = rosterRowGeometry();
  let names: string[] = [];
  try {
    names = readdirSync(join(homedir(), '.hermes', 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    /* not this box — the declared list below is the same one the live probe returned */
  }
  if (!names.length) {
    names = ['archivist', 'bd-lead', 'bizzy-talk', 'cody', 'default', 'design-guardian', 'dobbs', 'gordon', 'homie',
      'ip-coordinator', 'marv', 'marvin', 'matt', 'onboarding-lead', 'product-owner', 'scholes', 'secretary',
      'stamos', 'style-warden', 'tuchman', 'vintage', 'watchdog'];
  }
  // `label: row.label || row.name` in the backend, and only `default` carries a display_name on the
  // live box — so the longest LABEL is the longest profile NAME.
  const longest = names.slice().sort((a, b) => b.length - a.length)[0] ?? 'default';
  assert.ok(longest.length >= 15, `this box really has a long-ish name (${longest}, ${longest.length} chars)`);
  assert.ok(
    titleFits(longest, g),
    `"${longest}" must not ellipsize: it needs ${estimatedTextWidth(longest, g.titleSize)} dp of ${g.titleMaxWidth} dp`,
  );
  assert.ok(titleFits(longest, rosterRowGeometry(320)), 'nor on a 320 dp phone');
});

// ─────────────────────────────── 0.8.0 C: less indent, the dot under the face ──

test('0.8.0 C: a session row is padded to the DOT column (x 30, centre 37), not the text column', () => {
  const s = sessionRowGeometry();
  const g = rosterRowGeometry();
  assert.equal(s.dotX, 30, 'the row starts at the dot column, not at 86/94');
  assert.equal(s.dotColumn, SESSION_DOT_COLUMN, 'the 0.7.0 dot column keeps its width');
  assert.equal(s.dotColumn, 14);
  assert.equal(s.dotCentre, 37, 'derived: 30 + 14 / 2');
  assert.equal(s.dotCentre, s.dotX + s.dotColumn / 2, 'so the centre cannot drift from the parts');
  assert.equal(s.gap, 8, 'the gap stays `space.sm`, the one the row already used');
  assert.equal(s.textX, 52, 'so the title starts at 30 + 14 + 8');
  assert.ok(s.textX >= 48 && s.textX <= 56, 'and it lands in the 48-56 band the design names');
  // 0.8.0's own comparison; 0.7.0 padded a session row to its text column of 86.
  assert.equal(86 - s.textX, 34, '34 dp less indented than 0.7.0');
  assert.equal(g.textX - s.textX, 42, 'and 42 dp less than the profile text column is now');
});

test('0.8.0 C: the dot sits under the picture, offset to the left of its centre', () => {
  const s = sessionRowGeometry();
  const g = rosterRowGeometry();
  const centre = g.inset + g.avatar / 2;
  // The brief for this phase says "the face spans [16, 78] at 62 dp, centre 43" and concludes the dot
  // is 6 dp left of it. THAT ARITHMETIC IS STALE: 16 + 62 = 78, so the centre is 47 — 43 was the
  // centre of 0.7.0's 54 dp face (16 + 27). The face grew in phase B, the dot column did not move,
  // and the offset is therefore 10 dp. The operator's "offset a bit to the left" holds either way;
  // the binding numbers (x 30 / centre 37 / text in [48,56]) are asserted in the test above.
  assert.equal(centre, 47, 'the 62 dp face spans [16, 78], so its centre is 47 (not 43)');
  assert.equal(faceCentre(g), centre, 'and the helper agrees instead of restating the number');
  assert.equal(centre - s.dotCentre, 10, 'the dot centre is 10 dp left of the face centre');
  // Under the picture, not beside it: the dot's box falls inside the face's box on the x axis.
  assert.ok(s.dotX >= g.inset, 'the dot column starts no further left than the face');
  assert.ok(s.dotX + s.dotColumn <= g.inset + g.avatar, 'and the whole dot column is under the face');
  assert.ok(s.dotCentre < centre, 'strictly left of centre, never right of it');
  assert.ok(s.dotCentre > g.inset, 'but still inside the face, not hanging off its left edge');
});

test('0.8.0 C: the wiring is the geometry — both row species share the column', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'roster', 'components.tsx'), 'utf8');
  assert.match(src, /sessionRowGeometry/, 'the session row takes its numbers from geometry.ts');
  assert.match(src, /paddingLeft: SESSION_METRICS\.dotX/, 'left padding is the dot column');
  assert.match(src, /sessionDot: \{ width: SESSION_METRICS\.dotColumn/, 'the dot column keeps its width');
  assert.match(src, /gap: SESSION_METRICS\.gap/);
  // The clock glyph for automatic runs lives INSIDE the same sessionDot view, so cron rows line up
  // with conversation rows instead of drifting to their own column.
  assert.match(src, /<View style=\{styles\.sessionDot\}>/, 'one dot column for both row species');
  assert.match(src, /time-outline/, 'automatic runs swap the dot for the clock in that same column');
  assert.ok(!/paddingLeft: ROW_METRICS\.textX/.test(src), 'the old text-column indent is gone, not shadowed');
});

// ─────────────────── 0.8.0 D: the list shows conversations, and Settings decides ──

test('0.8.0 D: the defaults are conversations ON, job runs OFF', () => {
  assert.deepEqual(DEFAULT_SESSION_TYPES, { sessions: true, automatic: false });
  assert.deepEqual(DEFAULT_SETTINGS.sessionTypes, DEFAULT_SESSION_TYPES, 'a fresh install gets them');
  assert.deepEqual(SESSION_TYPE_DEFAULT, { sessions: true, automatic: false }, 'and so does a missing key');
  // A missing key falls back to ITS bucket's default, never to a blanket `true`.
  assert.equal(sessionTypeEnabled('sessions', null), true);
  assert.equal(sessionTypeEnabled('automatic', null), false);
  assert.equal(sessionTypeEnabled('automatic', {} as never), false);
  assert.equal(anySessionType(null), true, 'no settings object is not "everything off"');
  // The filter itself — the one the feed and Phase H's watcher both call.
  const rows: { id: string; source: string }[] = [{ id: 'a', source: 'cron' }, { id: 'b', source: 'oneshot' }];
  assert.deepEqual(filterSessionTypes(rows, DEFAULT_SESSION_TYPES).map((row) => row.id), ['b']);
  assert.equal(filterSessionTypes(rows, null).length, 2, 'no opinion passes everything through');
  assert.equal(filterSessionTypes(rows, { sessions: true, automatic: true }).length, 2);
});

test('0.8.0 D: a 0.7.0 stored blob with no sessionTypes key loads with the defaults', async () => {
  __resetStoreProbe();
  const { storeSet } = await import('../src/storage');
  // The exact shape 0.7.0 wrote: no `sessionTypes` key anywhere.
  await storeSet(
    'personae.settings.v1',
    JSON.stringify({
      baseUrl: 'http://10.0.0.15:9119',
      surface: 'dashboard',
      profiles: ['cody'],
      model: '',
      language: 'pt',
      autoConnect: true,
      openTailscaleOnFailure: true,
    }),
  );
  const loaded = await loadSettings();
  assert.deepEqual(loaded.sessionTypes, { sessions: true, automatic: false }, 'defaults, not undefined');
  assert.equal(loaded.autoConnect, true, 'and the stored values still survive');
  assert.deepEqual(loaded.profiles, ['cody']);
  assert.equal(loaded.language, 'pt');
  // It round-trips: the next save writes the key, and an explicit choice is preserved.
  await saveSettings({ ...loaded, sessionTypes: { sessions: false, automatic: true } });
  assert.deepEqual((await loadSettings()).sessionTypes, { sessions: false, automatic: true });
  // A half-written key must not take the other bucket down with it.
  await storeSet('personae.settings.v1', JSON.stringify({ sessionTypes: { sessions: false } }));
  assert.deepEqual((await loadSettings()).sessionTypes, { sessions: false, automatic: false });
  await storeSet('personae.settings.v1', JSON.stringify({ sessionTypes: 'junk' }));
  assert.deepEqual((await loadSettings()).sessionTypes, { sessions: true, automatic: false });
  assert.deepEqual(normalizeSessionTypes({ automatic: true }), { sessions: true, automatic: true });
  __resetStoreProbe();
});

test('0.8.0 D: an UNKNOWN source counts as a conversation — fail-open, with its own test', () => {
  // The live box already carries `oneshot` (measured 2026-10-12): a real source this app's
  // classification has never heard of. It must NOT vanish from the user's list.
  assert.equal(sessionTypeOf({ source: 'oneshot' } as never), 'sessions');
  assert.equal(sessionTypeOf({ source: 'brand-new-source' } as never), 'sessions');
  assert.equal(sessionTypeOf({ source: '' } as never), 'sessions');
  assert.equal(sessionTypeOf({} as never), 'sessions');
  assert.equal(sessionTypeOf(null), 'sessions');
  assert.equal(sessionVisible({ source: 'oneshot' } as never, DEFAULT_SESSION_TYPES), true, 'it shows by default');
  // The job-run bucket is exact, and case-insensitive like `isAutomatic` already is.
  for (const source of ['cron', 'cron_output', 'webhook', 'CRON', ' Webhook ']) {
    assert.equal(sessionTypeOf({ source } as never), 'automatic', `${source} is a job run`);
    assert.equal(sessionVisible({ source } as never, DEFAULT_SESSION_TYPES), false, `${source} is hidden by default`);
  }
  // An unknown source is a conversation even when the user has hidden conversations — that is the
  // user's own choice about the conversation bucket, not the classifier failing open.
  assert.equal(sessionVisible({ source: 'oneshot' } as never, { sessions: false, automatic: true }), false);
});

test('0.8.0 D: ONE classifier — the classification exists in exactly one file', () => {
  // §5: "Session-type classification exists in more than one place" is a fail. The source of truth
  // is `NON_CONVERSATION_SOURCES`, so this walks the app's own sources and insists it is read in
  // exactly one of them.
  const root = join(process.cwd(), 'src');
  const readers: string[] = [];
  /** The token in a CODE line — a comment that names it is prose, not a second classifier. */
  const readsIt = (source: string) =>
    source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n')
      .includes('NON_CONVERSATION_SOURCES');
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (readsIt(readFileSync(full, 'utf8'))) readers.push(full.replace(`${process.cwd()}/`, ''));
    }
  };
  walk(root);
  assert.deepEqual(readers, ['src/logic/rosterFeed.ts'], 'exactly one module classifies a session');
  const feed = readFileSync(join(root, 'logic', 'rosterFeed.ts'), 'utf8');
  assert.match(feed, /export function sessionTypeOf/, 'and it exports the classifier the list and the watcher share');
  /** The same "code, not prose" filter, for the two modules that must NOT carry the rule. */
  const codeOnly = (source: string) =>
    source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
  // `settings.ts` may carry the TYPE and the default; it must never carry a second copy of the rule.
  assert.ok(!/cron/i.test(codeOnly(readFileSync(join(root, 'settings.ts'), 'utf8'))), 'settings.ts: the type, never the rule');
  // `useRoster` legitimately names the wire's `cron` SLICE (`slices.cron`); what it must not do is
  // classify a session itself. It delegates: `buildRoster` applies the filter and the hook only asks
  // whether any type is on.
  const hook = codeOnly(readFileSync(join(root, 'roster', 'useRoster.ts'), 'utf8'));
  assert.ok(!/isAutomatic|sessionTypeOf|webhook/.test(hook), 'useRoster.ts: it asks the filter, it does not re-implement it');
  assert.match(hook, /anySessionType/, 'and it asks whether ANY type is on');
  assert.match(hook, /sessionTypes,/, 'and it hands the setting to buildRoster');
});

test('0.8.0 D: the list draws the checked types and explains the ones it hides', () => {
  const contacts = [{ name: 'cody', label: 'Cody', isDefault: false, hasAvatar: null }];
  const sessions = [
    { id: 'chat-1', profile: 'cody', source: 'desktop', preview: 'uma conversa', last_active: 1_700_000_500 },
    { id: 'oneshot-1', profile: 'cody', source: 'oneshot', preview: 'uma execução pontual', last_active: 1_700_000_400 },
    { id: 'cron-1', profile: 'cody', source: 'cron', title: 'Scholes - Daily Digest', last_active: 1_700_000_300 },
    { id: 'hook-1', profile: 'cody', source: 'webhook', title: 'GitHub hook', last_active: 1_700_000_200 },
  ];

  // The DEFAULT view: conversations only, cron/webhook nowhere in sight.
  const byDefault = buildRoster({ contacts, sessions: sessions as never[], expanded: ['cody'], sessionTypes: DEFAULT_SESSION_TYPES, now: 1_700_000_000_000 });
  const titles = byDefault.rows[0].sessions.map((hit) => hit.sessionId);
  assert.deepEqual(titles, ['chat-1', 'oneshot-1'], 'the conversations, and the unknown source with them');
  assert.equal(byDefault.rows[0].automatic.length, 0, 'no cron rows under the profile');
  assert.equal(byDefault.automaticSeen, 2, 'the runs were there…');
  assert.equal(byDefault.automaticHidden, 2, '…and the model says they are hidden, so the screen can say why');
  // The profile row's preview describes what is ON the list.
  assert.equal(byDefault.rows[0].preview, 'uma conversa');

  // Opting in brings them back — same column, marked automatic.
  const opted = buildRoster({ contacts, sessions: sessions as never[], expanded: ['cody'], sessionTypes: { sessions: true, automatic: true }, now: 1_700_000_000_000 });
  assert.equal(opted.rows[0].automatic.length, 2, 'cron and webhook runs are drawn');
  assert.equal(opted.automaticHidden, 0);

  // Conversations off, runs on: the mirror image, and the preview follows the visible set.
  const runsOnly = buildRoster({ contacts, sessions: sessions as never[], expanded: ['cody'], sessionTypes: { sessions: false, automatic: true }, now: 1_700_000_000_000 });
  assert.deepEqual(runsOnly.rows[0].sessions, [], 'no conversations drawn');
  assert.equal(runsOnly.rows[0].automatic.length, 2);
  assert.equal(runsOnly.rows[0].preview, '', 'and no conversation preview is advertised');

  // No opinion (the 0.7.0 call sites) still shows the runs: the filter is opt-in.
  const noOpinion = buildRoster({ contacts, sessions: sessions as never[], expanded: ['cody'], now: 1_700_000_000_000 });
  assert.equal(noOpinion.rows[0].automatic.length, 2);
  assert.equal(noOpinion.automaticHidden, 0, 'nothing is hidden unless the setting says so');
});

test('0.8.0 D: both checkboxes off is a legal state that names itself', () => {
  const off = { sessions: false, automatic: false };
  assert.equal(anySessionType(off), false);
  assert.equal(anySessionType({ sessions: true, automatic: false }), true);
  assert.deepEqual(
    sessionTypeChoices(off),
    [
      { id: 'sessions', enabled: false },
      { id: 'automatic', enabled: false },
    ],
    'the two rows Settings renders, in order',
  );
  assert.deepEqual(sessionTypeChoices(DEFAULT_SESSION_TYPES), [
    { id: 'sessions', enabled: true },
    { id: 'automatic', enabled: false },
  ]);
  const model = buildRoster({
    contacts: [{ name: 'cody', label: 'Cody', isDefault: false, hasAvatar: null }],
    sessions: [{ id: 'chat-1', profile: 'cody', source: 'desktop', preview: 'x', last_active: 1 }] as never[],
    expanded: ['cody'],
    sessionTypes: off,
    now: 1_700_000_000_000,
  });
  assert.deepEqual(model.rows[0].sessions, []);
  assert.equal(model.rows[0].automatic.length, 0);
  // The copy exists in BOTH tables, and says what to do — never a blank screen.
  for (const language of ['en', 'pt'] as const) {
    const table = stringsFor(language).roster.types;
    assert.ok(table.noneTitle.trim().length > 0, `${language}: the empty state has a title`);
    assert.ok(table.noneBody.trim().length > 0, `${language}: and an explanation`);
    assert.ok(table.noneAction.trim().length > 0, `${language}: and the way out`);
    assert.ok(table.hidden(2).length > 0);
  }
  assert.match(stringsFor('en').roster.types.noneTitle, /[Ss]ession types/);
  assert.match(stringsFor('pt').roster.types.noneTitle, /tipo de sessão/);
  const screen = readFileSync(join(process.cwd(), 'app', 'index.tsx'), 'utf8');
  assert.match(screen, /roster\.typesAllOff/, 'the roster screen renders that state');
  assert.match(screen, /t\.roster\.types\.noneTitle/, 'with the copy, not a literal');
});

test('0.8.0 D: search still reaches a session the type filter hides', () => {
  const contacts = [
    { name: 'cody', label: 'Cody', isDefault: false, hasAvatar: null },
    { name: 'scholes', label: 'Scholes', isDefault: false, hasAvatar: null },
  ];
  const sessions = [
    { id: 'chat-1', profile: 'cody', source: 'desktop', title: 'aaaa', preview: 'orçamento do plugin', last_active: 1_700_000_500 },
    { id: 'cron-1', profile: 'scholes', source: 'cron', title: 'orçamento diário', last_active: 1_700_000_300 },
  ];
  const search = searchRoster({ needle: 'orçamento', profiles: contacts, sessions: sessions as never[] });
  // Conversations OFF: the default view is empty, and the search still finds the conversation.
  const model = buildRoster({
    contacts,
    sessions: sessions as never[],
    expanded: [],
    search,
    sessionTypes: { sessions: false, automatic: true },
    now: 1_700_000_000_000,
  });
  const hits = model.rows.flatMap((row) => row.sessions.map((hit) => hit.sessionId));
  assert.deepEqual(hits, ['chat-1'], 'a hidden conversation is still reachable by search');
  // And the honest other half, stated as a test rather than left implicit: the run is NOT in the
  // search corpus, because `searchRoster` has only ever swept conversations (0.5.0 behaviour, pinned
  // by the `feed:` tests). Turning a type off therefore never REDUCES what search can find.
  assert.ok(!hits.includes('cron-1'), 'the cron run was never searchable, filter or no filter');
});

// ─────────────────── 0.8.0 E: slide a row left for archive and delete ──

test('0.8.0 E: the claim predicate — a tap never opens a row, a scroll is never eaten', () => {
  // The predicate the whole feature hangs on: horizontal AND clearly more horizontal than vertical.
  assert.equal(shouldClaim(0, 0), false, 'a tap');
  assert.equal(shouldClaim(3, 0), false, 'a twitch');
  assert.equal(shouldClaim(7, 0), false, 'just under the 8 dp floor');
  assert.equal(shouldClaim(9, 0), true, 'past the floor, with no vertical component');
  assert.equal(shouldClaim(-9, 0), true, 'either direction is claimed; only left opens');
  assert.equal(shouldClaim(6, 40), false, 'a vertical scroll steals nothing');
  assert.equal(shouldClaim(20, 20), false, '45° is a scroll, not a slide (20 < 1.2 × 20)');
  assert.equal(shouldClaim(25, 20), true, '25 > 24 and > 8 — claimed');
  assert.equal(SWIPE.claimDx, 8);
  assert.equal(SWIPE.claimRatio, 1.2);
  assert.equal(shouldClaim(SWIPE.claimRatio * 10, 10), false, 'the ratio is exclusive at the boundary');
  assert.equal(shouldClaim(SWIPE.claimRatio * 10 + 0.1, 10), true);
});

test('0.8.0 E: the drag is clamped to the reveal, and the release settles by distance or flick', () => {
  assert.equal(SWIPE.revealWidth, 152, 'two 76 dp buttons');
  assert.equal(SWIPE.revealWidth / 2, 76);
  assert.equal(clampDrag(0), 0);
  assert.equal(clampDrag(-50), -50);
  assert.equal(clampDrag(-300), -152, 'never past the buttons');
  assert.equal(clampDrag(40), 0, 'a right-drag cannot pull the row off its own left edge');
  assert.equal(restX(true), -152);
  assert.equal(restX(false), 0);

  assert.equal(settle(0, 0), 'closed', 'a tap settles closed');
  assert.equal(settle(-20, 0), 'closed', 'not far enough');
  assert.equal(settle(-60, 0), 'open', 'past 35% of the reveal');
  assert.equal(settle(-152, 0), 'open');
  assert.equal(settle(-10, -0.5), 'open', 'a left flick opens however short it was');
  assert.equal(settle(-140, 0.5), 'closed', 'a right flick closes however far it had gone');
  assert.equal(SWIPE.openThreshold, 0.35);
  // Released from an OPEN row: the base position is what counts, not the raw drag.
  assert.equal(settle(restX(true) + 140, 0), 'closed', 'dragged most of the way back');
  assert.equal(settle(restX(true) + 40, 0), 'open', 'dragged back a little');
});

test('0.8.0 E: exactly one row is open, and a fresh one is never armed', () => {
  let state = CLOSED_SWIPE;
  assert.equal(isOpen(state, 'a'), false);
  state = openRow(state, 'a');
  assert.equal(isOpen(state, 'a'), true);
  assert.equal(isOpen(state, 'b'), false);
  state = openRow(state, 'b');
  assert.equal(state.openId, 'b', 'opening another closes the first — one at a time');
  assert.equal(isOpen(state, 'a'), false);
  assert.equal(state.armedId, null, 'and a newly opened row starts un-armed');
  // Closing is scoped: a stale row cannot close a fresh one.
  assert.deepEqual(closeIfOpen(state, 'a'), state, 'a row that is not open closes nothing');
  assert.deepEqual(closeIfOpen(state, 'b'), CLOSED_SWIPE);
  assert.deepEqual(closeRow(), CLOSED_SWIPE, 'and a scroll closes everything');
});

test('0.8.0 E: delete is TWO steps — arm, then confirm — and arming keeps the row open', () => {
  let state = openRow(CLOSED_SWIPE, 'row-1');
  assert.equal(confirmDelete(state, 'row-1'), false, 'an un-armed tap can never delete');
  state = armDelete(state, 'row-1');
  assert.equal(isArmed(state, 'row-1'), true);
  assert.equal(state.openId, 'row-1', 'arming must NOT dismiss the swipe — the confirm stays visible');
  assert.equal(confirmDelete(state, 'row-1'), true, 'the second tap is the one that runs');
  // The armed state is escapable, three ways, and every one leaves the row shut or un-armed.
  assert.deepEqual(disarm(state), { openId: 'row-1', armedId: null }, 'back out, keep looking');
  assert.equal(isArmed(disarm(state), 'row-1'), false);
  assert.deepEqual(closeRow(), CLOSED_SWIPE, 'scroll away');
  assert.deepEqual(openRow(CLOSED_SWIPE, 'row-2').armedId, null, 'open another');
  // A confirm aimed at a row that is not armed, or not open, is refused.
  assert.equal(confirmDelete(armDelete(CLOSED_SWIPE, 'row-1'), 'row-2'), false, 'never the wrong row');
  assert.equal(confirmDelete({ openId: 'row-2', armedId: 'row-1' }, 'row-2'), false, 'open is not enough');
});

test('0.8.0 E: the gateway surface renders BOTH verbs disabled, with the real reason', () => {
  const archiveDash = actionAvailability('dashboard', 'archive');
  const deleteDash = actionAvailability('dashboard', 'delete');
  assert.deepEqual(archiveDash, { enabled: true, reason: '' }, 'the dashboard runs both');
  assert.deepEqual(deleteDash, { enabled: true, reason: '' });
  // The :9222 surface answers 501 for these two verbs (src/api/backend.ts), so the button says the
  // same sentence the call would have returned.
  const archiveGw = actionAvailability('gateway', 'archive');
  const deleteGw = actionAvailability('gateway', 'delete');
  assert.equal(archiveGw.enabled, false);
  assert.equal(deleteGw.enabled, false);
  assert.equal(archiveGw.reason, t.errors.archiveUnsupported);
  assert.equal(deleteGw.reason, t.errors.deleteUnsupported);
  // The suite runs in PT, so the reason is the PT sentence — and the EN table says the same thing.
  assert.equal(archiveGw.reason, stringsFor('pt').errors.archiveUnsupported, 'in the interface language');
  assert.match(stringsFor('en').errors.archiveUnsupported, /not supported/);
  assert.ok(archiveGw.reason.trim().length > 0, 'a disabled button always carries a reason');
  // And the accessibility list offers nothing it cannot do: an action that silently fails is the
  // one outcome this repo forbids.
  assert.deepEqual(rowAccessibilityActions('gateway'), []);
  const dash = rowAccessibilityActions('dashboard');
  assert.deepEqual(dash.map((action) => action.name), ['archive', 'delete']);
  assert.equal(dash[0].label, t.roster.swipe.archive);
  assert.equal(dash[1].label, t.roster.swipe.delete);
});

test('0.8.0 E: the buttons are red and blue from the palette, not from literals', () => {
  assert.equal(actionColour('archive', colors), colors.archive);
  assert.equal(actionColour('delete', colors), colors.red);
  // Pinned so a palette edit is visible: the archive blue is its own token, and distinct from the
  // accent, the red and the amber.
  assert.equal(colors.archive, '#1f6feb');
  assert.equal(colors.red, '#f85149');
  assert.notEqual(colors.archive, colors.accent, 'the archive blue is not the accent blue');
  assert.notEqual(colors.archive, colors.red);
  const src = readFileSync(join(process.cwd(), 'src', 'roster', 'components.tsx'), 'utf8');
  assert.match(src, /backgroundColor: colors\.archive/, "archive's own blue token");
  assert.match(src, /colors\.red/, 'the delete button reuses the destructive verb colour');
  assert.ok(!/backgroundColor: '#/.test(src), 'no colour literal in the row');
});

test('0.8.0 E: the row is a thin shell — PanResponder + Animated, and no new native dependency', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'roster', 'components.tsx'), 'utf8');
  assert.match(src, /PanResponder\.create/, 'core React Native, not a gesture library');
  assert.match(src, /new Animated\.Value/, 'core Animated');
  assert.match(src, /onMoveShouldSetPanResponder: \(_event, gesture\) => shouldClaim\(gesture\.dx, gesture\.dy\)/,
    'the claim predicate comes from the pure module');
  assert.match(src, /onPanResponderTerminationRequest: \(\) => false/, 'a claimed gesture is not stolen back');
  assert.match(src, /swipe\.ts|shouldClaim|clampDrag|settle/, 'every decision is delegated');
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  for (const banned of ['react-native-gesture-handler', 'react-native-reanimated']) {
    assert.ok(!(banned in pkg.dependencies), `${banned} must NOT be added for one horizontal reveal`);
  }
  // The screen owns the one-open-at-a-time state, and the list closes it on scroll.
  const screen = readFileSync(join(process.cwd(), 'app', 'index.tsx'), 'utf8');
  assert.match(screen, /useState<SwipeState>\(CLOSED_SWIPE\)/);
  assert.match(screen, /onScrollBeginDrag=\{\(\) => setSwipe\(CLOSED_SWIPE\)\}/, 'scrolling closes the open row');
  assert.match(screen, /confirmDelete\(swipe, rowKey\)/, "the confirm is the pure module gate");
  // ONE delete path and ONE archive path: the swipe calls the verbs the menu already calls.
  assert.match(screen, /roster\.deleteSession\(item\.model\.profile, item\.model\.id\)/);
  assert.match(screen, /roster\.archiveSession\(item\.model\.profile, item\.model\.id\)/);
  const hook = readFileSync(join(process.cwd(), 'src', 'roster', 'useRoster.ts'), 'utf8');
  assert.equal(hook.split('backend.deleteSession(').length - 1, 1, 'exactly one delete call site in the app');
  assert.equal(hook.split('backend.archiveSession(').length - 1, 2, 'archive-all loops, nothing else re-implements it');
  // The long-press menu stays: the verbs are reachable without a gesture either way.
  assert.match(src, /onLongPress=\{props\.onMenu\}/);
  assert.match(src, /accessibilityActions=\{rowAccessibilityActions\(props\.surface\)\}/);
});

// ─────────────────── 0.8.0 F: the sheet is not clipped at the bottom ──

test('0.8.0 F: sheetPadding() adds the device bottom inset to the padding it already had', () => {
  assert.equal(space.md, 12);
  assert.equal(sheetPadding({ bottom: 0 }), 12, 'a device with no reserved space: unchanged');
  assert.equal(sheetPadding(null), 12, 'no insets at all is not a crash and not a zero');
  assert.equal(sheetPadding(undefined), 12);
  assert.equal(sheetPadding({}), 12);
  assert.equal(sheetPadding({ bottom: 24 }), 36, 'a gesture-nav bar (24 dp): the last entry clears it');
  assert.equal(sheetPadding({ bottom: 48 }), 60, 'a three-line nav bar (48 dp)');
  assert.equal(sheetPadding({ bottom: TYPICAL_GESTURE_INSET }), 36);
  assert.equal(sheetPadding({ bottom: TYPICAL_BUTTON_INSET }), 60);
  assert.equal(sheetPadding({ bottom: -10 }), 12, 'junk in a negative inset cannot eat the padding');
  assert.equal(sheetPadding({ bottom: Number.NaN }), 12, 'nor can a NaN');
  // It is strictly additive and monotonically increasing — the property the fix rests on.
  for (const inset of [0, 8, 24, 48, 96]) {
    assert.ok(sheetPadding({ bottom: inset }) >= sheetPadding(null));
    assert.equal(sheetPadding({ bottom: inset }), 12 + inset);
  }
});

test('0.8.0 F: BOTH sheets share the fix, and only the entries scroll', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'roster', 'components.tsx'), 'utf8');
  // The shared style is what makes one fix cover ActionSheet AND PromptSheet.
  assert.equal(src.split('style={[styles.sheet, { paddingBottom: sheetPadding(insets) }]}').length - 1, 2,
    'ActionSheet and PromptSheet both pad by the inset');
  assert.equal(src.split('const insets = useSafeAreaInsets();').length - 1, 2, 'each reads the real insets');
  assert.match(src, /from '\.\/sheet'/, 'the arithmetic is the tested pure module');
  // A long list SCROLLS instead of clipping, and only the entries do: the title and the prompt's
  // actions stay where they are.
  assert.match(src, /<ScrollView style=\{styles\.sheetScroll\} bounces=\{false\}>/, 'the entries scroll');
  assert.match(src, /sheetScroll: \{ flexGrow: 0 \}/, 'a short list does not stretch the sheet');
  assert.match(src, /maxHeight: '80%'/, 'inside the sheet height it already had');
  const titleIdx = src.indexOf('<Text style={styles.sheetTitle} numberOfLines={1}>');
  const scrollIdx = src.indexOf('<ScrollView style={styles.sheetScroll}');
  assert.ok(titleIdx > 0 && scrollIdx > titleIdx, 'the title is NOT inside the ScrollView');
  const promptActions = src.indexOf('styles.promptActions');
  assert.ok(promptActions > src.indexOf('</ScrollView>'), "the prompt's buttons are NOT inside it either");
});

// ─────────────────── 0.8.0 G: the top buttons are 10% bigger ──

test('0.8.0 G: the three header glyphs scale by 1.1 from ONE constant', () => {
  const h = headerMetrics();
  assert.equal(HEADER_ICON_SCALE, 1.1);
  assert.equal(h.scale, HEADER_ICON_SCALE, 'the box and the glyphs read the same constant');
  assert.equal(h.add, 22, 'the "+" glyph: 20 → 22');
  assert.equal(h.expand, 18, 'expand: 16 → 18 (17.6, rounded to a legible whole number)');
  assert.equal(h.settings, 18, 'settings: 16 → 18');
  assert.equal(h.add, Math.round(20 * 1.1));
  assert.equal(h.expand, Math.round(16 * 1.1));
  assert.equal(h.expand, h.settings, 'the two 16 dp glyphs get one size, not two');
  // Bigger than they were, by design — and not by double.
  assert.ok(h.add > 20 && h.expand > 16);
  assert.ok(h.add < 30 && h.expand < 24);
});

test('0.8.0 G: the pressable box scales too, and the REAL touch target stays >= 44 x 44', () => {
  const h = headerMetrics();
  assert.equal(h.boxWidth, 42, '38 → 42, the same +10%');
  assert.equal(h.boxHeight, 37, '34 → 37');
  assert.ok(h.boxWidth > 38 && h.boxHeight > 34, 'the box grew with the glyph');
  // The glyphs are small; the touch area is not. `hitSlop` is what earns the floor, and `target` is
  // the arithmetic proof rather than a hope.
  assert.equal(MIN_TOUCH_TARGET, 44);
  assert.ok(h.target >= MIN_TOUCH_TARGET, `effective target ${h.target} must clear ${MIN_TOUCH_TARGET}`);
  assert.equal(h.hitSlop, Math.max(0, Math.ceil((MIN_TOUCH_TARGET - Math.min(h.boxWidth, h.boxHeight)) / 2)));
  assert.equal(h.boxHeight + h.hitSlop * 2, h.target);
  const src = readFileSync(join(process.cwd(), 'app', 'index.tsx'), 'utf8');
  assert.match(src, /const H = headerMetrics\(\)/, 'the screen takes its numbers from the module');
  assert.equal(src.split('hitSlop={H.hitSlop}').length - 1, 3, 'all three buttons inflate their target');
  assert.equal(src.split('{ width: H.boxWidth, height: H.boxHeight }').length - 1, 3, 'and all three scale');
  assert.match(src, /<Ionicons name="add" size=\{H\.add\}/);
  assert.match(src, /name=\{openSessions\.length \? 'contract-outline' : 'expand-outline'\} size=\{H\.expand\}/);
  assert.match(src, /<Ionicons name="settings-outline" size=\{H\.settings\}/);
  // No glyph is left on a literal: 20/16 would silently un-scale one of the three.
  assert.ok(!/size=\{20\}|size=\{16\}/.test(src), 'no header glyph keeps its old literal size');
});

// ─────────────────── 0.8.0 H: checkpoint notifications ──

/** A row as the dashboard serves it, with only the fields under test present. */
function snapshotRow(id: string, extra: Partial<CheckpointSession> = {}): CheckpointSession {
  return { id, profile: 'cody', title: `Sessão ${id}`, source: 'desktop', ...extra };
}

test('0.8.0 H: the surface says which checkpoints it can actually report', () => {
  // MEASURED on the live dashboard (2026-10-12): every recents row carries `is_active`, and NO row
  // carries `waiting` / `needs_input`. So "finished" is exactly knowable and "waiting" is not.
  const live = [snapshotRow('a', { is_active: true, last_active: 1_700_000_000 }), snapshotRow('b', { is_active: false })];
  const capability = surfaceCapability(live);
  assert.deepEqual(capability, { waiting: false, finished: true, basis: 'is_active' });

  // A surface that serves the waiting field (even as `false`) can report it.
  assert.equal(surfaceCapability([snapshotRow('a', { waiting: false })]).waiting, true);
  assert.equal(surfaceCapability([snapshotRow('a', { needs_input: false })]).waiting, true);
  assert.equal(surfaceCapability([snapshotRow('a', { needsInput: false })]).waiting, true);
  // A surface with neither cannot report "finished" exactly: the fallback basis is 'activity'.
  const bare = [snapshotRow('a', { last_active: 1 })];
  assert.deepEqual(surfaceCapability(bare), { waiting: false, finished: false, basis: 'activity' });
  assert.equal(capabilityOfSnapshot(snapshotOf(live)).basis, 'is_active');
  assert.deepEqual(surfaceCapability([]), { waiting: false, finished: false, basis: 'activity' });
});

test('0.8.0 H: a first poll baseline fires nothing, and then each transition fires once', () => {
  const first = snapshotOf([snapshotRow('a', { is_active: true, last_active: 1_700_000_000 })]);
  assert.deepEqual(detectCheckpoints({ previous: null, current: first, kinds: { waiting: true, finished: true } }), [],
    'nothing to compare on the first poll — no false alarm at startup');

  // The turn ends: is_active true → false, with last_active advanced. That is the exact "finished".
  const before = first;
  const after = snapshotOf([snapshotRow('a', { is_active: false, last_active: 1_700_000_900 })]);
  const events = detectCheckpoints({
    previous: before,
    current: after,
    kinds: { waiting: true, finished: true },
    capability: surfaceCapability([snapshotRow('a', { is_active: true })]),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'finished');
  assert.equal(events[0].sessionId, 'a');
  assert.equal(events[0].profile, 'cody');
  assert.equal(events[0].basis, 'is_active', 'the exact rule, not the fallback');

  // Dedupe: the same transition, seen again, is nothing.
  const seen = markNotified({}, events);
  assert.deepEqual(
    detectCheckpoints({ previous: before, current: after, kinds: { waiting: true, finished: true }, seen }),
    [],
    'the same (session, kind, last_active) never fires twice',
  );
  // A LATER checkpoint on the same session is a new key, and does fire.
  const later = snapshotOf([snapshotRow('a', { is_active: true, last_active: 1_700_001_000 })]);
  const finishedLater = snapshotOf([snapshotRow('a', { is_active: false, last_active: 1_700_001_900 })]);
  const second = detectCheckpoints({ previous: later, current: finishedLater, kinds: { waiting: true, finished: true }, seen });
  assert.equal(second.length, 1, 'a new last_active is a new checkpoint');
  assert.notEqual(second[0].key, events[0].key);
});

test('0.8.0 H: "still running" and "no change" are not checkpoints', () => {
  const active = snapshotRow('a', { is_active: true, last_active: 1_700_000_000 });
  const capability = surfaceCapability([active]);
  // Still running, nothing moved.
  assert.deepEqual(
    detectCheckpoints({ previous: snapshotOf([active]), current: snapshotOf([active]), kinds: { waiting: true, finished: true }, capability }),
    [],
  );
  // is_active went false but the activity did NOT advance: a stale flag, not a finished turn.
  const stale = snapshotOf([snapshotRow('a', { is_active: false, last_active: 1_700_000_000 })]);
  assert.deepEqual(detectCheckpoints({ previous: snapshotOf([active]), current: stale, kinds: { waiting: true, finished: true }, capability }), []);
  // A brand-new session is not a checkpoint either: there is no transition to have happened.
  const mixed = snapshotOf([snapshotRow('a', { is_active: true, last_active: 1_700_000_000 }), snapshotRow('new', { is_active: false, last_active: 1_700_000_500 })]);
  assert.deepEqual(detectCheckpoints({ previous: snapshotOf([active]), current: mixed, kinds: { waiting: true, finished: true }, capability }), []);
  // The kind switch is respected: nothing fires with both off, whatever happened.
  const after = snapshotOf([snapshotRow('a', { is_active: false, last_active: 1_700_000_900 })]);
  assert.deepEqual(detectCheckpoints({ previous: snapshotOf([active]), current: after, kinds: { waiting: false, finished: false }, capability }), []);
  assert.deepEqual(
    detectCheckpoints({ previous: snapshotOf([active]), current: after, kinds: { waiting: true, finished: false }, capability }),
    [],
    'the waiting switch does not turn on finished notifications',
  );
});

test('0.8.0 H: a waiting checkpoint fires, and only when the surface can see one', () => {
  const before = snapshotOf([snapshotRow('a', { waiting: false, last_active: 1_700_000_000 })]);
  const nowWaiting = snapshotOf([snapshotRow('a', { waiting: true, last_active: 1_700_000_100 })]);
  const capable = surfaceCapability([snapshotRow('x', { waiting: false })]);
  const events = detectCheckpoints({ previous: before, current: nowWaiting, kinds: { waiting: true, finished: true }, capability: capable });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'waiting');
  assert.equal(events[0].basis, 'is_active');
  // `needs_input` is the same state under the other name the dashboard uses.
  const needsInput = snapshotOf([snapshotRow('a', { needs_input: true, last_active: 1_700_000_100 })]);
  assert.equal(detectCheckpoints({ previous: before, current: needsInput, kinds: { waiting: true, finished: true }, capability: capable })[0].kind, 'waiting');
  // A surface that serves NO waiting field never reports one — asserted, so the Settings switch's
  // disabled-with-reason state rests on a fact rather than a hope.
  const blind = surfaceCapability([snapshotRow('a', { is_active: true })]);
  assert.deepEqual(
    detectCheckpoints({ previous: before, current: nowWaiting, kinds: { waiting: true, finished: true }, capability: blind }),
    [],
    'the live dashboard serves no `waiting` field, so this cannot fire there today',
  );
  // Already waiting in the previous poll is not a new checkpoint.
  assert.deepEqual(
    detectCheckpoints({ previous: nowWaiting, current: nowWaiting, kinds: { waiting: true, finished: true }, capability: capable }),
    [],
  );
});

test('0.8.0 H: the fallback basis is used, and named, when is_active is not served', () => {
  const before = snapshotOf([snapshotRow('a', { last_active: 1_700_000_000 })]);
  const after = snapshotOf([snapshotRow('a', { last_active: 1_700_000_900 })]);
  const bare = surfaceCapability([snapshotRow('a', { last_active: 1 })]);
  const events = detectCheckpoints({ previous: before, current: after, kinds: { waiting: true, finished: true }, capability: bare });
  assert.equal(events.length, 1, 'new activity still tells the user something happened');
  assert.equal(events[0].basis, 'activity', 'and the event says WHICH rule fired');
  // The copy differs, so the app can never claim "finished" on a surface that cannot see it.
  const content = notificationFor(events[0]);
  assert.equal(content.body, t.notify.activityBody('Sessão a'));
  assert.notEqual(content.body, t.notify.finishedBody('Sessão a'));
});

test('0.8.0 H: the thread on screen is suppressed, and so is a hidden session type', () => {
  const before = snapshotOf([
    snapshotRow('open', { is_active: true, last_active: 1_700_000_000 }),
    snapshotRow('other', { is_active: true, last_active: 1_700_000_000 }),
    snapshotRow('cron-1', { source: 'cron', is_active: true, last_active: 1_700_000_000 }),
  ]);
  const after = snapshotOf([
    snapshotRow('open', { is_active: false, last_active: 1_700_000_900 }),
    snapshotRow('other', { is_active: false, last_active: 1_700_000_900 }),
    snapshotRow('cron-1', { source: 'cron', is_active: false, last_active: 1_700_000_900 }),
  ]);
  const capability = surfaceCapability([snapshotRow('a', { is_active: true })]);
  // Phase D's filter: automatic runs are OFF by default, so a cron run never notifies.
  const withTypes = detectCheckpoints({
    previous: before,
    current: after,
    kinds: { waiting: true, finished: true },
    types: DEFAULT_SESSION_TYPES,
    capability,
  });
  assert.deepEqual(withTypes.map((event) => event.sessionId), ['open', 'other'], 'the cron run is silent');
  // …and with the type switched ON it does notify, so the silence above is the filter and not a bug.
  assert.deepEqual(
    detectCheckpoints({ previous: before, current: after, kinds: { waiting: true, finished: true }, types: { sessions: true, automatic: true }, capability })
      .map((event) => event.sessionId),
    ['cron-1', 'open', 'other'],
  );
  // The thread being read right now is suppressed.
  assert.deepEqual(
    detectCheckpoints({ previous: before, current: after, kinds: { waiting: true, finished: true }, types: DEFAULT_SESSION_TYPES, openThreadId: 'open', capability })
      .map((event) => event.sessionId),
    ['other'],
  );
});

test('0.8.0 H: the watermark is capped, pruned by age, and survives as data alone', () => {
  const now = 1_700_000_000_000;
  const fresh: Watermark = { a: now - 1000, b: now - 2000 };
  assert.deepEqual(markNotified(fresh, [], now), fresh, 'nothing notified, nothing changed');
  const old = now - 30 * 24 * 60 * 60 * 1000;
  assert.deepEqual(pruneWatermark({ a: now - 1000, stale: old }, now), { a: now - 1000 }, 'a 30-day-old entry is gone');
  assert.equal(WATERMARK_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  const many: Watermark = {};
  for (let i = 0; i < WATERMARK_MAX_ENTRIES + 50; i += 1) many[`k${i}`] = now - i;
  const capped = pruneWatermark(many, now);
  assert.equal(Object.keys(capped).length, WATERMARK_MAX_ENTRIES, 'the map cannot grow without bound');
  assert.ok('k0' in capped, 'the newest survives');
  assert.ok(!(`k${WATERMARK_MAX_ENTRIES + 49}` in capped), 'the oldest is dropped first');
  // The key is (sessionId, kind, last_active) — three parts, so two kinds never collide.
  assert.notEqual(checkpointKey('a', 'waiting', 1), checkpointKey('a', 'finished', 1));
  assert.equal(checkpointKey('a', 'finished', 1), checkpointKey('a', 'finished', 1), 'and it is stable');
  assert.equal(activityMs(1_700_000_000), 1_700_000_000_000, 'epoch seconds become ms');
  assert.equal(activityMs(1_700_000_000_000), 1_700_000_000_000, 'ms stays ms');
  assert.equal(activityMs(null), null);
});

test('0.8.0 H: the watcher is single-flight, foreground-only, and resumes at once', async () => {
  let foreground = true;
  const skips: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let resolves: (() => void)[] = [];
  const scheduled: { run: () => void; ms: number }[] = [];
  let cancelled = 0;

  const watcher = createCheckpointWatcher({
    poll: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => resolves.push(resolve));
      inFlight -= 1;
    },
    isForeground: () => foreground,
    intervalMs: DEFAULT_POLL_MS,
    schedule: (run, ms) => {
      scheduled.push({ run, ms });
      return () => {
        cancelled += 1;
      };
    },
    onSkip: (reason) => skips.push(reason),
  });

  assert.equal(DEFAULT_POLL_MS, 30_000, 'a 30 s poll, not a tight loop');
  assert.equal(watcher.running, false);
  await watcher.tick();
  assert.equal(watcher.polls, 0, 'nothing polls before start()');
  assert.deepEqual(skips, ['stopped']);

  /** Let the promise chain settle without a fake clock: a few microtask turns is enough. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  watcher.start();
  assert.equal(watcher.running, true);
  assert.equal(watcher.polls, 1, 'start() polls at once, so the user never waits 30 s for the first pass');
  // While that pass is still in flight, two more ticks are refused: single-flight.
  await watcher.tick();
  await watcher.tick();
  assert.equal(watcher.polls, 1, 'one fetch, however many ticks arrive');
  assert.deepEqual(skips.slice(1), ['inflight', 'inflight']);
  assert.equal(scheduled.length, 0, 'and the next timer is only armed once a pass settles');
  resolves.shift()?.();
  await flush();
  assert.equal(maxInFlight, 1, 'two polls never overlap');
  assert.equal(scheduled.length, 1, 'the chain arms exactly ONE timer for the next pass');
  assert.equal(scheduled[0].ms, DEFAULT_POLL_MS, '30 s later, not immediately');

  // Backgrounded: no poll at all, and the chain goes DORMANT — the armed timer is allowed to fire,
  // the pass refuses, and nothing re-arms behind the app's back.
  foreground = false;
  const armedBefore = scheduled.length;
  await watcher.tick();
  assert.equal(watcher.polls, 1, 'nothing polls while the app is in the background');
  assert.deepEqual(skips[skips.length - 1], 'background');
  assert.equal(scheduled.length, armedBefore, 'and a refused pass does not arm another timer');

  // Back in the foreground: resume polls IMMEDIATELY rather than waiting another 30 s, and the chain
  // picks itself back up.
  foreground = true;
  void watcher.resume();
  await flush();
  assert.equal(watcher.polls, 2, 'resume is an immediate pass');
  assert.equal(scheduled.length, armedBefore, 'the chain re-arms once that pass settles, not before');
  resolves.shift()?.();
  await flush();
  assert.equal(scheduled.length, armedBefore + 1, 'and then the chain is running again');
  watcher.stop();
  assert.equal(watcher.running, false);
  const afterStop = cancelled;
  await watcher.tick();
  assert.equal(watcher.polls, 2, 'and a stopped watcher is silent');
  assert.ok(cancelled >= afterStop, 'with its pending timer cancelled');
});

test('0.8.0 H: the permission is three states, and only the master switch asks', () => {
  assert.equal(permissionStateOf(null), 'not-asked');
  assert.equal(permissionStateOf(undefined), 'not-asked');
  assert.equal(permissionStateOf({ granted: true }), 'granted');
  assert.equal(permissionStateOf({ status: 'granted' }), 'granted');
  assert.equal(permissionStateOf({ status: 'undetermined', canAskAgain: true }), 'not-asked');
  assert.equal(permissionStateOf({ status: 'denied', canAskAgain: true }), 'not-asked', 'it can still be asked');
  assert.equal(permissionStateOf({ status: 'denied', canAskAgain: false }), 'denied', 'a real block');
  assert.equal(permissionLabel('granted'), t.notify.granted);
  assert.equal(permissionLabel('denied'), t.notify.denied);
  assert.equal(permissionLabel('not-asked'), t.notify.notAsked);
  // Nothing at all is wanted until the master switch is on — that is what keeps the permission
  // unasked at cold start and the poll stopped.
  assert.deepEqual(DEFAULT_NOTIFY, { enabled: false, waiting: true, finished: true });
  assert.equal(notificationsWanted(DEFAULT_NOTIFY), false);
  assert.equal(notificationsWanted({ enabled: true, waiting: false, finished: false }), false, 'both kinds off = silent');
  assert.equal(notificationsWanted({ enabled: true, waiting: true, finished: false }), true);
  // A 0.7.0 blob has no `notifications` key and must load as OFF, per field.
  assert.deepEqual(normalizeNotify(undefined), { enabled: false, waiting: true, finished: true });
  assert.deepEqual(normalizeNotify({ enabled: true }), { enabled: true, waiting: true, finished: true });
  assert.deepEqual(normalizeNotify('junk'), { enabled: false, waiting: true, finished: true });
  assert.deepEqual(normalizeNotify({ finished: false }), { enabled: false, waiting: true, finished: false });
});

test('0.8.0 H: the app wires it — channel, handler, tap-to-open, and no "push" anywhere', () => {
  const layout = readFileSync(join(process.cwd(), 'app', '_layout.tsx'), 'utf8');
  assert.match(layout, /installHandler\(\)/, 'the presentation handler is installed once');
  assert.match(layout, /ensureChannel\(\)/, 'and the Android channel with it');
  assert.match(layout, /onResponse\(/, 'a tapped notification is handled');
  assert.match(layout, /pathname: '\/thread\/\[id\]', params: \{ id: sessionId, profile \}/, 'and opens that session');
  assert.match(layout, /useCheckpoints\(\{ openThreadId \}\)/, 'the watcher runs from the layout, once');
  assert.match(layout, /usePathname\(\)/, 'the thread being read comes from the route');
  const native = readFileSync(join(process.cwd(), 'src', 'notifications.ts'), 'utf8');
  assert.match(native, /shouldShowBanner: true/, 'SDK 57 renamed the presentation keys: read the installed types');
  assert.match(native, /shouldShowList: true/);
  assert.ok(!/shouldShowAlert/.test(native), 'the deprecated key is not used');
  assert.match(native, /AndroidImportance\.HIGH/, 'high importance, so it is a heads-up warning');
  assert.match(native, /trigger: null/, 'shown now, never scheduled for later');
  assert.equal(native.split("import * as Notifications").length - 1, 1, 'one module owns the native API');
  // Settings asks from the master switch, and the hook only ever reads.
  const screen = readFileSync(join(process.cwd(), 'app', 'settings.tsx'), 'utf8');
  assert.match(screen, /askPermission\(\)/, 'the request lives behind the switch');
  assert.match(screen, /readPermission\(\)/, 'and the state is read on open');
  assert.match(screen, /disabled=\{!capability\.waiting\}/, 'a kind this surface cannot report is off-with-reason');
  assert.match(screen, /t\.notify\.waitingUnavailable/, 'and carries the reason');
  const hook = readFileSync(join(process.cwd(), 'src', 'useCheckpoints.ts'), 'utf8');
  assert.ok(!/askPermission/.test(hook), 'the hook NEVER asks for a permission');
  assert.ok(!/getPermissionsAsync|requestPermissionsAsync/.test(hook), 'nor touches the native permission API');
  assert.match(hook, /surfaceCapability\(rows\)/, 'the capability comes from the rows actually served');
  // §5: device-side notifications must never be described as "push". What is scanned for is the
  // CLAIM ("push notification(s) ..."), not the word: prose that says this is not push, or that
  // closed-app delivery would need FCM, is the honest part and stays. (`router.push(...)` is the
  // navigation API, not a claim about delivery.)
  const words = ['src/notifications.ts', 'src/logic/checkpoints.ts', 'src/useCheckpoints.ts', 'src/i18n.ts'];
  for (const file of words) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    for (const line of source.split('\n')) {
      if (!/push[-\s]notifications?\b/i.test(line)) continue;
      if (/\bnot\b|\bnever\b|nothing|\bno\b|isn't/i.test(line)) continue;
      assert.fail(`${file}: device-side notifications called "push": ${line.trim().slice(0, 90)}`);
    }
  }
  // The dependency is expo-notifications, installed to match the SDK — and no gesture library crept
  // in beside it.
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.match(pkg.dependencies['expo-notifications'] ?? '', /^~57\./, 'installed for SDK 57');
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'app.json'), 'utf8')) as {
    expo: { android: { permissions: string[] }; plugins: unknown[] };
  };
  assert.ok(manifest.expo.android.permissions.includes('android.permission.POST_NOTIFICATIONS'));
  assert.ok(manifest.expo.plugins.some((plugin) => plugin === 'expo-notifications'), 'the config plugin is declared');
});

test('f1: only `false` suppresses the probe (the live flag is null, not false)', () => {
  assert.equal(shouldProbeAvatar(false), false, 'a definite no is a no');
  assert.equal(shouldProbeAvatar(null), true, 'unknown is worth one background attempt');
  assert.equal(shouldProbeAvatar(undefined), true);
  assert.equal(shouldProbeAvatar(true), true);
});

test('f1: a data URL is validated before it reaches <Image>', () => {
  assert.ok(isImageDataUrl(PNG));
  assert.equal(parseAvatarDataUrl(PNG)?.mime, 'image/png');
  assert.equal(parseAvatarDataUrl('https://example.com/a.png'), null);
  assert.equal(parseAvatarDataUrl('data:text/plain;base64,aGk='), null);
  assert.equal(parseAvatarDataUrl(null), null);
});

test('f1: one fetch per profile per size per session, memory + store behind it', async () => {
  const written: Record<string, string> = {};
  const store = {
    getItem: async (key: string) => written[key] ?? null,
    setItem: async (key: string, value: string) => {
      written[key] = value;
    },
  };
  let calls = 0;
  const cache = createAvatarCache({ store });
  const fetchOnce = async () => {
    calls += 1;
    return PNG;
  };

  assert.equal(await cache.load('cody', 28, fetchOnce), PNG);
  assert.equal(await cache.load('cody', 28, fetchOnce), PNG, 'second load is served from memory');
  assert.equal(calls, 1, 'exactly one network call');
  assert.equal(written[avatarKey('cody', 28)], PNG, 'and it is persisted for the next session');

  // A different size is a different entry.
  await cache.load('cody', 40, fetchOnce);
  assert.equal(calls, 2);

  // A settled miss is not retried in the same session.
  let misses = 0;
  const missing = createAvatarCache({});
  assert.equal(await missing.load('beta', 28, async () => { misses += 1; return null; }), null);
  assert.equal(await missing.load('beta', 28, async () => { misses += 1; return null; }), null);
  assert.equal(misses, 1, 'a definitive miss is remembered for the session');
});

test('f1: warm() serves a previous session from the store without touching the network', async () => {
  const store = {
    getItem: async () => PNG,
    setItem: async () => undefined,
  };
  let calls = 0;
  const cache = createAvatarCache({ store });
  await cache.warm('marv', 28);
  assert.equal(cache.peek('marv', 28), PNG);
  assert.equal(await cache.load('marv', 28, async () => { calls += 1; return null; }), PNG);
  assert.equal(calls, 0, 'a warm cache never fetches');
});

test('f1: a broken fetcher or junk payload degrades to the monogram, never to an error', async () => {
  const cache = createAvatarCache({});
  assert.equal(await cache.load('x', 28, async () => { throw new Error('rede caiu'); }), null);
  assert.equal(await cache.load('y', 28, async () => 'não é uma imagem'), null);
});

// ─────────────────────────────────── F4: the title chain ──

test('f4: the title chain is param -> loaded -> id, and a raw id is flagged', () => {
  assert.deepEqual(threadTitle({ param: 'Do telefonema', loaded: 'antigo', id: '20261011_122354' }), {
    title: 'Do telefonema',
    isId: false,
  });
  assert.deepEqual(threadTitle({ param: '', loaded: 'Do servidor', id: '20261011_122354' }), {
    title: 'Do servidor',
    isId: false,
  });
  assert.deepEqual(threadTitle({ param: '', loaded: '', id: '20261011_122354' }), {
    title: '20261011_122354',
    isId: true,
  });
  // The acceptance rule, stated as a test: an id is only ever rendered when no title exists.
  const withTitle = threadTitle({ param: 'Nome', loaded: '', id: 'abc' });
  assert.notEqual(withTitle.title, 'abc');
  assert.equal(withTitle.isId, false);
});


// ─────────────────────────────────── P7: the export log ──

test('p7: a known secret cannot appear in an exported log', () => {
  const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  addSecret(secret);
  const log = createLog();
  log.info('auth', `bearer ${secret} usado`);
  log.error('api', `GET /api/profiles?ticket=${secret} → 401`);
  log.info('ws', `Authorization: Bearer ${secret}`);
  const doc = buildLogDocument(
    { appVersion: '0.4.0', versionCode: '4', surface: 'dashboard', baseUrl: 'http://10.0.0.15:9119' },
    'o rail não carrega',
    log.entries,
  );
  assert.ok(!doc.includes(secret), 'the live secret must never be written');
  assert.ok(doc.includes('[REDACTED]'));
  assert.ok(doc.includes('o rail não carrega'), 'the description lands in the file');
});

test('p7: headers, tickets and tokens are redacted by pattern, not only by value', () => {
  assert.match(redact('Authorization: Bearer abcdef0123456789'), /\[REDACTED\]/);
  assert.match(redact('GET /api/ws?ticket=Zx9Yw8Vu7Tt6Ss5Rr4Qq3Pp2Oo1'), /ticket=\[REDACTED\]/);
  assert.match(redact('{"access_token":"eyJhbGciOi.payload.sig"}'), /\[REDACTED\]/);
  assert.match(redact('token=segredo123'), /token=\[REDACTED\]/);
  assert.equal(redact('nada para esconder'), 'nada para esconder');
});

test('p7: the ring buffer is capped and the document carries the context', () => {
  const log = createLog({ limit: 3, now: () => 1_700_000_000_000 });
  for (let i = 0; i < 5; i += 1) log.info('ui', `linha ${i}`);
  assert.equal(log.entries.length, 3, 'a capped ring buffer, not an unbounded file');
  assert.equal(log.entries[0].message, 'linha 2');

  log.call({ method: 'GET', path: '/api/sessions/abc/messages', status: 200, ms: 42 });
  log.call({ method: 'POST', path: '/api/auth/ws-ticket', status: 401, ms: 9 });
  const doc = buildLogDocument(
    {
      appVersion: '0.4.0', versionCode: '4', surface: 'dashboard',
      baseUrl: 'http://10.0.0.15:9119', activeRoute: 'http://10.0.0.15:9119',
      routes: [{ url: 'http://10.0.0.15:9119', role: 'lan', priority: 0 }],
      tailscale: 'ligado', deviceOs: 'android 34', failures: ['HTTP 401 em /api/auth/ws-ticket'],
    },
    '', log.entries,
  );
  assert.match(doc, /0\.4\.0 \(versionCode 4\)/);
  assert.match(doc, /GET \/api\/sessions\/abc\/messages → 200 em 42 ms/);
  assert.match(doc, /\[warn\] api: POST \/api\/auth\/ws-ticket → 401 em 9 ms/);
  assert.match(doc, /Rotas candidatas/);
  assert.match(doc, /Últimas falhas:/);
  assert.match(doc, /android 34/);
  assert.ok(!/Authorization/i.test(doc), 'the header never writes an auth header of its own');
});

// ─────────────────────────────────────────────────────────── client ──
const KEY = 'test-key-123';
const BAD_URL_PORT = 8799;

function settingsFor(url: string, overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, baseUrl: url, apiKey: KEY, profiles: [], model: '', routes: [], ...overrides };
}

async function main(): Promise<void> {
  const gateway = createMockGateway({ port: 8791, key: KEY, profileKey: 'profile-key-9', servedProfiles: ['cody'] });
  await gateway.listen();
  const api = createApi(settingsFor(gateway.url), { transport: nodeTransport });

  test('client: GET /v1/health returns version (no key needed)', async () => {
    const health = await createApi(settingsFor(gateway.url), { transport: nodeTransport }).health();
    assert.equal(health.status, 'ok');
    assert.equal(health.platform, 'hermes-agent');
    assert.equal(health.version, '0.21.5-mock');
  });

  test('client: GET /api/sessions maps the list envelope', async () => {
    const page = await api.listSessions();
    assert.equal(page.object, 'list');
    assert.equal(page.data.length, 2);
    assert.equal(page.data[0].id, 'sess-1');
    assert.equal(page.data[0].message_count, 4);
    assert.equal(page.data[0].pinned, false);
  });

  test('client: GET messages returns rows and pagination', async () => {
    const history = await api.messages('sess-1');
    assert.equal(history.data.length, 4);
    assert.equal(history.pagination?.order, 'latest');
    assert.equal(history.data[0].role, 'user');
    assert.equal(contentToText(history.data[1].content), 'Olá! Como posso ajudar?');
  });

  test('client: messages sends order=latest with an explicit limit', async () => {
    gateway.calls.length = 0;
    await api.messages('sess-1');
    const call = gateway.calls.find((c) => c.path.endsWith('/messages'));
    assert.ok(call, 'the messages call reached the mock');
    // Without an explicit order the server's default page flips to the OLDEST rows; the client
    // must always ask for the newest page explicitly.
    assert.match(call!.query, /order=latest/);
    assert.match(call!.query, /limit=200/);
  });

  test('client: POST /api/sessions creates and returns a session', async () => {
    const created = await api.createSession('Nova conversa');
    assert.equal(created.object, 'hermes.session');
    assert.equal(created.session.title, 'Nova conversa');
    assert.ok(created.session.id.startsWith('api_mock_'));
  });

  test('client: a 400 from the server surfaces the server message', async () => {
    await expectApiError(
      () => api.createSession('colide'),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'invalid_title');
        assert.match(error.message, /Title already in use/);
      },
    );
  });

  test('client: a wrong key is a specific 401, not a silent failure', async () => {
    const bad = createApi(settingsFor(gateway.url, { apiKey: 'nope' }), { transport: nodeTransport });
    await expectApiError(
      () => bad.listSessions(),
      (error) => {
        assert.equal(error.isAuth, true);
        assert.equal(error.code, 'gateway_auth_failed');
        assert.match(error.message, /chave de API/i);
        assert.match(error.message, /401/);
      },
    );
  });

  test('client: an unconfigured base URL is refused before any request', async () => {
    const empty = createApi(settingsFor(''), { transport: nodeTransport });
    await expectApiError(
      () => empty.listSessions(),
      (error) => {
        assert.equal(error.kind, 'config');
        assert.match(error.message, /Falta o endereço/);
      },
    );
    const noKey = createApi(settingsFor(gateway.url, { apiKey: '' }), { transport: nodeTransport });
    await expectApiError(
      () => noKey.listSessions(),
      (error) => {
        assert.equal(error.kind, 'config');
        assert.match(error.message, /Falta a chave/);
      },
    );
  });

  test('client: a malformed base URL names the value and the fix', async () => {
    const bad = createApi(settingsFor('100.64.0.5:8642'), { transport: nodeTransport });
    await expectApiError(
      () => bad.listSessions(),
      (error) => {
        assert.equal(error.kind, 'config');
        assert.match(error.message, /não é válido/);
        assert.match(error.message, /http:\/\//);
      },
    );
  });

  test('client: an unreachable gateway is a network error with the detail', async () => {
    const down = createApi(settingsFor(`http://127.0.0.1:${BAD_URL_PORT}`), { transport: nodeTransport, timeoutMs: 4000 });
    await expectApiError(
      () => down.listSessions(),
      (error) => {
        assert.equal(error.kind, 'network');
        assert.match(error.message, /Não foi possível contactar/);
      },
    );
  });

  test('client: a missing session is a 404 with the id in the message', async () => {
    await expectApiError(
      () => api.messages('nao-existe'),
      (error) => {
        assert.equal(error.status, 404);
        assert.match(error.message, /não existe no gateway/);
      },
    );
  });

  test('client: an unknown profile is a 404 from the prefix middleware, never a silent default', async () => {
    const scoped = createApi(settingsFor(gateway.url, { apiKey: 'profile-key-9' }), { transport: nodeTransport });
    await expectApiError(
      () => scoped.health('perfil-inexistente'),
      (error) => {
        assert.equal(error.status, 404);
        // The bare-string envelope of api_server.py:1726 must still reach the user.
        assert.match(error.message, /Unknown or unconfigured profile/);
      },
    );
  });

  test('client: the profile prefix routes to /p/<profile>/…', async () => {
    const scoped = createApi(settingsFor(gateway.url, { apiKey: 'profile-key-9' }), { transport: nodeTransport });
    gateway.calls.length = 0;
    const page = await scoped.listSessions('cody');
    const call = gateway.calls.find((c) => c.path === '/api/sessions');
    assert.ok(call, 'the prefixed call reached the mock');
    assert.equal(call!.profile, 'cody');
    assert.equal(page.object, 'list');
  });

  test('client: a profile with no scoped key gets the profile-specific 401', async () => {
    const scoped = createApi(settingsFor(gateway.url, { apiKey: KEY }), { transport: nodeTransport });
    await expectApiError(
      () => scoped.listSessions('cody'),
      (error) => {
        assert.equal(error.isAuth, true);
        assert.match(error.message, /perfil "cody"/);
      },
    );
  });

  // ─────────────────────────────────────────────────────── streaming ──
  test('stream: assembles deltas into the final reply and closes on done', async () => {
    let text = '';
    let final = '';
    let closed: { aborted: boolean } | null = null;
    const errors: ApiError[] = [];
    const events: string[] = [];
    const done = new Promise<void>((resolve) => {
      api.chatStream('sess-1', 'olá', {
        onEvent: (name) => events.push(name),
        onDelta: (delta) => {
          text += delta;
        },
        onFinal: (content) => {
          final = content;
        },
        onError: (error) => {
          errors.push(error);
          resolve();
        },
        onClose: (info) => {
          closed = info;
          resolve();
        },
      });
    });
    await done;
    assert.equal(errors.length, 0, `unexpected stream error: ${errors[0]?.message}`);
    assert.equal(text, 'Olá! Aqui está a resposta.');
    assert.equal(final, 'Olá! Aqui está a resposta.');
    assert.deepEqual(closed, { aborted: false });
    assert.ok(events.includes('run.started'));
    assert.ok(events.includes('message.started'));
    assert.ok(events.includes('run.completed'));
    assert.ok(events.includes('done'));
    assert.equal(events.filter((e) => e === 'assistant.delta').length, 3);
  });

  test('stream: stop aborts mid-flight and reports it', async () => {
    let deltas = 0;
    let closedAborted: boolean | null = null;
    let handle: { close: () => void } | null = null;
    await new Promise<void>((resolve, reject) => {
      handle = api.chatStream('sess-1', 'olá', {
        onDelta: () => {
          deltas += 1;
          handle?.close();
        },
        onError: () => undefined,
        onClose: (info) => {
          closedAborted = info.aborted;
          resolve();
        },
      });
      setTimeout(() => reject(new Error('abort did not close the stream')), 4000);
    });
    assert.equal(closedAborted, true);
    assert.ok(deltas >= 1, 'at least one delta arrived before the stop');
    assert.ok(deltas <= 3, 'the stop happened before the stream finished');
  });

  test('stream: a 500 surfaces an ApiError, and the blocking fallback still answers', async () => {
    const streamError = await new Promise<ApiError>((resolve) => {
      api.chatStream('sess-1', 'provoca erro de stream', {
        onError: (error) => resolve(error),
        onClose: () => undefined,
      });
    });
    assert.equal(streamError.kind, 'http');
    assert.equal(streamError.status, 500);
    const fallback = await api.chatOnce('sess-1', 'provoca erro de stream');
    assert.equal(fallback.message?.role, 'assistant');
    assert.match(String(fallback.message?.content), /Resposta em bloco a: provoca erro de stream/);
  });

  // ─────────────────────────────── xhr transport (the one the phone actually runs) ──
  // Regression tests for the spurious-error / double-send defect.
  //
  // The stream closes itself after the `done` frame, and react-native's abort() resets status to 0
  // and fires readystatechange SYNCHRONOUSLY at readyState 4. Without the `!aborted` guard in
  // src/api/transport.ts, that self-inflicted abort was reported as `HTTP 0` and the thread's error
  // branch re-sent the user's message through chatOnce() on EVERY successful turn.
  //
  // nodeTransport's abort() does not behave that way, so the three tests below drive a stubbed
  // XMLHttpRequest (tests/rnXhr.ts) instead. That transport difference is exactly why 40/40 tests,
  // tsc and expo-doctor all missed it.

  test('xhr: a completed stream raises NO error on its own abort', async () => {
    const restore = installRnXhr({ chunks: SSE_OK });
    try {
      const xhrApi = createApi(settingsFor('http://gateway.invalid:8642'), { transport: xhrTransport });
      const errors: ApiError[] = [];
      let final = '';
      let closed: { aborted: boolean } | null = null;
      await new Promise<void>((resolve) => {
        xhrApi.chatStream('sess-1', 'olá', {
          onFinal: (content) => {
            final = content;
          },
          onError: (error) => {
            errors.push(error);
          },
          onClose: (info) => {
            closed = info;
            resolve();
          },
        });
      });
      assert.equal(final, 'Olá');
      assert.equal(errors.length, 0, `spurious stream error: ${errors[0]?.message}`);
      assert.deepEqual(closed, { aborted: false });
    } finally {
      restore();
    }
  });

  test('xhr: a non-200 response still raises a real HTTP error', async () => {
    const restore = installRnXhr({ status: 500, body: 'boom' });
    try {
      const xhrApi = createApi(settingsFor('http://gateway.invalid:8642'), { transport: xhrTransport });
      const error = await new Promise<ApiError>((resolve, reject) => {
        xhrApi.chatStream('sess-1', 'olá', {
          onError: (e) => resolve(e),
          onClose: () => reject(new Error('closed without raising on a 500')),
        });
      });
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 500);
    } finally {
      restore();
    }
  });

  test('xhr: the Stop button closes without raising an error', async () => {
    const restore = installRnXhr({ chunks: SSE_OK });
    try {
      const xhrApi = createApi(settingsFor('http://gateway.invalid:8642'), { transport: xhrTransport });
      const errors: ApiError[] = [];
      let closedAborted: boolean | null = null;
      let handle: { close: () => void } | null = null;
      await new Promise<void>((resolve, reject) => {
        handle = xhrApi.chatStream('sess-1', 'olá', {
          onDelta: () => {
            handle?.close();
          },
          onError: (error) => {
            errors.push(error);
          },
          onClose: (info) => {
            closedAborted = info.aborted;
            resolve();
          },
        });
        setTimeout(() => reject(new Error('stop did not close the stream')), 4000);
      });
      assert.equal(errors.length, 0, `unexpected error on stop: ${errors[0]?.message}`);
      assert.equal(closedAborted, true);
    } finally {
      restore();
    }
  });

  // ─────────────────────────────────────────────────────── roster ──
  test('roster: contacts are the gateway profile plus the ones from Settings', () => {
    const contacts = contactsOf(settingsFor('http://x', { profiles: ['cody', 'vintage'] }));
    assert.deepEqual(contacts.map((c) => c.label), ['Principal', 'cody', 'vintage']);
    assert.deepEqual(contacts.map((c) => c.prefix), ['', '/p/cody', '/p/vintage']);
    assert.equal(contacts[0].isPrimary, true);
  });

  test('roster: a session without a title shows its id, never an invented name', () => {
    const row = toRow({ id: 'sess-9', title: '', last_active: Date.now() / 1000 - 120 }, 0);
    assert.equal(row.title, 'sess-9');
    assert.equal(row.preview, '');
  });

  test('roster: rows carry a DD-MM-YYYY date and a new flag against last-seen', () => {
    const now = Date.UTC(2026, 8, 25, 12, 0, 0);
    const row = toRow({ id: 's', title: 'A', last_active: now / 1000 }, now - 1000);
    assert.equal(row.date, '25-09-2026');
    assert.equal(row.isNew, true);
    assert.equal(toRow({ id: 's', title: 'A', last_active: now / 1000 }, now).isNew, false);
  });

  test('roster: grouping puts the newest day first and repeats its own header', () => {
    const rows = [
      toRow({ id: 'a', title: 'a', last_active: Date.UTC(2026, 8, 25) / 1000 }, 0),
      toRow({ id: 'b', title: 'b', last_active: Date.UTC(2026, 8, 26) / 1000 }, 0),
      toRow({ id: 'c', title: 'c', last_active: Date.UTC(2026, 8, 25) / 1000 }, 0),
    ];
    const groups = groupByDay(rows);
    assert.deepEqual(groups.map((g) => g.label), ['26-09-2026', '25-09-2026']);
    assert.equal(groups[1].rows.length, 2);
  });

  test('roster: pagination labels the page the way the desktop list does', () => {
    const items = Array.from({ length: 69 }, (_, i) => i);
    const page1 = paginate(items, 1);
    assert.equal(pageLabel(page1), 'Página 1 de 3 · 1–25 de 69');
    assert.equal(pageLabel(paginate(items, 3)), 'Página 3 de 3 · 51–69 de 69');
    assert.equal(pageLabel(paginate([], 1)), '');
    assert.equal(paginate(items, 99).page, 3);
  });

  test('roster: new-session count only counts what moved since last visit', () => {
    const now = Math.floor(Date.now() / 1000);
    const sessions = [
      { id: 'a', last_active: now - 10 },
      { id: 'b', last_active: now - 100_000 },
      { id: 'c', started_at: now - 5 },
    ];
    // lastSeen is stored in milliseconds (Date.now()); session stamps are epoch seconds.
    assert.equal(countNew(sessions, (now - 1000) * 1000), 2);
    assert.equal(countNew(sessions, now * 1000), 0);
  });

  test('roster: status dot maps health, auth and failure to distinct colours', () => {
    const palette = { green: 'g', amber: 'a', red: 'r', grey: 'x' };
    assert.equal(probeFromHealth({ status: 'ok', version: '1' }).status, 'ok');
    assert.equal(probeFromHealth({ status: 'degraded' }).status, 'degraded');
    assert.equal(probeFromHealth(null, { status: 401 }).status, 'auth');
    assert.equal(probeFromHealth(null, new Error('boom')).status, 'down');
    assert.equal(probeFromHealth(null).status, 'unknown');
    assert.equal(statusColor('ok', palette), 'g');
    assert.equal(statusColor('degraded', palette), 'a');
    assert.equal(statusColor('auth', palette), 'r');
    assert.equal(statusColor('unknown', palette), 'x');
  });

  // ─────────────────────────────────────────────────────── thread ──
  test('thread: sorts by timestamp and collapses a run of tool messages', () => {
    const items = buildItems([
      { id: 'a', role: 'assistant', content: 'segundo', timestamp: 200 },
      { id: 't1', role: 'tool', tool_name: 'shell', timestamp: 150 },
      { id: 't2', role: 'tool', tool_name: 'shell', timestamp: 160 },
      { id: 'u', role: 'user', content: 'primeiro', timestamp: 100 },
    ]);
    assert.deepEqual(items.map((item) => item.kind), ['message', 'tools', 'message']);
    assert.equal(items[0].kind === 'message' ? items[0].text : '', 'primeiro');
    assert.equal(items[1].kind === 'tools' ? items[1].count : 0, 2);
    assert.equal(items[1].kind === 'tools' ? items[1].names.join() : '', 'shell');
    assert.equal(items[2].kind === 'message' ? items[2].text : '', 'segundo');
  });

  test('thread: hidden scaffolding rows are not rendered, undated rows keep their order', () => {
    const items = buildItems([
      { id: 'h', role: 'system', content: '', display_kind: 'hidden' },
      { id: 'u', role: 'user', content: 'ok' },
      { id: 'a', role: 'assistant', content: '' },
    ]);
    assert.equal(items.length, 2);
    assert.equal(items.every((item) => item.kind === 'message'), true);
  });

  test('thread: an assistant row that narrates AND calls a tool keeps its text, and the call collapses', () => {
    // 0.4.0 (F3) changed this on purpose: 0.3.0 dropped the prose and showed only "1 chamada a
    // ferramentas", which threw away what the agent said. The text is a bubble now, the call is
    // still one collapsed row.
    const items = buildItems([{ id: 'a', role: 'assistant', content: 'vou ver', tool_calls: [{ id: 'x' }] }]);
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, 'message');
    assert.equal((items[0] as { text: string }).text, 'vou ver');
    assert.equal(items[1].kind, 'tools');
    assert.equal(sortMessages([{ id: '1', timestamp: 5 }, { id: '2', timestamp: 3 }]).map((m) => m.id).join(), '2,1');
  });

  // ─────────────────────────────────────────────────────── format ──
  test('format: dates are DD-MM-YYYY and times HH:MM', () => {
    const stamp = Date.UTC(2026, 0, 5, 9, 7, 0) / 1000;
    assert.equal(formatDate(stamp), '05-01-2026');
    assert.equal(formatDateTime(stamp).startsWith('05-01-2026 '), true);
    assert.equal(formatDate(null), '');
    assert.equal(formatDate(0), '');
  });

  test('format: age is relative and hours use a decimal comma', () => {
    const now = Date.now();
    assert.equal(formatAge(now / 1000, now), 'agora mesmo');
    assert.equal(formatAge(now / 1000 - 300, now), 'há 5 min');
    assert.equal(formatAge(now / 1000 - 7200, now), 'há 2 h');
    assert.equal(formatHours(750), '12,5 h');
    assert.equal(formatHours(null), '');
  });

  test('format: multimodal content renders as text, unknown parts as their raw type', () => {
    assert.equal(contentToText('plain'), 'plain');
    assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
    assert.equal(contentToText([{ type: 'image_url', image_url: { url: 'x' } }]), '[imagem]');
    assert.equal(contentToText([{ type: 'weird' }]), '[weird]');
    assert.equal(contentToText(null), '');
    assert.equal(initialOf('  ana'), 'A');
    assert.equal(initialOf(''), '');
  });

  // ─────────────────────────────────────────────────────── settings ──
  test('settings: profile names are cleaned, deduped and validated', () => {
    assert.deepEqual(splitProfiles('cody, vintage\ncody\n/p/cody/\n\nbad name\n'), ['cody', 'vintage']);
  });

  test('settings: base URL validation accepts a real origin and names the failures', () => {
    assert.deepEqual(checkBaseUrl('http://100.64.0.5:8642/'), { ok: true, value: 'http://100.64.0.5:8642' });
    assert.equal(checkBaseUrl('').ok, false);
    assert.equal(checkBaseUrl('100.64.0.5:8642').ok, false);
    assert.equal(checkBaseUrl('ftp://x').ok, false);
    assert.equal(profilePrefix(''), '');
    assert.equal(profilePrefix('default'), '');
    assert.equal(profilePrefix('cody'), '/p/cody');
  });

  test('settings: round-trips through storage with the key in its own slot', async () => {
    __resetStoreProbe();
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      baseUrl: 'http://127.0.0.1:8791',
      apiKey: 'k-1',
      profiles: ['cody'],
      model: 'm',
      routes: [{ role: 'lan', priority: 0, url: 'http://127.0.0.1:8791', insecure: false }],
    };

    await saveSettings(settings);
    const loaded = await loadSettings();
    assert.deepEqual(loaded, settings);
    await saveLastSeen({ cody: 123 });
    assert.deepEqual(await loadLastSeen(), { cody: 123 });
    await saveSettings({ ...settings, apiKey: '' });
    assert.equal((await loadSettings()).apiKey, '');
  });

  test('settings: a corrupt settings blob degrades to defaults instead of crashing', async () => {
    __resetStoreProbe();
    const { storeSet } = await import('../src/storage');
    await storeSet('personae.settings.v1', '{not json');
    assert.deepEqual(await loadSettings(), { ...DEFAULT_SETTINGS, apiKey: '' });
  });

  // ─────────────────────────────────────────────────── language (i18n) ──
  test('i18n: a fresh install defaults to English', async () => {
    __resetStoreProbe();
    assert.equal(DEFAULT_SETTINGS.language, 'en');
    assert.equal((await loadSettings()).language, 'en', 'nothing stored = fresh install = English');
  });

  test('i18n: an existing install without a language field keeps Portuguese (and its other values)', async () => {
    __resetStoreProbe();
    const { storeSet } = await import('../src/storage');
    // The exact shape the Portuguese-only build wrote: every field except `language`.
    await storeSet(
      'personae.settings.v1',
      JSON.stringify({ baseUrl: 'http://10.0.0.15:9119', surface: 'dashboard', profiles: [], model: '', autoConnect: true, openTailscaleOnFailure: true }),
    );
    const loaded = await loadSettings();
    assert.equal(loaded.language, 'pt');
    assert.equal(loaded.autoConnect, true, 'a stored value survives the default change');
    assert.equal(loaded.openTailscaleOnFailure, true, 'a stored value survives the default change');

    // An explicit choice always wins, and is what gets saved back.
    await saveSettings({ ...loaded, language: 'en' });
    assert.equal((await loadSettings()).language, 'en');
    await storeSet('personae.settings.v1', JSON.stringify({ baseUrl: '', language: 'pt' }));
    assert.equal((await loadSettings()).language, 'pt');
  });

  test('i18n: setLanguage switches t.* live through the same import', async () => {
    await inLanguage('en', () => {
      assert.equal(t.settings.title, 'Settings');
      assert.equal(t.roster.groups.ungrouped, 'No group');
      assert.equal(t.roster.messages(2), '2 messages');
      assert.equal(formatAge(Date.now() / 1000, Date.now()), 'just now');
    });
    await inLanguage('pt', () => {
      assert.equal(t.settings.title, 'Definições');
      assert.equal(t.roster.groups.ungrouped, 'Sem grupo');
      assert.equal(t.roster.messages(2), '2 mensagens');
      assert.equal(formatAge(Date.now() / 1000, Date.now()), 'agora mesmo');
    });
    // The exported log follows the chosen language too.
    await inLanguage('en', () => {
      const doc = buildLogDocument({ appVersion: '0', versionCode: '0', surface: 's', baseUrl: '' }, '', []);
      assert.match(doc, /support log/);
      assert.doesNotMatch(doc, /registo de diagnóstico/);
    });
  });

  test('i18n: the en and pt tables have the same keys, with functions in the same places', () => {
    const shape = (value: unknown, path: string, out: string[]): string[] => {
      if (typeof value === 'function') out.push(`${path}()/${(value as (...a: unknown[]) => unknown).length}`);
      else if (value && typeof value === 'object') {
        for (const key of Object.keys(value as object).sort()) shape((value as Record<string, unknown>)[key], `${path}.${key}`, out);
      } else out.push(`${path}:${typeof value}`);
      return out;
    };
    const en = shape(stringsFor('en'), 't', []);
    const pt = shape(stringsFor('pt'), 't', []);
    assert.deepEqual(pt, en);
    assert.ok(en.length > 300, `expected the full table, got ${en.length} leaves`);
    // Every string leaf is filled in, in both languages.
    for (const language of ['en', 'pt'] as const) {
      const empties: string[] = [];
      const walk = (value: unknown, path: string) => {
        if (typeof value === 'string') { if (!value.trim()) empties.push(path); }
        else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      };
      walk(stringsFor(language), language);
      assert.deepEqual(empties, []);
    }
  });

  test('i18n: the swept Portuguese strings are no longer hardcoded outside the table', () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !full.endsWith(join('src', 'i18n.ts'))) files.push(full);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'app'));
    const swept = [
      'Personae — registo de diagnóstico',
      'Últimas falhas:',
      'cabeçalhos de autenticação, bilhetes e tokens',
      'endereço sem host ou porta',
      'a ligação abriu mas não houve resposta',
      "'enviado'",
      'automático desligado',
      'indisponível nesta plataforma',
      'erro na transmissão',
      'sessão sem id',
      'não é suportado nesta ligação',
      'Bearer do dashboard',
      'modelo por omissão do gateway',
      'agora mesmo',
      'caracteres)',
      "'API do gateway (:9222)'",
      'tempo esgotado',
      'falha de rede',
      'ticket ausente',
      'Ignorado:',
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const literal of swept) if (text.includes(literal)) hits.push(`${file.slice(root.length + 1)}: ${literal}`);
    }
    assert.deepEqual(hits, []);
  });

  // ──────────────────────────────────────────── Tailscale opt-in defaults ──
  test('tailscale: auto-connect and open-on-failure are OFF by default', async () => {
    assert.equal(DEFAULT_SETTINGS.autoConnect, false);
    assert.equal(DEFAULT_SETTINGS.openTailscaleOnFailure, false);
    __resetStoreProbe();
    const fresh = await loadSettings();
    assert.equal(fresh.autoConnect, false);
    assert.equal(fresh.openTailscaleOnFailure, false);
    assert.deepEqual(
      tailscalePolicy(fresh, { canTrigger: true, installed: true }),
      { sendTrigger: false, openOnFailure: false },
      'with the defaults the app neither raises nor opens Tailscale',
    );
    assert.deepEqual(
      tailscalePolicy({ autoConnect: true, openTailscaleOnFailure: true }, { canTrigger: true, installed: true }),
      { sendTrigger: true, openOnFailure: true },
    );
    assert.equal(tailscalePolicy({ autoConnect: true, openTailscaleOnFailure: true }, { canTrigger: true, installed: false }).openOnFailure, false);
  });

  test('tailscale: a direct LAN route still connects with both Tailscale flags off', async () => {
    const settings = settingsFor(gateway.url, {
      routes: [{ role: 'lan', priority: 0, url: gateway.url, insecure: false }],
    });
    assert.equal(settings.autoConnect, false);
    assert.equal(settings.openTailscaleOnFailure, false);
    const tcp = (host: string, port: number, timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        const socket = netConnect({ host, port });
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
      });
    const health = async (url: string) => {
      const response = await fetch(`${url.replace(/\/+$/, '')}/v1/health`).catch(() => null);
      return response ? { status: response.status, ok: response.ok } : null;
    };
    const result = await connectThrough({
      routes: effectiveRoutes(settings),
      insecureAck: settings.insecureRouteAck,
      preferredRole: settings.preferredRouteRole,
      probeTimeoutMs: settings.probeTimeoutMs,
      deadlineMs: 3_000,
      probe: probeRoute({ tcp, health }),
    });
    assert.equal(result.reason, 'selected');
    assert.equal(result.route?.url, gateway.url);
    assert.deepEqual(tailscalePolicy(settings, { canTrigger: true, installed: true }), { sendTrigger: false, openOnFailure: false });
  });

  // ───────────────────────────────────────────── routes: inference (§2) ──
  test('routes: role inference covers tailnet (incl. 100.64.0.0/10), LAN and public', () => {
    // MagicDNS name -> tailscale
    assert.equal(inferRole('https://personae-sk.tail0000demo.ts.net:10443'), 'tailscale');
    // 100.64.0.0/10, including both boundaries
    assert.equal(inferRole('http://100.64.0.0:9222'), 'tailscale');
    assert.equal(inferRole('http://100.64.0.11:9222'), 'tailscale');
    assert.equal(inferRole('http://100.127.255.255:9222'), 'tailscale');
    assert.equal(isCgnatHost('100.64.0.11'), true);
    // just outside the CGNAT block
    assert.equal(inferRole('http://100.63.255.255:9222'), 'public');
    assert.equal(inferRole('http://100.128.0.0:9222'), 'public');
    // RFC1918
    assert.equal(inferRole('http://10.0.0.15:9222'), 'lan');
    assert.equal(inferRole('http://172.16.0.1:9222'), 'lan');
    assert.equal(inferRole('http://172.31.255.255:9222'), 'lan');
    assert.equal(inferRole('http://192.168.1.50:9222'), 'lan');
    assert.equal(inferRole('http://172.32.0.1:9222'), 'public');
    // documented refinement: loopback is private, never "public"
    assert.equal(inferRole('http://127.0.0.1:9222'), 'lan');
    // everything else
    assert.equal(inferRole('https://gateway.example.com:443'), 'public');
    assert.equal(inferRole('nonsense'), 'public');
  });

  // ────────────────────────────────────── routes: priority (§1, §2) ──
  const route = (url: string, priority: number, role = inferRole(url)): RouteCandidate =>
    ({ role, priority, url, insecure: false });

  test('routes: orderRoutes is a stable sort by strict priority', () => {
    const ordered = orderRoutes([route('http://c', 2), route('http://a', 0), route('http://b', 0)]);
    assert.deepEqual(ordered.map((r) => r.url), ['http://a', 'http://b', 'http://c']);
  });

  test('routes: reachability breaks ties but NEVER promotes a lower priority over a higher one', () => {
    const high = route('http://10.0.0.1:9222', 0);
    const low = route('http://10.0.0.2:9222', 10);
    const reachable = (url: string) => (candidate: RouteCandidate) => candidate.url === url;

    // The higher-priority route answers -> it wins, even though the lower one also answers.
    assert.equal(pickByPriority([high, low], () => true)?.url, high.url);
    assert.equal(pickByPriority([high, low], reachable(high.url))?.url, high.url);

    // The higher-priority route is dead -> failover to the lower group (this is NOT promotion: the
    // higher group was exhausted first, which is exactly the DNS SRV contract).
    assert.equal(pickByPriority([high, low], reachable(low.url))?.url, low.url);

    // Only ties are broken by reachability: same priority, first dead, second alive.
    const first = route('http://10.0.0.3:9222', 5);
    const second = route('http://10.0.0.4:9222', 5);
    assert.equal(pickByPriority([first, second], reachable(second.url))?.url, second.url);

    // Nothing reachable -> null, never a guess.
    assert.equal(pickByPriority([high, low], () => false), null);
  });

  test('routes: a manual pin is honoured, and bypassing it is reported out loud', () => {
    const lan = route('http://10.0.0.15:9222', 0, 'lan');
    const ts = route('http://100.64.0.11:9222', 1, 'tailscale');

    // Pin asks for tailscale and tailscale answers -> the pin is honoured (priority is irrelevant to
    // a pin: that is the whole point of pinning).
    const honoured = selectRoute([lan, ts], () => true, { insecureAck: true, preferredRole: 'tailscale' });
    assert.equal(honoured.reason, 'selected');
    assert.equal(honoured.route?.url, ts.url);

    // Pin asks for tailscale and it is unreachable -> fall back, and SAY that the pin was bypassed
    // rather than silently ignoring the user's choice.
    const pinned = selectRoute([lan, ts], (r) => r.url === lan.url, { insecureAck: true, preferredRole: 'tailscale' });
    assert.equal(pinned.reason, 'pin-bypassed');
    assert.equal(pinned.route?.url, lan.url);

    // Nothing reachable at all: still no fallback, and the pin is not "honoured" by inventing one.
    const none = selectRoute([lan, ts], () => false, { insecureAck: true, preferredRole: 'tailscale' });
    assert.equal(none.reason, 'none-reachable');
    assert.equal(none.route, null);

    const auto = selectRoute([lan, ts], () => true, { insecureAck: true, preferredRole: null });
    assert.equal(auto.route?.url, lan.url); // strict priority wins in Auto
  });

  test('routes: security policy — public http is refused, private http needs the ack', () => {
    // A public origin must be https.
    assert.deepEqual(
      checkRoute(route('http://gateway.example.com:9222', 0, 'public'), { insecureAck: true }),
      { ok: false, reason: 'public-http' },
    );
    assert.equal(checkRoute(route('https://gateway.example.com:9222', 0, 'public'), { insecureAck: false }).ok, true);

    // A private overlay over plain http is permitted only with explicit consent.
    assert.deepEqual(
      checkRoute(route('http://100.64.0.11:9222', 0, 'tailscale'), { insecureAck: false }),
      { ok: false, reason: 'needs-ack' },
    );
    assert.equal(checkRoute(route('http://100.64.0.11:9222', 0, 'tailscale'), { insecureAck: true }).ok, true);

    // Loopback needs no consent (nothing leaves the machine).
    assert.equal(checkRoute(route('http://127.0.0.1:9222', 0, 'lan'), { insecureAck: false }).ok, true);

    // A mislabelled role cannot talk its way past the https rule for public origins: the role is
    // re-inferred from the URL, never taken from the stored field.
    assert.deepEqual(
      checkRoute({ role: 'tailscale', priority: 0, url: 'http://gateway.example.com:9222', insecure: false }, { insecureAck: true }),
      { ok: false, reason: 'public-http' },
    );

    assert.deepEqual(checkRoute(route('not-a-url', 0), { insecureAck: true }), { ok: false, reason: 'bad-url' });

    // Violating routes are skipped, and named, rather than silently used or silently dropped.
    const decision = selectRoute(
      [route('http://gateway.example.com:9222', 0, 'public'), route('http://10.0.0.15:9222', 1, 'lan')],
      () => true,
      { insecureAck: true },
    );
    assert.equal(decision.route?.url, 'http://10.0.0.15:9222');
    assert.deepEqual(decision.rejected.map((r) => r.reason), ['public-http']);
  });

  test('routes: a tailnet http route is WireGuard-encrypted, never "public plaintext"', () => {
    const raw = transportSecurityNote(route('http://100.64.0.11:9222', 0, 'tailscale'));
    assert.ok(raw.includes('WireGuard'), `expected a WireGuard note, got: ${raw}`);
    assert.equal(/público|plaintext|claro/i.test(raw), false, `must not read as public plaintext: ${raw}`);

    const serve = transportSecurityNote(route('https://host.tail0000demo.ts.net:10443', 0, 'tailscale'));
    assert.ok(serve.includes('TLS'), serve);

    const lan = transportSecurityNote(route('http://10.0.0.15:9222', 0, 'lan'));
    assert.ok(lan.includes('local'), lan);
  });

  test('routes: migration derives candidates from a legacy baseUrl, and renumbering re-packs order', () => {
    assert.deepEqual(routesFromBaseUrl('http://10.0.0.15:9222/'), [
      { role: 'lan', priority: 0, url: 'http://10.0.0.15:9222', insecure: false },
    ]);
    assert.deepEqual(routesFromBaseUrl(''), []);

    // A settings object that only knows baseUrl still yields one candidate.
    assert.equal(effectiveRoutes({ baseUrl: 'https://a.ts.net:10443' }).length, 1);
    assert.equal(effectiveRoutes({ baseUrl: 'x', routes: [route('http://10.0.0.1:9222', 3)] }).length, 1);

    // Storage rows that are malformed are dropped, never guessed at.
    assert.deepEqual(normalizeRoutes([{ url: 'nonsense' }, { url: 'http://10.0.0.1:9222' }, null, 7]), [
      { role: 'lan', priority: 0, url: 'http://10.0.0.1:9222', insecure: false },
    ]);
    assert.deepEqual(normalizeRoutes('not an array'), []);

    const moved = moveRoute([route('http://a', 0), route('http://b', 1), route('http://c', 2)], 0, 2);
    assert.deepEqual(moved.map((r) => r.url), ['http://b', 'http://c', 'http://a']);
    assert.deepEqual(moved.map((r) => r.priority), [0, 1, 2]);
    assert.deepEqual(renumberRoutes([route('http://a', 40), route('http://b', 7)]).map((r) => r.priority), [0, 1]);
  });

  // ─────────────────────────────────────── failures: taxonomy (§4) ──
  test('failures: the taxonomy maps each condition to its documented class', () => {
    assert.equal(classifyStatus(401), 'permanent');
    assert.equal(classifyStatus(403), 'permanent');
    assert.equal(classifyStatus(429), 'backoff');
    assert.equal(classifyStatus(500), 'server');
    assert.equal(classifyStatus(502), 'server');
    assert.equal(classifyStatus(404), 'route');
    assert.equal(classifyStatus(408), 'transient');
    assert.equal(classifyStatus(400), 'permanent');

    // Retry permission follows from the class.
    assert.equal(shouldRetry('permanent'), false);
    assert.equal(shouldRetry('route'), false);
    assert.equal(shouldRetry('transient'), true);
    assert.equal(shouldRetry('server'), true);
    assert.equal(shouldRetry('backoff'), true);

    assert.equal(nextDelayMs('permanent', 0), null);
    assert.equal(nextDelayMs('route', 0), null);
    assert.equal(typeof nextDelayMs('transient', 0), 'number');
  });

  test('failures: a rejected key is permanent and is NEVER retried', async () => {
    let calls = 0;
    const sleepCalls: number[] = [];
    const result = await attemptWithPolicy(
      async () => {
        calls += 1;
        throw new ApiError('chave recusada', { kind: 'http', status: 401 });
      },
      { maxAttempts: 5, sleep: async (ms) => { sleepCalls.push(ms); } },
    );
    assert.equal(calls, 1, 'a 401 must be attempted exactly once');
    assert.equal(sleepCalls.length, 0, 'a 401 must never back off and retry');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'permanent');
    assert.equal(result.cls, 'permanent');

    // 403 behaves the same way.
    let forbidden = 0;
    await attemptWithPolicy(async () => { forbidden += 1; throw new ApiError('x', { kind: 'http', status: 403 }); }, { maxAttempts: 4 });
    assert.equal(forbidden, 1);
  });

  test('failures: timeouts back off with jitter, and the delay stays under the cap', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await attemptWithPolicy(
      async () => {
        calls += 1;
        if (calls < 3) throw new ApiError('timeout', { kind: 'timeout' });
        return 'ok';
      },
      { maxAttempts: 5, baseMs: 100, capMs: 10_000, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); } },
    );
    assert.deepEqual(result, { ok: true, value: 'ok', tries: 3, cls: null });
    assert.equal(sleeps.length, 2, 'two waits between three tries');
    assert.ok(sleeps.every((ms) => ms > 0 && ms <= 10_000), `delays out of range: ${sleeps}`);

    // Equal jitter: half the raw value is fixed, the other half is random, so 0 gives raw/2 and 1
    // gives raw. Without jitter every device waking from doze would retry in lockstep.
    assert.equal(retryDelayMs(0, { baseMs: 1000, capMs: 8000, random: () => 0 }), 500);
    assert.equal(retryDelayMs(0, { baseMs: 1000, capMs: 8000, random: () => 1 }), 1000);
    assert.ok(
      retryDelayMs(4, { baseMs: 100, capMs: 10_000, random: () => 0.9 }) >
        retryDelayMs(4, { baseMs: 100, capMs: 10_000, random: () => 0.1 }),
    );

    // Capped, and safe against 2**n overflow at large attempt numbers.
    assert.equal(retryDelayMs(3, { baseMs: 1000, capMs: 4000, random: () => 1 }), 4000);
    assert.equal(retryDelayMs(200, { baseMs: 1000, capMs: 4000, random: () => 1 }), 4000);

    // A 429 waits the server's own period rather than our backoff.
    assert.equal(parseRetryAfter('12', 0), 12_000);
    assert.equal(parseRetryAfter(null, 0), null);
    assert.equal(parseRetryAfter('not a date', 0), null);
    assert.equal(nextDelayMs('backoff', 0, { retryAfterMs: 1500, capMs: 20_000, random: () => 1 }), 1500);
    assert.equal(nextDelayMs('backoff', 5, { retryAfterMs: 300_000, capMs: 20_000, random: () => 1 }), 20_000);
  });

  test('failures: nothing is retried once the app is backgrounded', async () => {
    let foreground = true;
    let calls = 0;
    const result = await attemptWithPolicy(
      async () => {
        calls += 1;
        throw new ApiError('timeout', { kind: 'timeout' });
      },
      {
        maxAttempts: 6,
        isForeground: () => foreground,
        sleep: async () => { foreground = false; },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'backgrounded');

    // And a call that starts while already backgrounded never runs at all.
    let never = 0;
    const backgrounded = await attemptWithPolicy(async () => { never += 1; return 'x'; }, { isForeground: () => false });
    assert.equal(never, 0);
    assert.equal(backgrounded.ok, false);
    assert.equal(backgrounded.reason, 'backgrounded');
  });

  // ─────────────────────────────────────── connect engine (§1, §4) ──
  function fakeClock(start = 1_000) {
    let value = start;
    return { now: () => value, advance: (ms: number) => { value += ms; } };
  }

  test('connect: re-evaluates on a network change and hops LAN -> Tailscale', async () => {
    // Same gateway, two routes. On Wi-Fi the LAN one answers; off Wi-Fi it is gone and the tailnet
    // route takes over. This is the mechanism that replaces "open Tailscale first, then the app".
    const lan = route('http://10.0.0.15:9222', 0, 'lan');
    const ts = route('http://100.64.0.11:9222', 1, 'tailscale');
    const clock = fakeClock();

    const onLan = await connectThrough({
      routes: [lan, ts], insecureAck: true, probeTimeoutMs: 50, deadlineMs: 5_000,
      now: clock.now, sleep: async (ms) => clock.advance(ms), random: () => 1,
      probe: async (candidate) => (candidate.url === lan.url ? { ok: true, ms: 4 } : { ok: false, failure: 'transient' }),
    });
    assert.equal(onLan.route?.url, lan.url);
    assert.equal(onLan.reason, 'selected');

    // Network changed: a fresh run with a fresh cache, LAN now unreachable.
    const offLan = await connectThrough({
      routes: [lan, ts], insecureAck: true, probeTimeoutMs: 50, deadlineMs: 5_000,
      now: clock.now, sleep: async (ms) => clock.advance(ms), random: () => 1,
      probe: async (candidate) => (candidate.url === ts.url ? { ok: true, ms: 12 } : { ok: false, failure: 'transient' }),
    });
    assert.equal(offLan.route?.url, ts.url);
    assert.equal(offLan.reason, 'selected');
  });

  test('connect: a 401 stops the whole run and never probes another route', async () => {
    const ts = route('https://host.tail0000demo.ts.net:10443', 0, 'tailscale');
    const lan = route('http://10.0.0.15:9222', 1, 'lan');
    const probed: string[] = [];
    const clock = fakeClock();

    const result = await connectThrough({
      routes: [ts, lan], insecureAck: true, probeTimeoutMs: 50, deadlineMs: 10_000,
      now: clock.now, sleep: async (ms) => clock.advance(ms),
      probe: async (candidate) => {
        probed.push(candidate.url);
        return { ok: false, failure: 'permanent', detail: 'HTTP 401' };
      },
    });

    assert.equal(result.reason, 'permanent');
    assert.equal(result.route, null);
    assert.deepEqual(probed, [ts.url], 'a rejected credential must stop everything, immediately');
    assert.equal(result.attempts.length, 1);
    assert.deepEqual(result.permanent, { failure: 'permanent', detail: 'HTTP 401' });
  });

  test('connect: a 404 kills only that route, and the next candidate is still tried', async () => {
    const wrong = route('http://10.0.0.15:9999', 0, 'lan');
    const right = route('http://10.0.0.15:9222', 1, 'lan');
    const clock = fakeClock();

    const result = await connectThrough({
      routes: [wrong, right], insecureAck: true, probeTimeoutMs: 50, deadlineMs: 5_000,
      now: clock.now, sleep: async (ms) => clock.advance(ms), random: () => 1,
      probe: async (candidate) =>
        candidate.url === wrong.url ? { ok: false, failure: 'route', detail: 'HTTP 404' } : { ok: true, ms: 3 },
    });

    assert.equal(result.route?.url, right.url);
    assert.equal(result.cache.get(wrong.url)?.dead, true, 'a 404 is dead for this run');
    assert.equal(
      result.attempts.filter((attempt) => attempt.url === wrong.url).length,
      1,
      'a wrong route is not retried',
    );
  });

  test('connect: polling never happens while backgrounded, and stops mid-run', async () => {
    const lan = route('http://10.0.0.15:9222', 0, 'lan');
    const clock = fakeClock();
    let probes = 0;

    const alreadyAway = await connectThrough({
      routes: [lan], insecureAck: true, probeTimeoutMs: 10, deadlineMs: 1_000,
      isForeground: () => false, now: clock.now, sleep: async () => undefined,
      probe: async () => { probes += 1; return { ok: true, ms: 1 }; },
    });
    assert.equal(alreadyAway.reason, 'backgrounded');
    assert.equal(probes, 0, 'nothing may be probed in the background');

    let foreground = true;
    const halfway = await connectThrough({
      routes: [lan], insecureAck: true, probeTimeoutMs: 10, deadlineMs: 60_000,
      isForeground: () => foreground, now: clock.now, sleep: async (ms) => clock.advance(ms),
      probe: async () => { probes += 1; foreground = false; return { ok: false, failure: 'transient' }; },
    });
    assert.equal(halfway.reason, 'backgrounded');
    assert.equal(probes, 1, 'backgrounding mid-run cancels the loop');
  });

  test('connect: gives up at the deadline instead of polling forever', async () => {
    const ts = route('http://100.64.0.11:9222', 0, 'tailscale');
    const clock = fakeClock();
    const result = await connectThrough({
      routes: [ts], insecureAck: true, probeTimeoutMs: 50, deadlineMs: 3_000,
      now: clock.now, sleep: async (ms) => clock.advance(ms), random: () => 1,
      probe: async () => ({ ok: false, failure: 'transient', detail: 'sem resposta' }),
    });
    assert.equal(result.reason, 'deadline');
    assert.equal(result.route, null);
    assert.ok(result.elapsedMs <= 3_000, `overran the deadline: ${result.elapsedMs}`);
    assert.ok(result.attempts.length >= 1);
  });

  test('connect: the probe cache is per candidate, so one dead route cannot poison a healthy one', () => {
    const cache = createProbeCache();
    const a = route('http://10.0.0.1:9222', 0, 'lan');
    const b = route('http://10.0.0.2:9222', 0, 'lan');

    cache.record(a.url, { ok: false, failure: 'transient' }, 0);
    assert.equal(cache.isReachable(a), false);
    assert.equal(cache.isReachable(b), false, 'an unprobed route is not reachable either');

    cache.record(b.url, { ok: true, ms: 2 }, 0);
    assert.equal(cache.isReachable(b), true);
    assert.equal(cache.isReachable(a), false, 'b answering must not mark a reachable');

    // A transient failure backs off on its own schedule, per candidate: it becomes retryable at
    // `at + delay`, not immediately, and not because of anything another route did.
    const deterministic = createProbeCache({ random: () => 1 });
    deterministic.record(a.url, { ok: false, failure: 'transient' }, 1_000);
    assert.equal(deterministic.get(a.url)?.retryAt, 1_500, 'base 500ms backoff, jitter at its ceiling');
    assert.equal(deterministic.get(a.url)?.dead, false);

    // A 404 means "this URL is not the route": dead for this run, never retried, and still only
    // that candidate is affected.
    deterministic.record(a.url, { ok: false, failure: 'route', detail: 'HTTP 404' }, 2_000);
    assert.equal(deterministic.get(a.url)?.retryAt, Infinity);
    assert.equal(deterministic.get(a.url)?.dead, true);
    assert.equal(deterministic.isReachable(b), false);
  });


  // ────────────────────────────────── dashboard transport (0.4.0 / P0.2) ──
  // The app targets the gated dashboard, not the :9222 api_server. Every shape asserted here comes
  // from the serving code (see src/api/dashboard.ts for the file:line map) and is reproduced by
  // mock/dashboard.mjs, including a real WebSocket upgrade with a fake JSON-RPC dispatch.
  const DASH_BEARER = 'test-bearer-0123456789abcdef0123456789abcdef';
  const dashboard = createMockDashboard({ port: 8792, bearer: DASH_BEARER });
  await dashboard.listen();
  const dash = createDashboardClient(settingsFor(dashboard.url, { apiKey: DASH_BEARER }), {
    timeoutMs: 4000,
    rpcTimeoutMs: 4000,
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test('dashboard: /api/profiles lists profiles and flags the ones that have an avatar', async () => {
    const profiles = await dash.profiles();
    assert.equal(profiles.length, 2);
    assert.equal(profiles[0].name, 'default');
    assert.equal(profiles[0].has_avatar, true);
    assert.equal(profiles[1].has_avatar, false, 'the cheap existence flag drives the monogram fallback');
  });

  test('dashboard: a wrong bearer is a 401 through the shared error ladder', async () => {
    const wrong = createDashboardClient(settingsFor(dashboard.url, { apiKey: 'nope' }), { timeoutMs: 4000 });
    await expectApiError(() => wrong.profiles(), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.kind, 'http');
    });
  });

  test('dashboard: settings with no bearer fail before any request is made', async () => {
    const unconfigured = createDashboardClient(settingsFor(dashboard.url, { apiKey: '' }), { timeoutMs: 4000 });
    await expectApiError(() => unconfigured.profiles(), (error) => {
      assert.equal(error.kind, 'config');
    });
  });

  test('dashboard: a registered token route answers the seam body; an unregistered one the gate body', async () => {
    const gate = await fetch(`${dashboard.url}/api/profiles`);
    const seam = await fetch(`${dashboard.url}/api/profiles/sessions/sidebar`);
    assert.equal(gate.status, 401);
    assert.equal(seam.status, 401);
    const gateBody = (await gate.json()) as Record<string, unknown>;
    const seamBody = (await seam.json()) as Record<string, unknown>;
    assert.equal(gateBody.reason, 'no_cookie');
    assert.equal(gateBody.login_url, '/login');
    // The token seam owns the whole path and never consults a cookie — the distinction measured on
    // the live dashboard (logs/p0.1-spike.txt §4) and the reason the app only registers paths the
    // dashboard SPA itself never calls.
    assert.equal(seamBody.reason, undefined);
    assert.equal(seamBody.login_url, undefined);
  });

  test('dashboard: the rail returns every profile\'s sessions with profile_totals in one call', async () => {
    const rail = await dash.rail('all');
    assert.equal(rail.sessions.length, 2);
    assert.equal(rail.total, 2);
    assert.equal((rail.profile_totals as Record<string, number>).beta, 1);
  });

  test('dashboard: the sidebar slices wrap their sessions (the live shape, not bare arrays)', async () => {
    const side = await dash.sidebar('all', { recentsLimit: 5 });
    assert.equal(side.recents?.sessions.length, 2);
    assert.equal(side.cron?.sessions.length, 0);
    assert.equal(side.messaging?.total, 0);
  });

  test('dashboard: GET /api/sessions/{id}/messages returns `messages`, not the api_server\'s `data`', async () => {
    const page = await dash.messages('sess-1', 'default');
    assert.equal(page.session_id, 'sess-1');
    assert.equal(page.messages.length, 9);
    assert.equal((page as unknown as Record<string, unknown>).data, undefined);
  });

  test('dashboard: PATCH returns the title the server stored', async () => {
    const renamed = await dash.rename('sess-1', 'Título novo', 'default');
    assert.equal(renamed.ok, true);
    assert.equal(renamed.title, 'Título novo');
    const detail = await dash.session('sess-1', 'default');
    assert.equal(detail.title, 'Título novo', 'GET /api/sessions/{id} is authoritative (F4)');
  });

  test('dashboard: a 404 for an unknown session keeps its HTTP identity', async () => {
    await expectApiError(() => dash.session('missing-session', 'default'), (error) => {
      assert.equal(error.status, 404);
    });
  });

  // ── the WS leg: one fresh ticket per connection, then JSON-RPC + events ──
  const allEvents: GatewayEvent[] = [];
  const deltas: string[] = [];
  const toolActivity: string[] = [];
  const live = await dash.connect({
    onEvent: (event) => allEvents.push(event),
  });
  live.on('message.delta', (event) => deltas.push(String(event.payload.text ?? '')));
  live.on('tool.start', (event) => toolActivity.push(`start:${String(event.payload.name ?? '')}`));
  live.on('tool.complete', (event) => toolActivity.push(`complete:${String(event.payload.name ?? '')}`));

  test('dashboard: the WS authenticates with a minted ticket and reports gateway.ready', () => {
    assert.equal(live.closed, false);
    assert.ok(
      allEvents.some((event) => event.type === 'gateway.ready'),
      'the gateway sends gateway.ready right after accept',
    );
  });

  test('dashboard: profiles.get_asset returns a data URL, and null when there is no asset', async () => {
    const withAvatar = await dash.asset(live, 'default');
    assert.ok(withAvatar?.startsWith('data:image/png;base64,'), 'rendered straight into <Image>, no new route');
    const withoutAvatar = await dash.asset(live, 'beta');
    assert.equal(withoutAvatar, null, 'found:false is a normal answer, not an error');
  });

  test('dashboard: prompt.submit streams deltas and live tool activity over the same socket', async () => {
    deltas.length = 0;
    toolActivity.length = 0;
    const sent = await live.rpc<{ ok: boolean }>('prompt.submit', { session_id: 'sess-1', text: 'Olá' });
    assert.equal(sent.ok, true);
    await waitFor(() => deltas.join('').length > 0 && toolActivity.length >= 2);
    assert.equal(deltas.join(''), 'Pronto: feito.');
    assert.deepEqual(toolActivity, ['start:read_file', 'complete:read_file']);
    const withSession = allEvents.filter((event) => event.sessionId === 'sess-1');
    assert.ok(withSession.length >= 4, 'events carry the session they belong to');
    assert.ok(allEvents.some((event) => event.type === 'message.complete'));
  });

  test('dashboard: an unknown RPC method comes back as an ApiError, not a hang', async () => {
    await expectApiError(() => live.rpc('nope.method'), (error) => {
      assert.equal(error.kind, 'http');
      assert.match(String(error.detail), /unknown method/);
    });
  });

  test('dashboard: a spent ticket cannot open a second socket (single use)', async () => {
    const { ticket } = await dash.wsTicket();
    const first = await openRawSocket(`${dashboard.wsUrl}?ticket=${ticket}`);
    await first.send(JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'session.interrupt' }));
    first.close();
    await expectRawSocketFailure(`${dashboard.wsUrl}?ticket=${ticket}`);
  });

  // ══════════════════════ 0.5.0 — the roster becomes the plugin's roster (F5) ══════════════════
  // The main view is a vertical list of FACES that expand in place, with groups, a search bar,
  // status lights and colour that fills. Everything that decides what the screen draws lives in
  // pure modules, so all of it is pinned here, offline, without a renderer.

  // ── groups ("sections") — the plugin's own shape and keys ──
  test('sections: a deleted group drops no session — its members fall back to ungrouped', () => {
    let model = normalizeSections({ sections: [{ id: 'fam', name: 'Família' }], members: { cody: 'fam', scout: 'fam' } });
    assert.equal(sectionOf(model, 'cody'), 'fam');
    // A "session" stands in for anything the group might have been holding: deleting the group
    // cannot reach it, because sessions are simply not part of this model.
    const sessions = ['sess-a', 'sess-b'];
    model = deleteSection(model, 'fam');
    assert.equal(model.sections.length, 0);
    assert.deepEqual(model.members, {}, 'the members are released, not deleted');
    assert.equal(sectionOf(model, 'cody'), UNASSIGNED);
    assert.deepEqual(sessions, ['sess-a', 'sess-b'], 'nothing the group was holding is touched');
  });

  test('sections: the shape round-trips exactly (sections/members/collapsed/order/sort)', () => {
    const stored = {
      sections: [
        { id: 'trabalho', name: 'Trabalho' },
        { id: 'casa', name: 'Casa' },
      ],
      members: { cody: 'trabalho', scout: 'casa' },
      collapsed: ['casa'],
      order: { trabalho: ['cody'], casa: ['scout'] },
      sort: { casa: 'name', trabalho: 'manual' },
    };
    const model = normalizeSections(stored);
    assert.deepEqual(model, stored, 'the same keys the desktop pane stores, unchanged');
    // and the setters keep them:
    const added = addSection(model, 'Pessoal');
    assert.deepEqual(added.sections.map((s) => s.name), ['Trabalho', 'Casa', 'Pessoal']);
    const renamed = renameSection(added, 'casa', 'Casa e família');
    assert.equal(renamed.sections.find((s) => s.id === 'casa')?.name, 'Casa e família');
  });

  test('sections: an orphan member and an unknown sort mode are dropped, never trusted', () => {
    const model = normalizeSections({
      sections: [{ id: 'keep', name: 'Mantém' }, { id: 'keep', name: 'Duplicado' }, { id: '', name: 'x' }],
      members: { a: 'keep', b: 'deleted-group' },
      collapsed: ['keep', 'deleted-group'],
      sort: { keep: 'por-magia', deleted: 'name' },
      order: { deleted: ['a'], keep: ['a'] },
    });
    assert.deepEqual(model.sections, [{ id: 'keep', name: 'Mantém' }]);
    assert.deepEqual(model.members, { a: 'keep' }, 'a member of a group that is gone does not resurrect it');
    assert.deepEqual(model.collapsed, ['keep']);
    assert.deepEqual(model.sort, {}, 'a stale mode falls back to the default rather than doing nothing');
    assert.deepEqual(model.order, { keep: ['a'] });
  });

  test('sections: an empty declared group is kept; the empty implicit one is not drawn', () => {
    const model = normalizeSections({ sections: [{ id: 'vazio', name: 'Vazio' }], members: { cody: 'vazio' } });
    const rows = [{ name: 'cody' }, { name: 'scout' }];
    const groups = groupsFor(model, rows, (row) => row.name, t.roster.groups.ungrouped);
    // The declared-but-empty group is NOT in this list (it holds cody), so check a genuinely empty one:
    const withEmpty = normalizeSections({ sections: [{ id: 'sem-ninguem', name: 'Sem ninguém' }], members: { cody: 'sem-ninguem' } });
    const groups2 = groupsFor(withEmpty, [{ name: 'scout' }], (row) => row.name, t.roster.groups.ungrouped);
    assert.deepEqual(groups2.map((g) => g.name), [t.roster.groups.ungrouped, 'Sem ninguém']);
    assert.equal(groups2[1].rows.length, 0, 'an empty group is kept — it explains how to fill it');
    assert.equal(groups2[0].rows.length, 1);
    // …and with nothing ungrouped, no phantom heading appears:
    const groups3 = groupsFor(withEmpty, [{ name: 'cody' }], (row) => row.name, t.roster.groups.ungrouped);
    assert.deepEqual(groups3.map((g) => g.name), ['Sem ninguém']);
    assert.equal(groups.length, 2);
  });

  // ── the feed: `recents`, never cron (R3/F6) ──
  test('feed: cron and webhook runs are NOT in the roster feed, and stay reachable as automatic runs', () => {
    const all = [
      { id: 'chat-1', source: 'dashboard', title: 'Conversa', last_active: 300 },
      { id: 'cron-1', source: 'cron', title: 'Scholes - Daily School Digest', last_active: 400 },
      { id: 'hook-1', source: 'webhook', title: 'Hook', last_active: 200 },
      { id: 'cron-2', source: 'cron_output', title: 'Dobbs - Birthday Briefing', last_active: 500 },
      { id: 'chat-2', source: 'cli', title: 'Outra', last_active: 100 },
    ];
    assert.deepEqual(conversations(all).map((s) => s.id), ['chat-1', 'chat-2'], 'the feed is conversations only');
    assert.deepEqual(automaticRuns(all).map((s) => s.id), ['cron-1', 'hook-1', 'cron-2'], 'and the runs are kept, not discarded');
    assert.equal(isAutomatic({ id: 'x', source: 'CRON' }), true, 'case is not a way back into the feed');
  });

  test('feed: a cron run never becomes a profile row\'s preview (it is not the latest conversation)', () => {
    const contacts = rosterContacts({
      hasProfiles: true,
      profiles: [{ name: 'dobbs', label: 'Dobbs', isDefault: false, hasAvatar: null }],
      declared: [],
    }).contacts;
    const sessions = [
      { id: 'cron-newest', source: 'cron', profile: 'dobbs', title: 'Birthday Briefing', last_active: 900, preview: 'bom dia' },
      { id: 'chat-older', source: 'dashboard', profile: 'dobbs', title: 'Festa da Ana', last_active: 700, preview: 'o bolo ficou pronto' },
    ];
    const model = buildRoster({ contacts, sessions, expanded: [], now: 1_700_000_000_000 });
    assert.equal(model.rows.length, 1);
    assert.equal(model.rows[0].preview, 'o bolo ficou pronto', 'the face shows the last CONVERSATION');
    assert.equal(model.rows[0].automatic.length, 1, 'the run is still reachable, under its own profile');
    assert.equal(model.automaticSeen, 1);
  });

  // ── F7: a failed profile list is never covered up ──
  test('contacts: a profile list that fails yields the REAL error and no fabricated contact', () => {
    const failure = new ApiError(t.errors.server(500, 'profile roster unavailable'), { kind: 'http', status: 500 });
    const result = rosterContacts({
      hasProfiles: true,
      profiles: [],
      declared: [],
      error: failure,
    });
    assert.deepEqual(result.contacts, [], 'NOT one synthetic `Principal` contact — an empty list');
    assert.equal(result.error, failure, 'the real error is handed to the screen, never swallowed');
    assert.equal(result.fromServer, false);
  });

  test('contacts: a surface with no profile route falls back to the DECLARED list', () => {
    const result = rosterContacts({ hasProfiles: false, profiles: [], declared: ['cody', 'vintage'] });
    assert.deepEqual(result.contacts.map((c) => c.name), ['cody', 'vintage']);
    assert.equal(result.error, null, 'this is not a failure: it is what that surface can honestly say');
    assert.equal(result.fromServer, false);
  });

  test('contacts: server rows are preferred, with their own labels and avatar flags', () => {
    const result = rosterContacts({
      hasProfiles: true,
      profiles: [{ name: 'cody', label: 'Cody', isDefault: true, hasAvatar: true, model: 'x' }],
      declared: ['ignored'],
    });
    assert.equal(result.contacts[0].label, 'Cody');
    assert.equal(result.contacts[0].hasAvatar, true);
    assert.equal(result.fromServer, true);
  });

  // ── R2/R9: expansion is a per-profile SET, and it round-trips ──
  test('expansion: several profiles may be open at once, and the set round-trips', async () => {
    __resetStoreProbe();
    let prefs = EMPTY_PREFS;
    prefs = toggleExpanded(prefs, 'cody');
    prefs = toggleExpanded(prefs, 'scout');
    assert.deepEqual(expandedNames(prefs).sort(), ['cody', 'scout'], 'one tap does not close the other');
    prefs = toggleExpanded(prefs, 'cody');
    assert.deepEqual(expandedNames(prefs), ['scout']);
    await saveRosterPrefs(prefs);
    const reloaded = await loadRosterPrefs();
    assert.deepEqual(expandedNames(reloaded), ['scout'], 'the user\'s expand/collapse work survives a relaunch');
    assert.deepEqual(normalizeExpanded({ cody: false, scout: 'yes', zulu: 1 }), { scout: true, zulu: true }, 'only OPEN profiles are stored');
  });

  test('expansion: opening a profile reveals ITS sessions, newest first, in place', () => {
    const contacts = rosterContacts({
      hasProfiles: true,
      profiles: [
        { name: 'cody', label: 'Cody', isDefault: true, hasAvatar: null },
        { name: 'scout', label: 'Scout', isDefault: false, hasAvatar: null },
      ],
      declared: [],
    }).contacts;
    const sessions = [
      { id: 'c-1', source: 'dashboard', profile: 'cody', title: 'Antiga', preview: 'antiga', last_active: 100 },
      { id: 'c-2', source: 'dashboard', profile: 'cody', title: 'Recente', preview: 'recente', last_active: 900 },
      { id: 's-1', source: 'dashboard', profile: 'scout', title: 'Scout 1', preview: 'x', last_active: 500 },
    ];
    const collapsed = buildRoster({ contacts, sessions, expanded: [], now: 1_700_000_000_000 });
    assert.deepEqual(collapsed.rows.map((row) => row.expanded), [false, false]);
    assert.equal(collapsed.rows.find((r) => r.name === 'cody')!.sessions.length, 0, 'collapsed: the face only');
    const open = buildRoster({ contacts, sessions, expanded: ['cody'], now: 1_700_000_000_000 });
    const cody = open.rows.find((r) => r.name === 'cody')!;
    const scout = open.rows.find((r) => r.name === 'scout')!;
    assert.equal(cody.expanded, true);
    assert.equal(scout.expanded, false, 'expansion is PER PROFILE, not a single global');
    assert.deepEqual(cody.sessions.map((s) => s.sessionId), ['c-2', 'c-1'], 'its sessions, newest first');
    assert.deepEqual(scout.sessions, []);
  });

  // ── R5: search filters profiles AND sessions, and reveals the hit under its profile ──
  test('search: the metadata sweep matches profiles and sessions, and auto-expands the hit\'s profile', () => {
    const profiles = [
      { name: 'cody', label: 'Cody' },
      { name: 'scout', label: 'Scout' },
    ];
    const sessions = [
      { id: 'a', source: 'dashboard', profile: 'scout', title: 'Orçamento de setembro', preview: 'linha 1' },
      { id: 'b', source: 'dashboard', profile: 'cody', title: 'Outra coisa', preview: 'nada aqui' },
    ];
    const result = searchRoster({ needle: 'orçamento', profiles, sessions });
    assert.deepEqual(result.hits.map((hit) => hit.sessionId), ['a']);
    assert.deepEqual(result.autoExpand, ['scout'], 'a hit inside a profile opens that profile');
    const byName = searchRoster({ needle: 'cody', profiles, sessions });
    assert.deepEqual(byName.profileHits, ['cody']);
    assert.deepEqual(byName.autoExpand, ['cody']);
    assert.deepEqual(searchRoster({ needle: '   ', profiles, sessions }).hits, [], 'a blank query searches nothing');
  });

  test('search: a hit inside a profile is rendered UNDER it — the profile opens and shows it', () => {
    const contacts = rosterContacts({
      hasProfiles: true,
      profiles: [{ name: 'scout', label: 'Scout', isDefault: false, hasAvatar: null }],
      declared: [],
    }).contacts;
    const sessions = [{ id: 'a', source: 'dashboard', profile: 'scout', title: 'Orçamento de setembro', preview: 'linha 1', last_active: 400 }];
    const search = searchRoster({ needle: 'orçamento', profiles: [{ name: 'scout', label: 'Scout' }], sessions });
    const model = buildRoster({ contacts, sessions, expanded: [], search, now: 1_700_000_000_000 });
    assert.equal(model.rows.length, 1, 'the profile that holds the hit is shown');
    assert.equal(model.rows[0].expanded, true, 'auto-expanded, without the user tapping');
    assert.deepEqual(model.rows[0].sessions.map((s) => s.sessionId), ['a']);
    assert.equal(model.matches, 1);
  });

  test('search: a body hit reveals a session the local sweep could not see', () => {
    const base = searchRoster({
      needle: 'orçamento',
      profiles: [{ name: 'scout', label: 'Scout' }],
      sessions: [{ id: 'a', source: 'dashboard', profile: 'scout', title: 'Nada', preview: 'nada' }],
    });
    assert.deepEqual(base.hits, []);
    const merged = mergeBodyHits(base, { scout: [{ session_id: 'deep-1', snippet: '>>>orçamento<<< do mês' }] });
    assert.equal(merged.hits.length, 1);
    assert.equal(merged.hits[0].source, 'body');
    assert.equal(merged.hits[0].snippet, 'orçamento do mês', 'the FTS markers are stripped');
    assert.ok(merged.autoExpand.includes('scout'));
  });

  test('search: one settled query is ONE body request, whatever the profile count', () => {
    // Measured: `?profile=all` is a 404 and an OMITTED profile serves the whole box, so the plan is
    // a single server-wide call. 22 profiles do not make 22 requests.
    assert.deepEqual(bodySearchPlan(['cody', 'scout'], 'orçamento'), ['']);
    assert.deepEqual(bodySearchPlan(Array.from({ length: 22 }, (_, i) => `p${i}`), 'x'), [''], 'still one');
    assert.deepEqual(bodySearchPlan(['cody'], '   '), [], 'nothing is fired for a blank query');
    // The per-profile route stays available, deduped and capped, for a caller that wants it:
    assert.deepEqual(bodySearchPlan(['cody', 'cody', 'scout'], 'x', { perProfile: true }), ['cody', 'scout']);
    assert.equal(bodySearchPlan(Array.from({ length: 40 }, (_, i) => `p${i}`), 'x', { perProfile: true, cap: 8 }).length, 8);
    assert.deepEqual(bodySearchPlan([], 'x', { perProfile: true }), []);
  });

  test('search: a body hit is attributed to its profile from the feed, and an unplaceable one is counted', () => {
    const sessions = [
      { id: 'a', profile: 'scout', source: 'dashboard' },
      { id: 'b', profile: 'cody', source: 'dashboard' },
    ];
    const { perProfile, unplaced } = attributeBodyHits(sessions as never[], [
      { session_id: 'a', snippet: 'um' },
      { session_id: 'b', snippet: 'dois' },
      { session_id: 'nowhere', snippet: 'três' },
    ]);
    assert.deepEqual(Object.keys(perProfile).sort(), ['cody', 'scout']);
    assert.equal(perProfile.scout[0].session_id, 'a');
    assert.equal(unplaced, 1, 'a hit that cannot be placed under a face is counted, not guessed');
  });

  // ── R7: status lights, exactly the plugin's rule ──
  test('lights: amber beats emerald, the badge shows at 2+, and "working" never colours a profile', () => {
    const now = 1_700_000_000;
    const waiting = { last_active: now - 10, last_read_at: now - 100, waiting: true };
    const unread = { last_active: now - 20, last_read_at: now - 500 };
    const reading = { last_active: now - 20, last_read_at: now - 5 };
    assert.equal(dotStateFor(waiting), 'needs-input');
    assert.equal(dotStateFor(unread), 'unread');
    assert.equal(dotStateFor(reading), 'idle');
    assert.equal(dotStateFor({ is_active: true, last_active: now, last_read_at: now }), 'idle', 'a running session is not news about the profile');
    const rollup = profileRollup([waiting, unread, reading]);
    assert.equal(rollup.state, 'needs-input', 'the LOUDEST state, not the latest session\'s');
    assert.equal(rollup.count, 2);
    assert.equal(showBadge(rollup), true, 'two awaiting things: the number appears');
    const one = profileRollup([unread, reading]);
    assert.equal(one.state, 'unread');
    assert.equal(one.count, 1);
    assert.equal(showBadge(one), false, 'one is already said by the colour');
    assert.equal(profileRollup([reading]).state, 'idle');
  });

  test('lights: a missing read watermark stays quiet — honest about what it knows', () => {
    const session = { last_active: 1_700_000_000, last_read_at: null };
    assert.equal(isUnread(session), false);
    assert.equal(dotStateFor(session), 'idle');
    assert.equal(dotStateFor({}), 'idle');
    assert.equal(dotStateFor(null), 'idle');
    // and a profile never read through contributes nothing, rather than a guessed emerald:
    assert.equal(profileRollup([session]).count, 0);
  });

  test('lights: the app\'s own lastSeen watermark still counts "new since my last visit"', () => {
    // `lastSeen` is written with `Date.now()` (milliseconds), so the comparison is ms against the
    // row's epoch-seconds converted to ms — the same heuristic `toMillis` applies everywhere else.
    const sessions = [
      { last_active: 900, last_read_at: 800 },
      { last_active: 700, last_read_at: 600 },
    ];
    assert.equal(profileRollup(sessions, 750_000).fresh, 1, 'only the one that moved after my visit');
    assert.equal(profileRollup(sessions, 0).fresh, 0, 'no watermark recorded yet = nothing claimed');
  });

  // ── R6: colour that fills, and tolerates the surface being silent ──
  test('colours: a session colour beats its profile\'s, and an absent model yields null', () => {
    const model = { profiles: { cody: '#4c8dff' }, sessions: { cody: { 'sess-9': '#f85149' } }, groups: {} };
    assert.equal(coloursFor(model, 'cody'), '#4c8dff');
    assert.equal(coloursFor(model, 'cody', 'sess-9'), '#f85149', 'the session overrides the profile');
    assert.equal(coloursFor(model, 'cody', 'other'), '#4c8dff');
    assert.equal(coloursFor(model, 'unknown'), null, 'never an invented hue');
    assert.equal(coloursFor(null, 'cody'), null);
    assert.equal(coloursFor(undefined, 'cody', 'x'), null);
  });

  test('colours: only a known swatch is ever stored, and clearing really clears', () => {
    let prefs = EMPTY_PREFS;
    prefs = setProfileColour(prefs, 'cody', SWATCHES[0]);
    prefs = setSessionColour(prefs, 'cody', 'sess-1', SWATCHES[2]);
    assert.equal(prefs.colours.profiles.cody, SWATCHES[0]);
    assert.equal(prefs.colours.sessions.cody['sess-1'], SWATCHES[2]);
    prefs = setProfileColour(prefs, 'cody', '#not-a-swatch');
    assert.equal(prefs.colours.profiles.cody, undefined, 'an unknown value is dropped, not stored raw');
    prefs = setSessionColour(prefs, 'cody', 'sess-1', null);
    assert.equal(prefs.colours.sessions.cody, undefined, 'and the per-session map goes with it');
  });

  // ── R8: the long-press verbs never destroy anything by accident ──
  test('rosterPrefs: hiding a profile hides the row and never its sessions', () => {
    const prefs = toggleHidden(EMPTY_PREFS, 'cody');
    assert.equal(isHidden(prefs, 'cody'), true);
    assert.deepEqual(expandedNames(prefs), [], 'hiding is not the same verb as collapsing');
    const back = toggleHidden(prefs, 'cody');
    assert.equal(isHidden(back, 'cody'), false);
  });

  test('roster: a search reveals a profile the local roster was hiding', () => {
    const contacts = rosterContacts({
      hasProfiles: true,
      profiles: [{ name: 'cody', label: 'Cody', isDefault: true, hasAvatar: null }],
      declared: [],
    }).contacts;
    const sessions = [{ id: 'a', source: 'dashboard', profile: 'cody', title: 'Orçamento', preview: 'x', last_active: 100 }];
    const hidden = buildRoster({ contacts, sessions, expanded: [], hidden: ['cody'], now: 1_700_000_000_000 });
    assert.equal(hidden.rows[0].hidden, true);
    const search = searchRoster({ needle: 'orçamento', profiles: [{ name: 'cody', label: 'Cody' }], sessions });
    const found = buildRoster({ contacts, sessions, expanded: [], hidden: ['cody'], search, now: 1_700_000_000_000 });
    assert.equal(found.rows[0].hidden, false, 'a hit is never hidden behind the user\'s own filter');
  });

  // ── the wire: the mock proves the app's read paths, offline ──
  const rich = createMockDashboard({
    port: 0,
    bearer: DASH_BEARER,
    bodies: {
      'orçamento': [{ session_id: 'sess-deep', profile: 'scout', snippet: '>>>orçamento<<< de setembro' }],
      // A phrase that lives ONLY in a message body of a session the feed already holds, so the
      // attribution path (and the auto-expand it triggers) can be exercised end to end.
      segredo: [{ session_id: 'chat-1', profile: 'default', snippet: 'o >>>segredo<<< está aqui' }],
    },
    profiles: [
      profileFixture('default', { has_avatar: true }),
      profileFixture('scout', { has_avatar: false, label: 'Scout' }),
    ],
    sessions: [
      sessionFixture('chat-1', { title: 'Conversa', profile: 'default', source: 'dashboard', last_active: Math.floor(Date.now() / 1000) - 60 }),
      sessionFixture('cron-1', { title: 'Scholes - Daily School Digest', profile: 'default', source: 'cron', last_active: Math.floor(Date.now() / 1000) - 30 }),
      sessionFixture('chat-2', { title: 'Orçamento de setembro', profile: 'scout', is_default_profile: false, source: 'dashboard', last_active: Math.floor(Date.now() / 1000) - 300 }),
      sessionFixture('cron-2', { title: 'Dobbs - Birthday Briefing', profile: 'scout', is_default_profile: false, source: 'cron', last_active: Math.floor(Date.now() / 1000) - 400 }),
    ],
  });
  await rich.listen();
  const dashRich = createDashboardClient(settingsFor(rich.url, { apiKey: DASH_BEARER }), { timeoutMs: 4000, rpcTimeoutMs: 4000 });

  test('dashboard: the sidebar separates recents from cron, and tags every row with its profile', async () => {
    const slices = await dashRich.sidebar('all', { recentsLimit: 50 });
    assert.deepEqual(slices.recents?.sessions.map((s) => s.id), ['chat-1', 'chat-2'], 'the feed carries no cron run');
    assert.deepEqual(slices.cron?.sessions.map((s) => s.id), ['cron-1', 'cron-2'], 'they are kept, in their own slice');
    assert.equal(slices.recents?.sessions[1].source, 'dashboard');
    assert.equal(slices.cron?.sessions[0].source, 'cron');
  });

  test('dashboard: the roster built from the live SHAPE never shows a cron run in the feed', async () => {
    const backend = createBackend(settingsFor(rich.url, { apiKey: DASH_BEARER }));
    const profiles = await backend.profiles();
    const slices = await backend.sidebar('all', { recents: 50 });
    const contacts = rosterContacts({ hasProfiles: true, profiles, declared: [] }).contacts;
    const model = buildRoster({
      contacts,
      sessions: slices.recents.map((row) => ({ ...row, source: row.source })),
      expanded: [],
      now: Date.now(),
    });
    assert.deepEqual(model.rows.map((row) => row.name), ['default', 'scout']);
    assert.equal(model.automaticSeen, 0, 'the recents slice is cron-free as served');
    // and the SAME guarantee holds if the caller uses the (cron-mixed) rail instead:
    const rail = await backend.sessions('', 200);
    const fromRail = buildRoster({ contacts, sessions: rail.data, expanded: [], now: Date.now() });
    assert.equal(fromRail.automaticSeen, 2, 'the rail does carry the runs…');
    assert.equal(
      fromRail.rows.every((row) => row.sessions.every((hit) => !hit.sessionId.startsWith('cron'))),
      true,
      '…and they are still not in the feed',
    );
    assert.equal(fromRail.rows.every((row) => row.automatic.every((hit) => hit.sessionId.startsWith('cron'))), true);
    backend.dispose();
  });

  test('dashboard: message-body search hits the FTS route and returns session_id + snippet', async () => {
    const hits = await dashRich.searchMessages('orçamento', 'scout');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].session_id, 'sess-deep');
    assert.equal(hits[0].snippet, '>>>orçamento<<< de setembro');
    assert.deepEqual(await dashRich.searchMessages('nada-disso', 'scout'), []);
    assert.ok(rich.searchCalls.length >= 2, 'the route was actually called');
  });

  test('dashboard: the cross-profile FTS plan is ONE call, and it never sends profile=all', async () => {
    const backend = createBackend(settingsFor(rich.url, { apiKey: DASH_BEARER }));
    const before = rich.searchCalls.length;
    for (const profile of bodySearchPlan(['default', 'scout'], 'segredo')) {
      await backend.searchMessages('segredo', profile);
    }
    assert.equal(rich.searchCalls.length - before, 1, 'one settled query, one request');
    assert.equal(rich.searchCalls[rich.searchCalls.length - 1].profile, 'all', 'the mock records an omitted profile as the whole box');
    assert.equal(rich.searchCalls.some((call) => call.profile === 'all' && call.q), true);
    backend.dispose();
  });

  test('dashboard: a body hit lands under the profile that owns the session', async () => {
    const backend = createBackend(settingsFor(rich.url, { apiKey: DASH_BEARER }));
    const profiles = await backend.profiles();
    const slices = await backend.sidebar('all', { recents: 50 });
    const contacts = rosterContacts({ hasProfiles: true, profiles, declared: [] }).contacts;
    const feed = slices.recents as never[];
    // The sweep finds nothing — the phrase is only in a MESSAGE BODY.
    const sweep = searchRoster({ needle: 'segredo', profiles: contacts, sessions: feed });
    assert.deepEqual(sweep.hits, [], 'the local metadata sweep cannot see a body');
    const hits = await backend.searchMessages('segredo', '');
    const { perProfile, unplaced } = attributeBodyHits(feed as never[], hits);
    const merged = mergeBodyHits(sweep, perProfile, unplaced);
    assert.equal(merged.hits.length, 1, 'the deep hit is placed');
    assert.equal(merged.hits[0].profile, 'default');
    assert.equal(merged.hits[0].source, 'body');
    const model = buildRoster({ contacts, sessions: feed as never[], expanded: [], search: merged, now: Date.now() });
    assert.equal(model.rows[0].name, 'default', 'the profile that holds it is revealed');
    assert.equal(model.rows[0].expanded, true, 'and auto-expanded');
    backend.dispose();
  });

  const broken = createMockDashboard({ port: 0, bearer: DASH_BEARER, failProfiles: true });
  await broken.listen();
  const dashBroken = createDashboardClient(settingsFor(broken.url, { apiKey: DASH_BEARER }), { timeoutMs: 4000 });

  test('dashboard: a failing /api/profiles raises a real error, so the banner can name it', async () => {
    await expectApiError(() => dashBroken.profiles(), (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.kind, 'http');
    });
    // and the roster that results from it has NO contacts and NO invented fallback:
    const backend = createBackend(settingsFor(broken.url, { apiKey: DASH_BEARER }));
    let profiles: Awaited<ReturnType<typeof backend.profiles>> = [];
    let error: unknown = null;
    try {
      profiles = await backend.profiles();
    } catch (caught) {
      error = caught;
    }
    const result = rosterContacts({ hasProfiles: backend.hasProfiles, profiles, declared: [], error });
    assert.deepEqual(result.contacts, [], 'no synthetic `Principal` contact, ever');
    assert.ok(result.error, 'the error travels to the screen');
    backend.dispose();
  });


  // ── R8: the long-press menus, as an inventory ──
  test('menus: the profile menu carries the R8 verbs, and archive-all is its only destructive one', () => {
    const entries = profileMenuEntries({
      label: 'Cody',
      hidden: false,
      canRename: true,
      canArchiveAll: true,
      sections: [{ id: 'g', name: 'G' }],
      currentSectionId: '',
    });
    const keys = entries.map((entry) => entry.key);
    for (const verb of ['new-session', 'rename', 'colour', 'group', 'sort', 'hide', 'archive-all', 'copy-id']) {
      assert.ok(keys.includes(verb), `the profile menu must offer ${verb}`);
    }
    assert.deepEqual(
      entries.filter((entry) => entry.destructive).map((entry) => entry.key),
      ['archive-all'],
      'archiving is the heaviest thing a profile menu may do — it deletes nothing',
    );
    const hidden = profileMenuEntries({ label: 'x', hidden: true, canRename: true, canArchiveAll: false, sections: [], currentSectionId: '' });
    assert.ok(hidden.some((entry) => entry.key === 'hide' && entry.label === 'unhide'), 'a hidden profile offers the way back');
    assert.equal(hidden.some((entry) => entry.destructive), false);
  });

  test('menus: the session menu offers open/rename/colour/archive/delete, delete being the one irreversible verb', () => {
    const entries = sessionMenuEntries({ title: 'Sessão', colour: null });
    const keys = entries.map((entry) => entry.key);
    for (const verb of ['open', 'rename', 'colour', 'archive', 'copy-id', 'delete']) {
      assert.ok(keys.includes(verb), `the session menu must offer ${verb}`);
    }
    assert.deepEqual(entries.filter((entry) => entry.destructive).map((entry) => entry.key), ['delete']);
  });

  test('menus: the group menu offers rename and delete, and its delete cannot name a session', () => {
    const entries = sectionMenuEntries();
    assert.deepEqual(entries.map((entry) => entry.key), ['rename-section', 'delete-section']);
    // The destructive entry is a SECTION delete. Nothing in this menu is reachable from a session,
    // which is the structural half of "deleting a group never deletes sessions".
    assert.equal(entries.filter((entry) => entry.destructive).length, 1);
    assert.deepEqual(sortEntries().map((entry) => entry.key), ['sort-activity', 'sort-name', 'sort-sessions']);
  });


  // ─────────────────────────────────────────── 0.6.0: pairing, heal, sync ──
  const fakeFetch = (routes: Record<string, (init?: RequestInit) => { status: number; body?: unknown } | Error>) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(url)}`;
      const handler = routes[key];
      if (!handler) return new Response('{"detail":"Not Found"}', { status: 404 });
      const out = handler(init);
      if (out instanceof Error) throw out;
      return new Response(out.body === undefined ? '' : JSON.stringify(out.body), { status: out.status });
    }) as typeof fetch;
  const CODE = 'Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9';
  const LINK = `personae://connect?base=${encodeURIComponent('http://box.test:9119')}&code=${CODE}&label=the user%27s%20Pixel%208&expires=4102444800`;

  test('pairing: the deep link (and the QR payload, which is the same string) parses', () => {
    const link = parseConnectLink(LINK)!;
    assert.deepEqual(link, { base: 'http://box.test:9119', code: CODE, label: "the user's Pixel 8", expires: 4102444800 });
    assert.equal(parseConnectLink('https://evil.test/?code=x'), null);
    assert.equal(parseConnectLink('personae://connect?base=ftp%3A%2F%2Fx&code=' + CODE), null);
    assert.equal(parseConnectLink('personae://connect?base=http%3A%2F%2Fx%3A9119&code=short'), null);
    assert.equal(parseConnectLink(`  ${LINK}  `)?.code, CODE, 'a pasted link with spaces still parses');
  });

  test('pairing: the in-app browser starts at login with next=/pair?app=1', () => {
    assert.equal(pairPageUrl('http://box.test:9119/', 'Pixel'), 'http://box.test:9119/login?next=%2Fpair%3Fapp%3D1%26label%3DPixel');
  });

  test('pairing: redeem sends the code as the bearer and returns the device token', async () => {
    let seenAuth = '';
    const result = await redeemPairing(parseConnectLink(LINK)!, fakeFetch({
      [`POST http://box.test:9119${REDEEM_PATH}`]: (init) => {
        seenAuth = String((init?.headers as Record<string, string>).Authorization);
        return { status: 200, body: { base_url: 'http://127.0.0.1:9119', token: 'device-token-xyz', device_id: 'dev_1', label: 'Pixel', created_at: '2026-10-11T00:00:00Z' } };
      },
    }));
    assert.equal(seenAuth, `Bearer ${CODE}`);
    assert.deepEqual(result, { baseUrl: 'http://box.test:9119', token: 'device-token-xyz', deviceId: 'dev_1', label: 'Pixel', createdAt: '2026-10-11T00:00:00Z' });
  });

  test('pairing: reused / expired / unknown / rate-limited / old server / offline are each named', async () => {
    const link = parseConnectLink(LINK)!;
    const reason = async (status: number, body: unknown = {}) => {
      try {
        await redeemPairing(link, fakeFetch({ [`POST http://box.test:9119${REDEEM_PATH}`]: () => ({ status, body }) }));
      } catch (e) {
        return (e as PairingError).reason;
      }
      return 'resolved';
    };
    assert.equal(await reason(410, { error: 'code_used' }), 'used');
    assert.equal(await reason(410, { error: 'code_expired' }), 'expired');
    assert.equal(await reason(401), 'unknown');
    assert.equal(await reason(429), 'rate_limited');
    assert.equal(await reason(404), 'no_pairing');
    assert.equal(await reason(500), 'server');
    await assert.rejects(redeemPairing(link, fakeFetch({ [`POST http://box.test:9119${REDEEM_PATH}`]: () => new Error('ECONNREFUSED') })), (e: PairingError) => e.reason === 'network');
    // a link past its own expiry never hits the network
    await assert.rejects(redeemPairing({ ...link, expires: 1 }, fakeFetch({})), (e: PairingError) => e.reason === 'expired');
  });


  test('pairing: a redeemed token becomes the credential, the used address the first route', () => {
    const before = { ...DEFAULT_SETTINGS, apiKey: 'old-static', routes: [{ role: 'public', priority: 0, url: 'https://box.ts.example:10443', insecure: false }] } as Settings;
    const patch = settingsAfterPairing(before, { baseUrl: 'http://100.64.0.2:9119', token: 'dev-tok', deviceId: 'dev_9', label: 'Pixel', createdAt: '' });
    assert.equal(patch.apiKey, 'dev-tok');
    assert.equal(patch.surface, 'dashboard');
    assert.equal(patch.deviceId, 'dev_9');
    assert.deepEqual(patch.routes!.map((r) => [r.url, r.priority]), [['http://100.64.0.2:9119', 0], ['https://box.ts.example:10443', 1]]);
    assert.equal(patch.routes![0].insecure, true, 'tailnet http: consented by pairing over it');
  });

  test('wizard probe: :9119 is the dashboard, :9222 is the gateway (the correction sentence), refused is named', async () => {
    const dash = await probeService('http://box.test:9119', fakeFetch({
      'GET http://box.test:9119/api/health': () => ({ status: 200, body: { ok: true, version: '0.21.5', auth_required: true } }),
      'GET http://box.test:9119/api/auth/providers': () => ({ status: 200, body: { providers: [{ name: 'basic' }, { name: 'personae-mobile' }] } }),
    }));
    assert.deepEqual(dash, { kind: 'dashboard', version: '0.21.5', authRequired: true, pairing: true });
    assert.deepEqual(await probeService('http://box.test:9222', fakeFetch({})), { kind: 'gateway' });
    assert.equal(dashboardAddressFor('http://box.test:9222'), 'http://box.test:9119');
    assert.match(stringsFor('pt').connect.isGateway, /hermes-gateway\.service .*não tem perfis nem sessões\. O dashboard é o :9119\./);
    assert.match(t.connect.intro, /hermes-serve\.service/);
    assert.deepEqual(await probeService('http://box.test:1', fakeFetch({ 'GET http://box.test:1/api/health': () => new Error('connect ECONNREFUSED') })), { kind: 'refused' });
    assert.deepEqual(candidateAddresses(['http://a:9222', 'http://a:9119', 'bad', 'http://b:9119']), ['http://a:9119', 'http://b:9119']);
  });

  test('heal: a dashboard surface pointed at :9222 (the user\'s 0.5.0 phone) moves to :9119, with a visible note', async () => {
    __resetStoreProbe();
    const { storeSet } = await import('../src/storage');
    await storeSet('personae.settings.v1', JSON.stringify({ baseUrl: 'http://10.9.9.9:9222', surface: 'dashboard', language: 'en', routes: [{ role: 'lan', priority: 0, url: 'http://10.9.9.9:9222', insecure: true }] }));
    const loaded = await loadSettings();
    assert.equal(loaded.baseUrl, 'http://10.9.9.9:9119');
    assert.equal(loaded.routes[0].url, 'http://10.9.9.9:9119');
    assert.match(loaded.healNote, /messaging gateway, not the dashboard/);
    // the heal is persisted: the next load is coherent and says nothing new
    const again = await loadSettings();
    assert.equal(again.baseUrl, 'http://10.9.9.9:9119');
    assert.equal(healSurface(again).note, '');
    assert.equal(healSurface({ ...DEFAULT_SETTINGS, surface: 'gateway', baseUrl: 'http://x:9119' }).settings.surface, 'dashboard');
    assert.equal(surfaceForUrl('http://x:8080'), null);
    __resetStoreProbe();
  });

  // ═══════════════ 0.7.0 B: the wizard IS Connection, and Advanced is closed ═══════════════

  test('0.7.0 B: Advanced is CLOSED by default, and nothing 0.6.1 had was deleted', () => {
    assert.equal(ADVANCED_OPEN_BY_DEFAULT, false, 'a fresh install shows no internals');
    const closed = visibleFieldIds(false);
    // SUPERSEDED IN 0.8.0 (phase D): this read `['connection', 'language', 'tailscale']`. The
    // Session-types checkboxes are a user-facing ask from the operator's own list, so they are on
    // the main screen — right after the language, and still not behind Advanced.
    assert.deepEqual(closed, ['connection', 'language', 'sessionTypes', 'notifications', 'tailscale']);
    assert.equal(closed[0], 'connection', 'Connection is the FIRST thing on the screen');
    assert.ok(!isAdvanced('sessionTypes'), 'the session-type checkboxes are NOT internals');
    assert.equal(visibleFieldIds(false).indexOf('sessionTypes'), 2, 'they sit after the language');
    const hidden: SettingsFieldId[] = [
      'surface', 'baseUrl', 'apiKey', 'profiles', 'model', 'routes',
      'tailscalePackage', 'deadlines', 'openOnFailure', 'diagnostics', 'testConnection', 'log',
    ];
    for (const id of hidden) {
      assert.ok(!closed.includes(id), `${id} must stay hidden until Advanced is opened`);
      assert.ok(isAdvanced(id), `${id} is an advanced field`);
    }
    const open = visibleFieldIds(true);
    assert.deepEqual(open, SETTINGS_FIELDS.map((field) => field.id), 'opening Advanced reveals the whole list, in order');
    assert.equal(open.length, closed.length + advancedFieldIds().length, 'nothing was deleted');
    assert.ok(open.length > closed.length);
  });

  test('0.7.0 B: the wizard has exactly three steps, every one drawn in place', () => {
    assert.deepEqual(wizardStepIds(), ['service', 'sign-in', 'check']);
    assert.deepEqual(WIZARD_STEP_IDS, ['service', 'sign-in', 'check']);
    const steps = wizardSteps();
    assert.equal(steps.length, 3);
    assert.ok(steps.every((step) => step.inline), 'no step hides behind a navigation');
    assert.ok(isInlineWizard());
    assert.ok(connectionRendersWizard(), 'Connection IS the wizard');
    // The in-suite language is PT; the titles are the live table's, never a cached literal.
    assert.equal(steps[0].title, t.connect.step1);
    assert.equal(steps[1].title, t.connect.step2);
    assert.equal(steps[2].title, t.connect.step3);
    assert.ok(steps.every((step) => step.title.trim().length > 0));
  });

  test('0.7.0 B: ONE wizard, TWO hosts — the step logic exists in exactly one file', () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'app'));
    const owners = files.filter((file) => /t\.connect\.step[123]/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(
      owners.map((file) => file.slice(root.length + 1)),
      [join('src', 'connect', 'wizard.ts')],
      'the three step headings live in wizard.ts and nowhere else — no copy-paste',
    );
    const route = readFileSync(join(root, 'app', 'connect.tsx'), 'utf8');
    const settings = readFileSync(join(root, 'app', 'settings.tsx'), 'utf8');
    assert.match(route, /ConnectWizard/, 'the deep-link route renders the shared wizard');
    assert.match(settings, /ConnectWizard/, 'and so does Settings');
    assert.ok(route.split('\n').length < 40, `app/connect.tsx is a wrapper, not a second wizard (${route.split('\n').length} lines)`);
    const wizard = readFileSync(join(root, 'src', 'connect', 'Wizard.tsx'), 'utf8');
    assert.match(wizard, /parseConnectLink/, 'the deep link is still parsed and redeemed, in the shared implementation');
    assert.match(wizard, /useLocalSearchParams/, 'and the query still arrives as route params');
  });

  test('0.7.0 B: the Settings screen is wired to the plan (not to ad-hoc conditionals)', () => {
    const src = readFileSync(join(process.cwd(), 'app', 'settings.tsx'), 'utf8');
    assert.match(src, /useState\(ADVANCED_OPEN_BY_DEFAULT\)/, 'the disclosure opens closed, from the plan');
    assert.match(src, /advancedOpen \?/, 'the advanced fields are conditional on it');
    assert.match(src, /t\.connectivity\.logIn/, 'Tailscale offers Log in');
    assert.match(src, /t\.connectivity\.chooseDevice/, 'Tailscale offers Choose device');
    assert.match(src, /t\.connectivity\.autoConnect\b/, 'and the auto-connect switch');
    assert.match(src, /probeTcp/, 'a picked device is probed before its route is written');
    assert.ok(!/router\.push\('\/connect'\)/.test(src), 'Settings no longer pushes to the wizard route');
  });

  // ═══════════════ 0.7.0 B: the tailnet device picker ═══════════════

  test('0.7.0 B: the peers payload is read in BOTH shapes; junk is unavailable, never a guess', () => {
    const ready = normalizePeers({
      available: true,
      self: { name: 'personae-sk', ip: '100.64.0.11', os: 'linux', online: true },
      peers: [
        { name: 'Personae-DS', ip: '100.64.0.13', os: 'linux', online: true },
        { name: 'broken' },
      ],
    });
    assert.equal(ready.available, true);
    assert.equal(peersState(ready), 'ready');
    assert.equal(ready.self?.ip, '100.64.0.11');
    assert.deepEqual(ready.peers, [{ name: 'Personae-DS', ip: '100.64.0.13', os: 'linux', online: true }], 'a row with no ip is dropped');

    const empty = normalizePeers({ available: true, self: { name: 'solo', ip: '100.1.2.3', os: 'linux', online: true }, peers: [] });
    assert.equal(peersState(empty), 'empty', 'a one-node tailnet is a real answer, not a failure');

    const missing = normalizePeers({ available: false, reason: 'cli_missing' });
    assert.deepEqual(missing, { available: false, peers: [], reason: 'cli_missing' });
    assert.equal(peersState(missing), 'unavailable');
    assert.equal(normalizePeers(null).reason, 'bad_response');
    assert.equal(normalizePeers(undefined).reason, 'bad_response');
    assert.equal(normalizePeers({ error: 'unauthenticated', detail: 'Unauthorized' }).reason, 'unavailable');
    assert.equal(normalizePeers([{ name: 'x', ip: '100.0.0.1' }]).available, false, 'a bare list is not the contract');
  });

  test('0.7.0 B: a picked device becomes a tailscale ROUTE, and a duplicate is refused', () => {
    const existing: RouteCandidate[] = [{ role: 'lan', priority: 0, url: 'http://10.0.0.15:9119', insecure: true }];
    const peer: PeerRow = { name: 'Personae-DS', ip: '100.64.0.13', os: 'linux', online: true };
    const picked = peerRoute(peer, { port: 9119, routes: existing, insecureAck: false });
    assert.ok(picked, 'a new device produces a route');
    assert.equal(picked.role, 'tailscale', 'inferred from the 100.x address, not asserted by hand');
    assert.equal(picked.url, 'http://100.64.0.13:9119');
    assert.equal(picked.priority, 1, 'appended below everything already in the list');
    assert.equal(picked.insecure, true, 'it is a plain-http route and it says so');
    assert.equal(peerRoute(peer, { port: 9119, routes: [...existing, picked], insecureAck: false }), null, 'the same address is not added twice');
    // the port comes from the paired address, never invented
    assert.equal(peersPort(settingsFor('http://10.0.0.15:9119')), 9119);
    assert.equal(peersPort(settingsFor('https://personae-sk.tail0000demo.ts.net')), 443);
    assert.equal(peersPort(settingsFor('')), 9119);
  });

  test('0.7.0 B: the peer list rides the app credential, and the legacy surface never calls it', async () => {
    const before = dashboard.calls.length;
    const raw = await dash.tailscalePeers();
    const parsed = normalizePeers(raw);
    assert.equal(parsed.available, true);
    assert.deepEqual(parsed.peers.map((row) => row.ip), ['100.64.0.2', '100.64.0.3']);
    assert.deepEqual(
      dashboard.calls.slice(before).map((call) => call.path),
      ['/api/plugins/personae-mobile-auth/tailscale/peers'],
      'one request, to the plugin route',
    );

    // The Backend normalises it, so the screen never touches a raw body.
    const live = createBackend(settingsFor(dashboard.url, { apiKey: DASH_BEARER }));
    assert.equal((await live.tailscalePeers()).available, true);
    live.dispose();

    // The api_server surface has no such route: it says so without a request.
    const legacy = createBackend(settingsFor('http://127.0.0.1:9222', { apiKey: 'k', surface: 'gateway' }));
    const unavailable = await legacy.tailscalePeers();
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.reason, 'unsupported_surface');
    legacy.dispose();
  });

  test('0.7.0 B: an unavailable host answers the unavailable SHAPE, not an error', async () => {
    const offline = createMockDashboard({ port: 0, peersUnavailable: true });
    await offline.listen();
    try {
      const client = createDashboardClient(settingsFor(offline.url, { apiKey: offline.config.bearer }), { timeoutMs: 4000 });
      const parsed = normalizePeers(await client.tailscalePeers());
      assert.deepEqual(parsed, { available: false, peers: [], reason: 'cli_missing' });
      assert.equal(peersState(parsed), 'unavailable');
    } finally {
      await offline.close();
    }
  });

  // ═══════════════ 0.7.0 C: ONE "+" at the top of the roster ═══════════════

  test('0.7.0 C: the "+" offers exactly three verbs', () => {
    const entries = plusMenuEntries({ surface: 'dashboard', refusal: null });
    assert.deepEqual(entries.map((entry) => entry.key), ['new-group', 'new-profile', 'new-session']);
    assert.deepEqual(entries.map((entry) => entry.label), ['newGroup', 'newProfile', 'newSession']);
    assert.ok(entries.every((entry) => entry.icon && !entry.disabled), 'nothing is disabled when it can work');
    assert.ok(entries.every((entry) => !entry.reason));
    assert.equal(PLUS_KEYS.length, 3);
  });

  test('0.7.0 C: the profile picker lists EVERY profile from /api/profiles', () => {
    const profiles = [
      { name: 'default', label: 'Main' },
      { name: 'cody', label: 'cody' },
      { name: 'design-guardian', label: 'Design Guardian' },
    ];
    const rows = profilePickerEntries(profiles);
    assert.equal(rows.length, profiles.length, 'no profile is left out of the modal');
    assert.deepEqual(rows.map((row) => profileFromPickerKey(row.key)), ['default', 'cody', 'design-guardian']);
    assert.equal(rows[0].label, 'Main · default', 'a label that differs from the name shows both');
    assert.equal(rows[1].label, 'cody');
    assert.equal(profileFromPickerKey('new-group'), '', 'a key that is not a profile resolves to nothing');
  });

  test('0.7.0 C: a refused POST /api/profiles disables the entry WITH the reason', () => {
    const refused = plusMenuEntries({
      surface: 'dashboard',
      refusal: { status: 403, message: 'This credential may not create profiles.' },
    });
    const profileEntry = refused.find((entry) => entry.key === 'new-profile');
    assert.ok(profileEntry, 'the entry is shown, not removed');
    assert.equal(profileEntry.disabled, true);
    assert.match(profileEntry.reason ?? '', /may not create profiles/, 'the server\'s own reason is visible');
    // the other two verbs are untouched by a profile refusal
    assert.ok(!refused.find((entry) => entry.key === 'new-group')?.disabled);
    assert.ok(!refused.find((entry) => entry.key === 'new-session')?.disabled);

    // the legacy :9222 surface has no profile route at all — same treatment, different reason
    const legacy = plusMenuEntries({ surface: 'gateway', refusal: null });
    const legacyProfile = legacy.find((entry) => entry.key === 'new-profile');
    assert.equal(legacyProfile?.disabled, true);
    assert.equal(legacyProfile?.reason, t.plus.createUnavailable);
    assert.ok(!legacy.find((entry) => entry.key === 'new-session')?.disabled, 'sessions still work on :9222');
  });

  test('0.7.0 C: a typed profile name becomes the dashboard\'s own name shape', () => {
    assert.equal(profileSlug('Research Notes'), 'research-notes');
    assert.equal(profileSlug('  Beta  '), 'beta');
    assert.equal(profileSlug('Zé das Couves'), 'ze-das-couves');
    assert.equal(profileSlug('a'.repeat(50))?.length, 32, 'capped like the group ids');
    assert.equal(profileSlug('!!!'), null, 'nothing usable means no request is made');
    assert.equal(profileSlug(''), null);
  });

  test('0.7.0 C: the roster header is wired to the "+" — one control, three verbs, no leftovers', () => {
    const src = readFileSync(join(process.cwd(), 'app', 'index.tsx'), 'utf8');
    assert.match(src, /name="add"/, 'the header control is a "+"');
    assert.match(src, /plusMenuEntries\(/, 'and it opens the three-verb dropdown');
    assert.match(src, /profilePickerEntries\(roster\.contacts\)/, 'New session picks an owner from every profile');
    assert.match(src, /roster\.createProfile\(/, 'New profile calls the real endpoint through the roster hook');
    assert.match(src, /profileFromPickerKey/, 'the picked row resolves to a profile name');
    assert.ok(
      !/name="folder-outline" size=\{16\} color=\{colors\.text\}/.test(src),
      'the old standalone group button is gone — its verb lives in the dropdown now',
    );
  });

  test('0.7.0 C: New profile posts to /api/profiles and the roster refreshes from it', async () => {
    const before = dashboard.createdProfiles.length;
    const created = await dash.createProfile({ name: 'gate-probe' });
    assert.equal(created.ok, true);
    assert.equal(created.name, 'gate-probe');
    assert.match(String(created.path), /profiles\/gate-probe$/);
    assert.deepEqual(dashboard.createdProfiles.slice(before), ['gate-probe'], 'exactly one POST, with the name asked for');
    const post = dashboard.calls.filter((call) => call.path === '/api/profiles' && call.method === 'POST').at(-1);
    assert.equal(post?.body?.clone_from_default, true, 'the documented ProfileCreate body');
    assert.equal(post?.body?.name, 'gate-probe');
    // the roster's source of truth now carries it, which is what "refresh the roster" means
    const profiles = await dash.profiles();
    assert.ok(profiles.some((row) => row.name === 'gate-probe'));

    // a refusal travels through the shared error ladder with its status, so the UI can explain it
    const refusing = createMockDashboard({ port: 0, profileCreateStatus: 403 });
    await refusing.listen();
    try {
      const client = createDashboardClient(settingsFor(refusing.url, { apiKey: refusing.config.bearer }), { timeoutMs: 4000 });
      await expectApiError(() => client.createProfile({ name: 'nope' }), (error) => {
        assert.equal(error.status, 403);
        assert.match(String(error.detail ?? error.message), /may not create profiles/);
      });
    } finally {
      await refusing.close();
    }
  });

  // ── the sync client ──
  const fakeServer = () => {
    const keys: Record<string, { entries: Record<string, { value: unknown; rev: number }>; tomb: Record<string, number> }> = {};
    const view = () => ({ version: 1, keys: Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, {
      value: Object.fromEntries(Object.entries(s.entries).map(([n, e]) => [n, e.value])),
      rev: Math.max(0, ...Object.values(s.entries).map((e) => e.rev), ...Object.values(s.tomb)),
    }])) });
    const puts: PutBody[] = [];
    const remote: Remote & { puts: PutBody[]; offline: boolean; missing: boolean } = {
      puts, offline: false, missing: false,
      async get() { if (remote.offline) throw new Error('offline'); return remote.missing ? null : view(); },
      async put(body) {
        if (remote.offline) throw new Error('offline');
        if (remote.missing) return null;
        puts.push(JSON.parse(JSON.stringify(body)));
        for (const t of body.tombstones) {
          const s = (keys[t.key] ??= { entries: {}, tomb: {} });
          if (s.entries[t.entry] && t.rev > s.entries[t.entry].rev) delete s.entries[t.entry];
          s.tomb[t.entry] = Math.max(s.tomb[t.entry] ?? -1, t.rev);
        }
        for (const [k, item] of Object.entries(body.keys)) {
          const s = (keys[k] ??= { entries: {}, tomb: {} });
          for (const [n, v] of Object.entries(item.value)) {
            if (item.rev <= (s.tomb[n] ?? -1)) continue;
            if (!s.entries[n] || item.rev > s.entries[n].rev) s.entries[n] = { value: v, rev: item.rev };
          }
        }
        return view();
      },
    };
    return { remote, keys, view };
  };
  const harness = (remote: Remote) => {
    const timers: { fn: () => void; ms: number }[] = [];
    let saved: SyncMeta | null = null;
    const adopted: Record<string, unknown> = {};
    const sync = createUiSync({
      remote,
      loadMeta: async () => (saved ? JSON.parse(JSON.stringify(saved)) : null),
      saveMeta: async (m) => { saved = JSON.parse(JSON.stringify(m)); },
      onRemote: (k, v) => { adopted[k] = v; },
      setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
      clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    });
    const run = async (max = 20) => { while (timers.length && max-- > 0) { const t0 = timers.shift()!; t0.fn(); await new Promise((r) => setTimeout(r, 0)); } };
    return { sync, timers, adopted, run, meta: () => saved };
  };
  const SECTIONS = { sections: [{ id: 'g1', name: 'Work' }], members: { cody: 'g1' }, collapsed: [], order: {}, sort: { g1: 'name' } };

  test('sync: seed — an empty server receives the phone\'s groups, once, with rev 1', async () => {
    const { remote } = fakeServer();
    const h = harness(remote);
    assert.equal(await h.sync.start({ 'sections-v1': SECTIONS }), 'synced');
    await h.run();
    assert.equal(remote.puts.length, 1);
    assert.deepEqual(remote.puts[0].keys['sections-v1'], { value: SECTIONS, rev: 1 });
  });

  test('sync: seed never overwrites a server value — the desktop\'s groups are ADOPTED', async () => {
    const { remote } = fakeServer();
    await remote.put({ keys: { 'sections-v1': { value: { ...SECTIONS, sort: { g1: 'activity' } }, rev: 7 } }, tombstones: [] });
    remote.puts.length = 0;
    const h = harness(remote);
    await h.sync.start({ 'sections-v1': SECTIONS });
    await h.run();
    assert.equal(remote.puts.length, 0, 'nothing pushed over the server value');
    assert.deepEqual((h.adopted['sections-v1'] as typeof SECTIONS).sort, { g1: 'activity' });
  });

  test('sync: a local change pushes once after the debounce, rev above the server\'s; removals are tombstones', async () => {
    const { remote } = fakeServer();
    await remote.put({ keys: { 'session-colors-v1': { value: { cody: { s1: '#4c8dff' }, dobbs: { s9: '#3fb950' } }, rev: 4 } }, tombstones: [] });
    remote.puts.length = 0;
    const h = harness(remote);
    await h.sync.start({});
    h.sync.noteLocal('session-colors-v1', { cody: { s1: '#f85149' } });
    h.sync.noteLocal('session-colors-v1', { cody: { s1: '#a371f7' } }); // coalesced
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 1500);
    await h.run();
    assert.equal(remote.puts.length, 1);
    const put = remote.puts[0];
    assert.equal(put.keys['session-colors-v1'].rev, 5);
    assert.deepEqual(put.keys['session-colors-v1'].value, { cody: { s1: '#a371f7' } });
    assert.deepEqual(put.tombstones, [{ key: 'session-colors-v1', entry: 'dobbs', rev: 5 }]);
    const after = await remote.get();
    assert.deepEqual(after!.keys!['session-colors-v1'].value, { cody: { s1: '#a371f7' } });
  });

  test('sync: offline queues (local edit kept), retries with backoff, flushes on reconnect', async () => {
    const { remote } = fakeServer();
    const h = harness(remote);
    await h.sync.start({});
    remote.offline = true;
    h.sync.noteLocal('sections-v1', SECTIONS);
    await h.run(3); // first attempt fails, a backoff retry is scheduled... and fails again
    assert.equal(h.sync.status(), 'offline');
    assert.ok(h.meta()!.dirty['sections-v1'], 'the edit is still queued, persisted');
    remote.offline = false;
    h.sync.online();
    await h.run();
    assert.equal(h.sync.status(), 'synced');
    assert.deepEqual(remote.puts.at(-1)!.keys['sections-v1'].value, SECTIONS);
    assert.equal(h.meta()!.dirty['sections-v1'], undefined);
  });

  test('sync: a 404 (older messenger plugin) is silent local-only, no retries', async () => {
    const { remote } = fakeServer();
    remote.missing = true;
    const h = harness(remote);
    assert.equal(await h.sync.start({ 'sections-v1': SECTIONS }), 'unsupported');
    h.sync.noteLocal('sections-v1', SECTIONS);
    assert.equal(h.timers.length, 0);
  });

  test('sync: revs only increase across failures and restarts', async () => {
    const meta = { ...JSON.parse(JSON.stringify(EMPTY_META)), revs: { 'sections-v1': 3 }, serverRevs: { 'sections-v1': 9 }, dirty: { 'sections-v1': SECTIONS } };
    const body = buildPut(meta)!;
    assert.equal(body.keys['sections-v1'].rev, 10);
    meta.dirty['sections-v1'] = SECTIONS;
    assert.equal(buildPut(meta)!.keys['sections-v1'].rev, 11);
  });

  // ─────────────────────────────── 0.9.0 Phase A: the state surface ──
  // The plugin's verbs call the DASHBOARD'S OWN endpoint functions server-side; the mock mutates the
  // same `sessions` fixtures the PATCH/DELETE routes do, so "one behaviour, two doors" is provable
  // here rather than asserted in a comment.
  const stateMock = createMockDashboard({
    port: 0,
    bearer: DASH_BEARER,
    profiles: [profileFixture('default')],
    sessions: [
      sessionFixture('sess-open', { title: 'Aberta', profile: 'default' }),
      sessionFixture('sess-pin', { title: 'Fixada', profile: 'default', pinned: true }),
    ],
  });
  await stateMock.listen();
  const httpPaths = (mock: { calls: { kind?: string; method?: string; path?: string }[] }) =>
    mock.calls.filter((call) => !call.kind || call.kind === 'http').map((call) => `${call.method} ${call.path}`);

  test('0.9.0 A: archive and delete ride the state verbs when the host mounts the plugin', async () => {
    const backend = createBackend(settingsFor(stateMock.url, { apiKey: DASH_BEARER }));
    await backend.archiveSession('sess-open', 'default');
    await backend.deleteSession('sess-open', 'default');
    const seen = httpPaths(stateMock);
    assert.ok(
      seen.includes('POST /api/plugins/personae-mobile-state/sessions/sess-open/archive'),
      `archive must reach the state verb, got ${seen.join(' | ')}`,
    );
    assert.ok(seen.includes('POST /api/plugins/personae-mobile-state/sessions/sess-open/delete'));
    // …and it is the SAME state the core routes touch: one behaviour, two doors.
    assert.equal(stateMock.sessions.find((row: { id: string }) => row.id === 'sess-open'), undefined);
    backend.dispose();
  });

  test('0.9.0 A: a PINNED session is refused with a machine-readable code, never silently archived', async () => {
    const backend = createBackend(settingsFor(stateMock.url, { apiKey: DASH_BEARER }));
    await expectApiError(
      () => backend.archiveSession('sess-pin', 'default'),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'pinned', 'the reason must be a code, not a sentence to string-match');
        assert.match(error.message, /pinned/i);
      },
    );
    assert.equal(
      stateMock.sessions.find((row: { id: string; archived?: boolean }) => row.id === 'sess-pin')?.archived,
      false,
      'it stays un-archived',
    );
    backend.dispose();
  });

  test('0.9.0 A: without the plugin the same verbs FALL BACK to the dashboard verbs', async () => {
    const older = createMockDashboard({
      port: 0,
      bearer: DASH_BEARER,
      statePlugin: false,
      profiles: [profileFixture('default')],
      sessions: [sessionFixture('sess-fb', { title: 'Sem plugin', profile: 'default' })],
    });
    await older.listen();
    const backend = createBackend(settingsFor(older.url, { apiKey: DASH_BEARER }));
    await backend.archiveSession('sess-fb', 'default');
    await backend.deleteSession('sess-fb', 'default');
    const seen = httpPaths(older);
    assert.ok(seen.includes('PATCH /api/sessions/sess-fb'), `the dashboard verb must be used, got ${seen.join(' | ')}`);
    assert.ok(seen.includes('DELETE /api/sessions/sess-fb'));
    assert.equal(older.sessions.length, 0, 'the fallback really deleted it');
    backend.dispose();
    await older.close();
  });

  test('0.9.0 A: the legacy surface ATTEMPTS the verb and reports it; the 501 stub is gone', async () => {
    const legacyCalls = gateway.calls.length;
    const backend = createBackend(settingsFor(gateway.url, { surface: 'gateway' }));
    await expectApiError(
      () => backend.archiveSession('sess-x', ''),
      (error) => {
        assert.equal(error.status, 501);
        assert.match(error.message, /arquivar não é suportado|archiving is not supported/);
      },
    );
    const attempted = gateway.calls.slice(legacyCalls).map((call) => `${call.method} ${call.path}`);
    assert.ok(
      attempted.some((entry) => entry.startsWith('POST /api/plugins/personae-mobile-state/sessions/sess-x/archive')),
      `the verb must be ATTEMPTED before it is refused, got ${attempted.join(' | ')}`,
    );
    assert.ok(!/503|501/.test(attempted.join(' ')), 'and no route answers 501 on the server side');
    backend.dispose();
  });

  test('0.9.0 A: the portable-preference document round-trips; a device-local key is refused', async () => {
    const backend = createBackend(settingsFor(stateMock.url, { apiKey: DASH_BEARER }));
    const empty = await backend.preferences();
    assert.ok(empty && empty.revision === 0 && Object.keys(empty.preferences).length === 0, 'missing plugin → null');
    const first = await backend.putPreferences({ preferences: { notifications: { enabled: true } } });
    assert.equal((first?.preferences as Record<string, { enabled: boolean }>).notifications.enabled, true);
    const second = await backend.putPreferences({
      revision: first?.revision,
      preferences: { 'session-types': { sessions: true, automatic: false } },
    });
    const merged = second?.preferences as Record<string, unknown>;
    assert.ok(merged.notifications && merged['session-types'], 'two devices editing different keys both survive');
    await expectApiError(
      () => backend.putPreferences({ preferences: { 'api-key': 'never' } }),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'bad_request');
        assert.match(error.message, /device-local/, 'the refusal\'s sentence must reach the user');
      },
    );
    // …and an absent plugin is an answer, not a throw
    const bare = createBackend(settingsFor(`http://127.0.0.1:1`, { apiKey: DASH_BEARER }));
    assert.equal(await bare.preferences().catch(() => 'threw'), null);
    bare.dispose();
    backend.dispose();
  });

  test('0.9.0 A: the state surface has exactly ONE prefix, written in exactly one file', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
      }
      return out;
    };
    const hits = walk(join(process.cwd(), 'src')).filter((file) =>
      readFileSync(file, 'utf8').includes("'/api/plugins/personae-mobile-state'"),
    );
    assert.deepEqual(
      hits.map((file) => file.split('/src/')[1]),
      ['api/client.ts'],
      'the prefix is a constant, not a string copied into every call site',
    );
  });

  // ─────────────────────────────────────────────────────── report ──
  let index = 0;
  for (const item of tests) {
    index += 1;
    try {
      await item.fn();
      process.stdout.write(`ok ${index} - ${item.name}\n`);
    } catch (error) {
      failures += 1;
      process.stdout.write(`not ok ${index} - ${item.name}\n`);
      process.stdout.write(`  ${(error as Error).message.split('\n').join('\n  ')}\n`);
    }
  }
  live.close?.();
  await dashboard.close();
  await rich.close();
  await broken.close();
  await gateway.close();
  process.stdout.write(`\n${tests.length - failures}/${tests.length} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
