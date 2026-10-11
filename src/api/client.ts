/**
 * Hermes gateway API client.
 *
 * Every shape below is derived from the server source, not invented:
 *   route table   ~/.hermes/hermes-agent/gateway/platforms/api_server.py:1745-1792
 *   GET  /api/sessions                  _handle_list_sessions        :3091
 *                                       -> {object:"list", data:[session], limit, offset, has_more}
 *   POST /api/sessions                  _handle_create_session       :3146
 *                                       -> 201 {object:"hermes.session", session}
 *   GET  /api/sessions/{id}/messages    _handle_session_messages     :3295
 *                                       -> {object:"list", session_id, data:[msg], pagination}
 *   POST /api/sessions/{id}/chat        _handle_session_chat         :3595
 *                                       -> {object, session_id, message:{role,content}, usage, runtime}
 *   POST /api/sessions/{id}/chat/stream _handle_session_chat_stream  :3640 -> SSE
 *   GET  /v1/health                     _handle_health               :2452 (NO auth) -> {status,platform,version}
 *
 * Session fields are the `safe_keys` allow-list of _session_response (:3011); message fields are
 * those of _message_response (:3046). Anything not on those lists is not in the JSON, so it is not
 * modelled here.
 *
 * Auth: `Authorization: Bearer <API_SERVER_KEY>` (_check_auth :1586; 401 envelope :1580).
 * Profile multiplexing: every route is also mounted at /p/{profile}/<path> (:4516).
 */

import { t } from '../i18n';
import { checkBaseUrl, joinUrl, profilePrefix, type Settings } from '../settings';
import { ApiError, httpError, normalizeError, StreamHttpError } from './errors';
import type { StreamHandle, StreamTransport } from './transport';

export type HermesSession = {
  id: string;
  source?: string;
  /** Which profile this row came from (the dashboard's rail tags every row). */
  profile?: string | null;
  user_id?: string | null;
  model?: string | null;
  title?: string | null;
  started_at?: number;
  ended_at?: number | null;
  end_reason?: string | null;
  message_count?: number;
  tool_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  api_call_count?: number;
  parent_session_id?: string | null;
  last_active?: number;
  /** The read watermark the dashboard serves on every row — the emerald dot's only source. */
  last_read_at?: number | null;
  /** Live-state hints, tolerated when absent (see `src/logic/lights.ts`). */
  is_active?: boolean | null;
  waiting?: boolean | null;
  needs_input?: boolean | null;
  preview?: string | null;
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
  has_system_prompt?: boolean;
  has_model_config?: boolean;
  is_internal_child?: boolean;
};

export type HermesMessage = {
  id?: string;
  session_id?: string;
  role?: string;
  content?: unknown;
  tool_call_id?: string | null;
  tool_calls?: unknown;
  tool_name?: string | null;
  timestamp?: number;
  token_count?: number;
  finish_reason?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  display_kind?: string | null;
};

export type SessionListResponse = {
  object: string;
  data: HermesSession[];
  limit?: number;
  offset?: number;
  has_more?: boolean;
};

export type MessagesResponse = {
  object: string;
  session_id: string;
  data: HermesMessage[];
  pagination?: { limit: number; offset: number; order: string; returned: number };
};

export type HealthResponse = { status?: string; platform?: string; version?: string };

export type ChatOnceResponse = {
  object?: string;
  session_id?: string;
  message?: { role?: string; content?: string };
  usage?: unknown;
  runtime?: unknown;
};

export type ClientOptions = {
  transport: StreamTransport;
  timeoutMs?: number;
  stallMs?: number;
  fetchImpl?: typeof fetch;
};

export type ChatStreamHandlers = {
  onOpen?: () => void;
  onEvent?: (name: string, payload: Record<string, unknown>) => void;
  onDelta?: (delta: string) => void;
  onFinal?: (content: string, payload: Record<string, unknown>) => void;
  onError: (error: ApiError) => void;
  onClose: (info: { aborted: boolean }) => void;
};

const DEFAULT_TIMEOUT_MS = 20_000;
/** The server writes ": keepalive" every 10 s; 45 s of silence is a dead stream, not a slow model. */
const DEFAULT_STALL_MS = 45_000;

