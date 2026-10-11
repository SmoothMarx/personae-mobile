/**
 * Local mock of the Hermes gateway API server.
 *
 * Purpose per SPEC §6: exercise the client end-to-end OFFLINE. It is never evidence about the live
 * gateway — no key exists in this build, so the live gateway cannot be tested (see PROGRESS.md).
 *
 * Every response body is copied from the real handlers' shapes in
 * ~/.hermes/hermes-agent/gateway/platforms/api_server.py:
 *   GET  /v1/health                      {status, platform, version}                 (no auth)
 *   GET  /api/sessions                   {object:"list", data, limit, offset, has_more}
 *   POST /api/sessions                   201 {object:"hermes.session", session}
 *   GET  /api/sessions/{id}/messages     {object:"list", session_id, data, pagination}
 *   POST /api/sessions/{id}/chat         {object, session_id, message:{role,content}, usage}
 *   POST /api/sessions/{id}/chat/stream  SSE: id/event/data frames, ": keepalive" comments
 *   401 envelope: {"error":{"message":"Invalid gateway API key (API_SERVER_KEY)",
 *                  "type":"gateway_auth_error","code":"gateway_auth_failed"}}
 *
 * Run standalone:  node mock/server.mjs            (port 8791, key "test-key-123")
 */

import http from 'node:http';

const DEFAULTS = {
  port: 8791,
  key: 'test-key-123',
  /** When set, /p/<profile>/ requests must carry this key instead (mirrors profile-scoped keys). */
  profileKey: null,
  version: '0.21.5-mock',
};

function sessionFixture(id, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    source: 'api_server',
    model: 'mock-model-a',
    title: `Sessão ${id}`,
    started_at: now - 3600,
    ended_at: null,
    end_reason: null,
    message_count: 4,
    tool_call_count: 1,
    input_tokens: 100,
    output_tokens: 50,
    parent_session_id: null,
    last_active: now - 600,
    preview: 'Olá, tudo bem?',
    pinned: false,
    archived: false,
    hidden: false,
    has_system_prompt: false,
    has_model_config: false,
    is_internal_child: false,
    ...overrides,
  };
}

function messageFixture(id, role, content, offsetSeconds) {
  return {
    id,
    session_id: 'sess-1',
    role,
    content,
    timestamp: Math.floor(Date.now() / 1000) - offsetSeconds,
    display_kind: null,
  };
}

function unauthorizedBody() {
  return {
    error: {
      message: 'Invalid gateway API key (API_SERVER_KEY)',
      type: 'gateway_auth_error',
      code: 'gateway_auth_failed',
    },
  };
}

function errorBody(message, code, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code } };
}

