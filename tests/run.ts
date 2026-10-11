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
import { createMockDashboard } from '../mock/dashboard.mjs';
import { createDashboardClient, type GatewayEvent } from '../src/api/dashboard';
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
import { buildItems, sortMessages } from '../src/logic/thread';
import { contentToText, formatAge, formatDate, formatDateTime, formatHours, initialOf } from '../src/format';

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

  test('thread: a tool call attached to an assistant row still collapses', () => {
    const items = buildItems([{ id: 'a', role: 'assistant', content: 'vou ver', tool_calls: [{ id: 'x' }] }]);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'tools');
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
  await gateway.close();
  process.stdout.write(`\n${tests.length - failures}/${tests.length} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
