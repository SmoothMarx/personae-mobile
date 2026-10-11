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
import { SSEParser, parseFrame } from '../src/api/sse';
import { createApi } from '../src/api/client';
import { nodeTransport } from '../src/api/transportNode';
import { ApiError } from '../src/api/errors';
import { checkBaseUrl, splitProfiles, profilePrefix, type Settings } from '../src/settings';
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
  return { baseUrl: url, apiKey: KEY, profiles: [], model: '', ...overrides };
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
    const settings: Settings = { baseUrl: 'http://127.0.0.1:8791', apiKey: 'k-1', profiles: ['cody'], model: 'm' };
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
    assert.deepEqual(await loadSettings(), { baseUrl: '', apiKey: '', profiles: [], model: '' });
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
  await gateway.close();
  process.stdout.write(`\n${tests.length - failures}/${tests.length} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
