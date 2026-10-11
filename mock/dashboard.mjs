/**
 * Local mock of the Hermes **dashboard** (the surface the app targets from 0.4.0 on).
 *
 * Purpose: exercise the dashboard client — REST + `/api/ws` — end to end OFFLINE, so every later
 * phase (avatars, live tool activity, the top-bar title) is testable without the live box. It is
 * never evidence about the running dashboard; `PROGRESS.md` says what was measured against the
 * real one instead.
 *
 * Shapes copied from the serving code:
 *   GET  /api/profiles                  web_routers/profiles.py:798  -> {profiles:[row]}
 *                                       row carries `has_avatar` (methods_profiles.py:277)
 *   GET  /api/profiles/sessions         web_routers/profiles.py:452  -> {sessions,total,profile_totals,…}
 *   GET  /api/profiles/sessions/sidebar web_routers/profiles.py:510  -> {recents,cron,messaging,usage}
 *   GET  /api/sessions                  web_routers/sessions.py:177  -> {sessions,total,limit,offset}
 *   GET  /api/sessions/{id}             web_routers/sessions.py:524
 *   GET  /api/sessions/{id}/messages    web_routers/sessions.py:685  -> {messages:[…],pagination}
 *   PATCH /api/sessions/{id}            web_routers/sessions.py:849  -> {ok,title}
 *   POST /api/auth/ws-ticket            dashboard_auth/routes.py:485 -> {ticket,ttl_seconds}
 *   /api/ws                             tui_gateway/ws.py — newline-delimited JSON-RPC,
 *                                       `gateway.ready` right after accept,
 *                                       `profiles.get_asset` (methods_profiles.py:446),
 *                                       `prompt.submit` (methods_prompt.py:657), events
 *                                       `message.delta` / `tool.start` / `tool.complete`
 *                                       (agent_callbacks.py:62-91).
 *
 * Fail-closed auth, like the real gate: no bearer -> 401 `{"error":"unauthenticated",
 * "detail":"Unauthorized","reason":"no_cookie","login_url":"/login"}`; a registered token route
 * (the sidebar) answers the seam's own body (no `reason`/`login_url`) — same distinction
 * `logs/p0.1-spike.txt` measured on the live dashboard.
 *
 * Run standalone:  node mock/dashboard.mjs      (port 8792, bearer "test-bearer-…")
 */

import crypto from 'node:crypto';
import http from 'node:http';

const DEFAULTS = {
  port: 8792,
  bearer: 'test-bearer-0123456789abcdef0123456789abcdef',
  ticketTtlSeconds: 30,
  /** Paths registered with `register_token_route` in the real plugin — bearer-only, seam body. */
  tokenRoutes: ['/api/profiles/sessions/sidebar'],
  /** Make `/api/profiles` answer 500, so the "no fabricated contact" rule can be pinned (F7). */
  failProfiles: false,
  /**
   * Message bodies the FTS route can find: `{needle: [{session_id, profile, role, snippet}]}`.
   * Keyed by a lower-cased substring; empty by default so a query with no fixture answers `[]`.
   */
  bodies: null,
  /** GET …/personae-mobile-auth/tailscale/peers — 0.7.0's device picker source. */
  peers: null,
  /** Make the peers route answer the `{available:false, reason}` shape instead. */
  peersUnavailable: false,
  /** POST /api/profiles: any non-200 simulates the refusal the app must render honestly. */
  profileCreateStatus: 200,
};

const AVATAR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export function profileFixture(name, overrides = {}) {
  return {
    name,
    label: name === 'default' ? 'Principal' : name,
    path: `/home/mock/.hermes${name === 'default' ? '' : `/profiles/${name}`}`,
    is_default: name === 'default',
    model: 'mock-model-a',
    provider: 'mock',
    has_env: true,
    has_avatar: false,
    skill_count: 3,
    gateway_running: true,
    description: `Perfil ${name}`,
    ...overrides,
  };
}

export function sessionFixture(id, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    title: `Sessão ${id}`,
    preview: 'Olá, tudo bem?',
    profile: 'default',
    is_default_profile: true,
    model: 'mock-model-a',
    source: 'dashboard',
    started_at: now - 3600,
    last_active: now - 600,
    message_count: 4,
    tool_call_count: 2,
    input_tokens: 100,
    output_tokens: 50,
    pinned: false,
    archived: false,
    hidden: false,
    is_active: false,
    last_read_at: now - 900,
    parent_session_id: null,
    ...overrides,
  };
}

function messageFixture(id, role, content, offsetSeconds, overrides = {}) {
  return {
    id,
    session_id: 'sess-1',
    role,
    content,
    timestamp: Math.floor(Date.now() / 1000) - offsetSeconds,
    display_kind: null,
    ...overrides,
  };
}