export type Connection = { baseUrl: string; apiKey: string; model: string };

/** Validate configuration and return the pieces every request needs, or a specific ApiError. */
export function resolveConnection(settings: Settings, profile = ''): Connection {
  const checked = checkBaseUrl(settings.baseUrl);
  if (!checked.ok) {
    throw new ApiError(
      checked.reason === 'empty' ? t.errors.noBaseUrl : t.errors.badBaseUrl(settings.baseUrl),
      { kind: 'config' },
    );
  }
  if (!settings.apiKey) {
    throw new ApiError(t.errors.noKey, { kind: 'config' });
  }
  return { baseUrl: checked.value, apiKey: settings.apiKey, model: settings.model };
}

export function buildUrl(settings: Settings, path: string, profile = '', query?: Record<string, string | number | undefined>): string {
  const connection = resolveConnection(settings, profile);
  const url = joinUrl(connection.baseUrl, `${profilePrefix(profile)}${path}`);
  if (!query) return url;
  const params = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return params.length ? `${url}?${params.join('&')}` : url;
}

export function requestHeaders(settings: Settings, profile = ''): Record<string, string> {
  const connection = resolveConnection(settings, profile);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${connection.apiKey}`,
    Accept: 'application/json',
    // Declared on the server's CORS allow-list (api_server.py:826).
    'X-Hermes-Session-Id': '',
  };
  if (profile && profile !== 'default') headers['X-Hermes-Profile'] = profile;
  delete headers['X-Hermes-Session-Id']; // only meaningful on a live-session request; never guessed
  return headers;
}

export function createApi(settings: Settings, options: ClientOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));

  async function json<T>(path: string, init: RequestInit, profile = '', query?: Record<string, string | number | undefined>): Promise<T> {
    const url = buildUrl(settings, path, profile, query);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: { ...requestHeaders(settings, profile), ...(init.headers || {}) },
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      if ((error as Error)?.name === 'AbortError') {
        throw new ApiError(t.errors.timeout(Math.round(timeoutMs / 1000)), { kind: 'timeout' });
      }
      throw new ApiError(t.errors.network((error as Error)?.message || 'fetch failed'), {
        kind: 'network',
        detail: (error as Error)?.message,
      });
    }
    if (timer) clearTimeout(timer);

    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) throw new ApiError(t.errors.badJson, { kind: 'parse', status: response.status });
      }
    }
    if (!response.ok) throw httpError(response.status, parsed, profile);
    return (parsed ?? {}) as T;
  }

  return {
    /** GET /v1/health — the only route without auth, so the status dot never needs the key. */
    async health(profile = ''): Promise<HealthResponse> {
      const url = buildUrl(settings, '/v1/health', profile);
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), Math.min(timeoutMs, 6000)) : null;
      try {
        const response = await doFetch(url, { method: 'GET', ...(controller ? { signal: controller.signal } : {}) });
        if (timer) clearTimeout(timer);
        if (!response.ok) throw httpError(response.status, await response.json().catch(() => null), profile);
        return (await response.json()) as HealthResponse;
      } catch (error) {
        if (timer) clearTimeout(timer);
        throw normalizeError(error);
      }
    },

    /** GET /api/sessions — newest first (server orders by last_active). */
    listSessions(profile = '', limit = 50, offset = 0): Promise<SessionListResponse> {
      return json<SessionListResponse>('/api/sessions', { method: 'GET' }, profile, { limit, offset });
    },

    /** POST /api/sessions — 201 with the created row; 409 when the id already exists. */
    createSession(title: string, profile = ''): Promise<{ object: string; session: HermesSession }> {
      const body: Record<string, unknown> = {};
      if (title.trim()) body.title = title.trim();
      if (settings.model.trim()) body.model = settings.model.trim();
      return json<{ object: string; session: HermesSession }>(
        '/api/sessions',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        profile,
      );
    },

    /**
     * GET /api/sessions/{id}/messages
     *
     * The server's default page (no `limit`) is the LATEST 500 rows, but that default only applies
     * when no limit is sent — _handle_session_messages:3314 sets latest_page only for
     * `order == "latest"` or an unlimited default page. Sending a limit without an explicit order
     * therefore returns the OLDEST rows, which is the opposite of what a chat screen wants, so the
     * order is always sent explicitly here.
     */
    messages(sessionId: string, profile = '', limit = 200): Promise<MessagesResponse> {
      return json<MessagesResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        { method: 'GET' },
        profile,
        { order: 'latest', limit },
      );
    },

    /** POST /api/sessions/{id}/chat — the non-streaming path, used if streaming fails mid-turn. */
    chatOnce(sessionId: string, message: string, profile = ''): Promise<ChatOnceResponse> {
      const body: Record<string, unknown> = { message };
      if (settings.model.trim()) body.model = settings.model.trim();
      return json<ChatOnceResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        profile,
      );
    },

    /**
     * POST /api/sessions/{id}/chat/stream — SSE over POST.
     *
     * Events written by _handle_session_chat_stream (:3694-3738), in order:
     *   run.started, message.started, assistant.delta*, tool.progress|tool.started|tool.completed|
     *   tool.failed|assistant.commentary*, approval.request?, assistant.completed,
     *   run.completed|run.failed|run.cancelled, done. An out-of-band `error` frame may precede done.
     */
    chatStream(sessionId: string, message: string, handlers: ChatStreamHandlers, profile = ''): StreamHandle {
      const body: Record<string, unknown> = { message };
      if (settings.model.trim()) body.model = settings.model.trim();
      const payload = JSON.stringify(body);
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      let sawFinal = false;

      const clearStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = null;
      };

      const stream: StreamHandle = options.transport(
        {
          url: buildUrl(settings, `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, profile),
          headers: { ...requestHeaders(settings, profile), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: payload,
        },
        {
          onOpen: () => {
            armStall();
            handlers.onOpen?.();
          },
          onEvent: (event) => {
            armStall();
            handlers.onEvent?.(event.name, event.payload);
            switch (event.name) {
              case 'assistant.delta': {
                const delta = typeof event.payload.delta === 'string' ? (event.payload.delta as string) : '';
                if (delta) handlers.onDelta?.(delta);
                break;
              }
              case 'assistant.completed': {
                sawFinal = true;
                const content = typeof event.payload.content === 'string' ? (event.payload.content as string) : '';
                handlers.onFinal?.(content, event.payload);
                break;
              }
              case 'error': {
                const detail = typeof event.payload.message === 'string' ? (event.payload.message as string) : '';
                handlers.onError(new ApiError(t.errors.server(500, detail || t.errors.streamFailed), { kind: 'http', detail }));
                break;
              }
              case 'done': {
                if (!sawFinal) {
                  handlers.onError(new ApiError(t.errors.streamDropped, { kind: 'stream' }));
                }
                close(false);
                break;
              }
              default:
                break;
            }
          },
          onError: (error) => {
            clearStall();
            // A failed SSE *request* keeps its HTTP identity (status + envelope); only a stream
            // that opened and then died is a "stream dropped".
            if (error instanceof StreamHttpError) {
              let parsed: unknown = null;
              try {
                parsed = error.body ? JSON.parse(error.body) : null;
              } catch {
                parsed = null;
              }
              handlers.onError(httpError(error.status, parsed, profile));
              return;
            }
            handlers.onError(
              new ApiError(t.errors.streamDropped, { kind: 'stream', detail: error.message }),
            );
          },
          onClose: (info) => {
            clearStall();
            if (closed) return;
            closed = true;
            handlers.onClose(info);
          },
        },
      );

      function armStall() {
        clearStall();
        stallTimer = setTimeout(() => {
          stream.close();
          handlers.onError(new ApiError(t.errors.timeout(Math.round(stallMs / 1000)), { kind: 'timeout' }));
        }, stallMs);
      }

      function close(aborted: boolean) {
        clearStall();
        if (closed) return;
        closed = true;
        try {
          stream.close();
        } catch {
          /* already gone */
        }
        handlers.onClose({ aborted });
      }

      return { close: () => close(true) };
    },
  };
}

export type HermesApi = ReturnType<typeof createApi>;