/** One SSE frame, byte-for-byte the format of api_server.py::_sse_frame (line 258). */
export function sseFrame(payload, event) {
  const prefix = event ? `event: ${event}\n` : '';
  return `${prefix}data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Profile rejection. The real gateway's prefix middleware answers a profile it does not serve with
 * `web.json_response({"error": "Unknown or unconfigured profile"}, status=404)`
 * (api_server.py:1726) — note the bare STRING envelope, unlike the OpenAI-style object envelope
 * every handler error uses.
 */
function unknownProfileBody() {
  return { error: 'Unknown or unconfigured profile' };
}

export function createMockGateway(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const sessions = options.sessions ?? [sessionFixture('sess-1'), sessionFixture('sess-2', { title: 'Outra conversa', last_active: Math.floor(Date.now() / 1000) - 86400 })];
  const created = new Map();
  const calls = [];

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
          res.end(JSON.stringify(errorBody('Invalid JSON in request body', null)));
          return;
        }
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      let path = url.pathname;
      let profile = '';
      const prefixMatch = path.match(/^\/p\/([^/]+)(\/.*)$/);
      if (prefixMatch) {
        profile = decodeURIComponent(prefixMatch[1]);
        path = prefixMatch[2];
      }
      calls.push({ method: req.method, path, profile, body, query: url.search });

      // Fail closed, like _resolve_request_profile: a /p/<name>/ this gateway does not serve is a
      // 404 BEFORE any handler (including the unauthenticated health route).
      if (profile && !(config.servedProfiles ?? []).includes(profile)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(unknownProfileBody()));
        return;
      }

      const health = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', platform: 'hermes-agent', version: config.version }));
      };

      // /v1/health carries no @_require_auth on the real server.
      if (path === '/v1/health' && req.method === 'GET') return health();

      const expected = profile ? (config.profileKey ?? config.key) : config.key;
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (token !== expected) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(unauthorizedBody()));
        return;
      }

      if (path === '/api/sessions' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const all = [...sessions, ...created.values()];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: all.slice(offset, offset + limit),
            limit,
            offset,
            has_more: false,
          }),
        );
        return;
      }

      if (path === '/api/sessions' && req.method === 'POST') {
        if (body.title === 'colide') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorBody('Title already in use by session sess-1', 'invalid_title')));
          return;
        }
        const id = `api_mock_${created.size + 1}`;
        const session = sessionFixture(id, { title: body.title ?? null, message_count: 0, last_active: Math.floor(Date.now() / 1000) });
        created.set(id, session);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'hermes.session', session }));
        return;
      }

      const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (messagesMatch && req.method === 'GET') {
        const sessionId = decodeURIComponent(messagesMatch[1]);
        if (![...sessions, ...created.values()].some((s) => s.id === sessionId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorBody(`Session not found: ${sessionId}`, 'session_not_found')));
          return;
        }
        const data = [
          messageFixture('m1', 'user', 'Olá', 120),
          messageFixture('m2', 'assistant', 'Olá! Como posso ajudar?', 110),
          { ...messageFixture('m3', 'assistant', '', 100), tool_calls: [{ id: 't1' }] },
          messageFixture('m4', 'user', 'Diz-me as horas.', 90),
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            session_id: sessionId,
            data,
            pagination: { limit: 200, offset: 0, order: 'latest', returned: data.length },
          }),
        );
        return;
      }

      const chatMatch = path.match(/^\/api\/sessions\/([^/]+)\/chat$/);
      if (chatMatch && req.method === 'POST') {
        const sessionId = decodeURIComponent(chatMatch[1]);
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Hermes-Session-Id': sessionId });
        res.end(
          JSON.stringify({
            object: 'hermes.session.chat.completion',
            session_id: sessionId,
            message: { role: 'assistant', content: `Resposta em bloco a: ${body.message}` },
            usage: { input_tokens: 10, output_tokens: 10 },
            runtime: { provider: 'mock', model: 'mock-model-a' },
          }),
        );
        return;
      }

      const streamMatch = path.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/);
      if (streamMatch && req.method === 'POST') {
        const sessionId = decodeURIComponent(streamMatch[1]);
        if (body.message === 'provoca erro de stream') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Internal server error: mock', type: 'server_error' } }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          'X-Hermes-Session-Id': sessionId,
        });
        const runId = 'run_mock_1';
        const messageId = 'msg_mock_1';
        const stamp = (payload) => ({ ...payload, session_id: sessionId, run_id: runId });
        const parts = ['Olá', '! Aqui', ' está a resposta.'];
        const write = (payload, event) => res.write(sseFrame(stamp(payload), event));
        write({ event: 'run.started', timestamp: Date.now() / 1000 }, 'run.started');
        res.write(': keepalive\n\n');
        write({ event: 'message.started', message: { id: messageId, role: 'assistant' } }, 'message.started');
        let index = 0;
        const tick = setInterval(() => {
          if (index < parts.length) {
            write({ event: 'assistant.delta', message_id: messageId, delta: parts[index] }, 'assistant.delta');
            index += 1;
            return;
          }
          clearInterval(tick);
          const content = parts.join('');
          write({ event: 'assistant.completed', session_id: sessionId, message_id: messageId, content }, 'assistant.completed');
          write({ event: 'run.completed', session_id: sessionId, message_id: messageId, messages: [], usage: {} }, 'run.completed');
          write({ event: 'done' }, 'done');
          res.end();
        }, 25);
        // MUST be res, never req: an IncomingMessage emits 'close' as soon as its body is fully
        // consumed, which would clear the interval before the first delta is written.
        res.on('close', () => clearInterval(tick));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errorBody(`Not found: ${path}`, 'not_found')));
    });
  });

  return {
    config,
    calls,
    sessions,
    created,
    url: `http://127.0.0.1:${config.port}`,
    listen() {
      return new Promise((resolve) => server.listen(config.port, '127.0.0.1', () => resolve(this)));
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('server.mjs');
if (invokedDirectly) {
  const port = Number(process.env.MOCK_PORT ?? DEFAULTS.port);
  const gateway = createMockGateway({ port, key: process.env.MOCK_KEY ?? DEFAULTS.key });
  gateway.listen().then(() => {
    console.log(`mock gateway on ${gateway.url} (key "${gateway.config.key}")`);
  });
}