function unauthenticatedBody(tokenRoute) {
  return tokenRoute
    ? { error: 'unauthenticated', detail: 'Unauthorized' }
    : { error: 'unauthenticated', detail: 'Unauthorized', reason: 'no_cookie', login_url: '/login' };
}

/** SHA-1 of the client key, per RFC 6455 — the mock is a real WebSocket server, no dependencies. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload, 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

/** Decode one client frame (masked, per spec). Returns {opcode, payload} or null when incomplete. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload: payload.toString('utf8'), consumed: offset + length };
}

export function createMockDashboard(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const profiles = options.profiles ?? [
    profileFixture('default', { has_avatar: true }),
    profileFixture('beta', { has_avatar: false }),
  ];
  const sessions = options.sessions ?? [
    sessionFixture('sess-1'),
    sessionFixture('sess-2', { title: 'Outra conversa', profile: 'beta', is_default_profile: false, last_active: Math.floor(Date.now() / 1000) - 86400 }),
  ];
  const calls = [];
  /** Every FTS call, so a test can prove search is one batch per settled query, not per keystroke. */
  const searchCalls = [];
  /** Names POSTed to /api/profiles, so a test can prove what was asked for. */
  const createdProfiles = [];
  const tickets = new Map();
  const sockets = new Set();
  let seq = 0;
  const events = []; // what the fake dispatch emitted, for assertions
  /** The port actually bound; `config.port === 0` means the OS picks a free one. */
  let boundPort = config.port;

  const emit = (socket, type, payload, sessionId) => {
    seq += 1;
    const frame = { jsonrpc: '2.0', method: 'event', params: { type, payload, session_id: sessionId, seq } };
    events.push({ type, payload, session_id: sessionId, seq });
    if (socket && !socket.destroyed) socket.write(encodeFrame(`${JSON.stringify(frame)}\n`));
  };

  const messagesFor = (sessionId) => [
    messageFixture('m1', 'user', 'Olá', 120),
    messageFixture('m2', 'assistant', 'Olá! Como posso ajudar?', 110, { reasoning: 'O utilizador cumprimenta.' }),
    messageFixture('m3', 'assistant', '', 105, {
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
    }),
    messageFixture('m4', 'tool', 'conteúdo do ficheiro', 104, { tool_call_id: 'call_1', tool_name: 'read_file' }),
    messageFixture('m5', 'assistant', '', 103, { tool_calls: [{ id: 'call_2', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] }),
    messageFixture('m6', 'tool', 'ok', 102, { tool_call_id: 'call_2', tool_name: 'shell', display_kind: 'hidden' }),
    messageFixture('m7', 'assistant', 'São 14 horas.', 100),
    // orphan tool result: no matching call id anywhere in the page
    messageFixture('m8', 'tool', 'resultado órfão', 99, { tool_call_id: 'call_missing', tool_name: 'orphan_tool' }),
    { ...messageFixture('m9', 'assistant', 'ruído de scaffolding', 98), display_kind: 'hidden' },
  ].map((message) => ({ ...message, session_id: sessionId }));

  const handleRpc = (socket, frame) => {
    const id = frame?.id ?? null;
    const method = String(frame?.method ?? '');
    const params = frame?.params && typeof frame.params === 'object' ? frame.params : {};
    calls.push({ kind: 'rpc', method, params });
    if (method === 'profiles.get_asset') {
      // The live RPC reads `name` (methods_profiles.py:71); accept `profile` too so a caller
      // written against the plan's prose still works.
      const name = String(params.name ?? params.profile ?? '');
      const found = profiles.some((p) => p.name === name && p.has_avatar);
      socket.write(
        encodeFrame(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: found
              ? { found: true, mime: 'image/png', size: 70, data: `data:image/png;base64,${AVATAR_PNG_BASE64}` }
              : { found: false },
          })}\n`,
        ),
      );
      return;
    }
    if (method === 'prompt.submit') {
      const sessionId = String(params.session_id ?? '');
      socket.write(encodeFrame(`${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true, session_id: sessionId } })}\n`));
      emit(socket, 'message.start', { message_id: 'live_1', role: 'assistant' }, sessionId);
      emit(socket, 'tool.start', { tool_call_id: 'live_t1', name: 'read_file', arguments: '{"path":"a.txt"}' }, sessionId);
      emit(socket, 'tool.complete', { tool_call_id: 'live_t1', name: 'read_file', ok: true, result: 'linha 1' }, sessionId);
      emit(socket, 'message.delta', { text: 'Pronto: ' }, sessionId);
      emit(socket, 'message.delta', { text: 'feito.' }, sessionId);
      emit(socket, 'message.complete', { text: 'Pronto: feito.', status: 'ok' }, sessionId);
      return;
    }
    if (method === 'session.interrupt') {
      socket.write(encodeFrame(`${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true, interrupted: true } })}\n`));
      return;
    }
    socket.write(
      encodeFrame(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })}\n`),
    );
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      calls.push({ kind: 'http', method: req.method, path, body, query: url.search });

      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const ok = token === config.bearer;
      const isTokenRoute = config.tokenRoutes.includes(path);

      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // The auth gate runs before routing on the real server, and a registered token route is
      // served (or refused) by the token seam, which never consults a cookie.
      if (!ok) return json(401, unauthenticatedBody(isTokenRoute));

      const params = (key, fallback = undefined) => url.searchParams.get(key) ?? fallback;
      const limit = Number(params('limit', 50));
      const offset = Number(params('offset', 0));

      if (path === '/api/profiles' && req.method === 'GET') {
        if (config.failProfiles) {
          // A surface that HAS profiles failing to answer — the case 0.4.0 swallowed and covered up
          // with one synthetic `Principal` contact (F7).
          return json(500, { error: { message: 'profile roster unavailable', type: 'server_error' } });
        }
        return json(200, { profiles, count: profiles.length, active: 'default' });
      }

      if (path === '/api/profiles/sessions' && req.method === 'GET') {
        const scoped = profiles.reduce((acc, p) => {
          acc[p.name] = sessions.filter((s) => (s.profile ?? 'default') === p.name).length;
          return acc;
        }, {});
        const window = sessions.slice(offset, offset + limit);
        return json(200, {
          sessions: window,
          total: sessions.length,
          profile_totals: scoped,
          limit,
          offset,
          errors: [],
          storage: {},
        });
      }

      if (path === '/api/profiles/sessions/sidebar' && req.method === 'GET') {
        const scope = params('recents_profile', 'all');
        const scoped = sessions.filter((s) => scope === 'all' || (s.profile ?? 'default') === scope);
        // The live box's own split (measured 2026-10-11): `recents` carries no cron runs — they are
        // a separate slice. Reproducing that here is what makes "cron is not in the feed" testable.
        const isRun = (s) => ['cron', 'cron_output', 'webhook'].includes(String(s.source ?? ''));
        const recents = scoped.filter((s) => !isRun(s));
        const runs = scoped.filter((s) => isRun(s));
        // Live shape (measured 2026-10-11): each slice is an object wrapping `sessions`.
        return json(200, {
          recents: {
            sessions: recents.slice(0, Number(params('recents_limit', 20))),
            profiles_truncated: {},
            profiles_usage: { default: { input_tokens: 100, output_tokens: 50 } },
          },
          cron: { sessions: runs.slice(0, Number(params('cron_limit', 20))) },
          messaging: { sessions: [], total: 0 },
          errors: [],
          storage: {},
        });
      }

      // GET /api/plugins/messenger/search — one profile per call, message-body FTS.
      if (path === '/api/plugins/messenger/search' && req.method === 'GET') {
        const q = String(params('q', '')).trim().toLowerCase();
        const profile = params('profile', 'all');
        const limit = Number(params('limit', 40));
        searchCalls.push({ q, profile });
        if (!q || !config.bodies) return json(200, { profile, query: q, results: [] });
        const rows = [];
        for (const [needle, hits] of Object.entries(config.bodies)) {
          if (!q.includes(needle) && !needle.includes(q)) continue;
          for (const hit of hits) {
            if (profile !== 'all' && (hit.profile ?? 'default') !== profile) continue;
            rows.push({ session_id: hit.session_id, role: hit.role ?? 'user', snippet: hit.snippet });
          }
        }
        return json(200, { profile, query: q, results: rows.slice(0, limit) });
      }

      // GET /api/plugins/personae-mobile-auth/tailscale/peers — the host's tailnet peers (0.7.0).
      // Shape copied from server/personae-mobile-auth/dashboard/plugin_api.py `peers_payload`:
      // `{available:true, self:{…}, peers:[…]}` or `{available:false, reason}`. Read by a paired
      // DEVICE, so it is a token route in the real plugin — here the bearer is the only credential.
      if (path === '/api/plugins/personae-mobile-auth/tailscale/peers' && req.method === 'GET') {
        if (config.peersUnavailable) return json(200, { available: false, reason: 'cli_missing' });
        return json(200, config.peers ?? {
          available: true,
          self: { name: 'mock-server', ip: '100.64.0.1', os: 'linux', online: true },
          peers: [
            { name: 'mock-laptop', ip: '100.64.0.2', os: 'windows', online: true },
            { name: 'mock-phone', ip: '100.64.0.3', os: 'android', online: false },
          ],
        });
      }

      // POST /api/profiles — create a profile (0.7.0's "New profile"). Shape from
      // web_routers/profiles.py:803 → `{ok, name, path, model_set, model_error, …}`.
      if (path === '/api/profiles' && req.method === 'POST') {
        if (config.profileCreateStatus !== 200) {
          return json(config.profileCreateStatus, {
            error: 'forbidden',
            detail: 'This credential may not create profiles.',
          });
        }
        const name = String(body.name ?? '').trim();
        if (!name) return json(422, { detail: [{ loc: ['body', 'name'], msg: 'field required' }] });
        if (profiles.some((row) => row.name === name)) {
          return json(400, { error: 'exists', detail: `Profile "${name}" already exists.` });
        }
        createdProfiles.push(name);
        profiles.push(profileFixture(name, { label: name, has_avatar: false }));
        return json(200, { ok: true, name, path: `/home/mock/.hermes/profiles/${name}`, model_set: true, model_error: '' });
      }

      if (path === '/api/sessions' && req.method === 'GET') {
        const profile = params('profile');
        const rows = sessions.filter((s) => !profile || (s.profile ?? 'default') === profile);
        return json(200, { sessions: rows.slice(offset, offset + limit), total: rows.length, limit, offset, storage: {} });
      }

      const detailMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (detailMatch && req.method === 'GET') {
        const id = decodeURIComponent(detailMatch[1]);
        const found = sessions.find((s) => s.id === id);
        if (!found) return json(404, { detail: `Session not found: ${id}` });
        return json(200, found);
      }

      if (detailMatch && req.method === 'PATCH') {
        const id = decodeURIComponent(detailMatch[1]);
        const found = sessions.find((s) => s.id === id);
        if (!found) return json(404, { detail: `Session not found: ${id}` });
        const result = { ok: true, title: found.title };
        if (typeof body.title === 'string') {
          found.title = body.title.trim() || found.title;
          result.title = found.title;
        }
        for (const flag of ['pinned', 'archived', 'hidden', 'unread']) {
          if (typeof body[flag] === 'boolean') {
            found[flag === 'unread' ? 'last_read_at' : flag] = flag === 'unread' ? Math.floor(Date.now() / 1000) : body[flag];
            result[flag] = body[flag];
          }
        }
        return json(200, result);
      }

      const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (messagesMatch && req.method === 'GET') {
        const sessionId = decodeURIComponent(messagesMatch[1]);
        if (!sessions.some((s) => s.id === sessionId)) return json(404, { detail: `Session not found: ${sessionId}` });
        const messages = messagesFor(sessionId);
        return json(200, {
          session_id: sessionId,
          profile: 'default',
          messages,
          pagination: { limit: Number(params('limit', 200)), offset, order: params('order', 'latest'), returned: messages.length },
        });
      }

      if (path === '/api/auth/ws-ticket' && req.method === 'POST') {
        const ticket = crypto.randomBytes(32).toString('base64url');
        tickets.set(ticket, Date.now() + config.ticketTtlSeconds * 1000);
        return json(200, { ticket, ttl_seconds: config.ticketTtlSeconds });
      }

      return json(404, { detail: `Not found: ${path}` });
    });
  });

  // ---- /api/ws : a real WebSocket upgrade with a fake JSON-RPC dispatch --------------
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get('ticket') || '';
    const expiresAt = tickets.get(ticket);
    const valid = Boolean(expiresAt) && expiresAt > Date.now();
    tickets.delete(ticket); // single-use, always consumed — replay is refused
    if (!valid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`, '\r\n'].join('\r\n'),
    );
    sockets.add(socket);
    const ready = { jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: true } } };
    socket.write(encodeFrame(`${JSON.stringify(ready)}\n`));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame('', 0x8));
          break;
        }
        if (frame.opcode !== 0x1) continue;
        for (const line of frame.payload.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed = null;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }
          handleRpc(socket, parsed);
        }
      }
    });
    if (head && head.length) socket.emit('data', head);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    config,
    calls,
    searchCalls,
    profiles,
    sessions,
    createdProfiles,
    tickets,
    events,
    /** The port actually bound: `0` in `config.port` means "whatever is free". */
    get port() {
      return boundPort;
    },
    get url() {
      return `http://127.0.0.1:${boundPort}`;
    },
    get wsUrl() {
      return `ws://127.0.0.1:${boundPort}/api/ws`;
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(config.port, '127.0.0.1', () => {
          const address = server.address();
          if (address && typeof address === 'object') boundPort = address.port;
          resolve(this);
        });
      });
    },
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('dashboard.mjs');
if (invokedDirectly) {
  const port = Number(process.env.MOCK_PORT ?? DEFAULTS.port);
  const dashboard = createMockDashboard({ port, bearer: process.env.MOCK_BEARER ?? DEFAULTS.bearer });
  dashboard.listen().then(() => {
    console.log(`mock dashboard on ${dashboard.url} (bearer "${dashboard.config.bearer}")`);
  });
}
