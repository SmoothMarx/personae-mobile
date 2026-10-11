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
import { connectThrough, createProbeCache } from '../src/connectivity';
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
import { checkBaseUrl, DEFAULT_SETTINGS, splitProfiles, profilePrefix, type Settings } from '../src/settings';
import { loadSettings, saveSettings, loadLastSeen, saveLastSeen } from '../src/settingsStore';
import { __resetStoreProbe } from '../src/storage';
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
  attributeBodyHits,
  automaticRuns,
  bodySearchPlan,
  buildRoster,
  coloursFor,
  conversations,
  isAutomatic,
  mergeBodyHits,
  rosterContacts,
  searchRoster,
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
import { t } from '../src/i18n';
import { profileMenuEntries, sectionMenuEntries, sessionMenuEntries, sortEntries } from '../src/roster/menus';

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
  assert.equal(AVATAR_SIZE, 28, 'the plan fixes 28 px');
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
