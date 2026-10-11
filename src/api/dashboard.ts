/**
 * Dashboard client — the Personae Mobile transport from 0.4.0 on.
 *
 * The app talks to the **gated dashboard** (`hermes dashboard`, `0.0.0.0:9119`), not to the
 * `:9222` api_server: one surface, LAN and Tailnet at full parity (PLAN-UI.md §0.2). Every shape
 * below is read from the serving code, not invented:
 *
 *   GET  /api/profiles                    web_routers/profiles.py:798 -> {profiles:[row]}
 *                                         row carries `has_avatar` (methods_profiles.py:277)
 *   GET  /api/profiles/sessions           web_routers/profiles.py:452
 *                                         -> {sessions, total, profile_totals, limit, offset, errors, storage}
 *   GET  /api/profiles/sessions/sidebar   web_routers/profiles.py:510 (batched slices)
 *   GET  /api/sessions                    web_routers/sessions.py:177
 *                                         -> {sessions, total, limit, offset, storage}
 *   GET  /api/sessions/{id}               web_routers/sessions.py:524 -> session row (or 404)
 *   GET  /api/sessions/{id}/messages      web_routers/sessions.py:685
 *                                         -> {session_id, profile, messages:[...], pagination}
 *   PATCH /api/sessions/{id}              web_routers/sessions.py:849
 *                                         -> {ok, title, pinned?, archived?, hidden?, unread?}
 *   POST /api/auth/ws-ticket              dashboard_auth/routes.py:485 -> {ticket, ttl_seconds}
 *   /api/ws                               tui_gateway JSON-RPC over WebSocket
 *                                         events: {jsonrpc,method:"event",params:{type,payload,…}}
 *   profiles.get_asset (RPC)              tui_gateway/methods_profiles.py:446
 *                                         -> {found, mime, size, data:"data:image/png;base64,…"}
 *   prompt.submit / session.interrupt     tui_gateway/methods_prompt.py:657 / host_supervisor.py:28
 *
 * Auth: `Authorization: Bearer <secret>` on the REST legs (the provider in `server/`), and a
 * **single-use, 30 s ticket** minted per WebSocket connection (`?ticket=`) — a ticket is never
 * reused or cached, so a stale socket can never be reopened with a spent credential.
 */

import { ApiError, httpError, normalizeError } from './errors';
import { t } from '../i18n';
import { checkBaseUrl, joinUrl, type Settings } from '../settings';

export type DashboardProfile = {
  name: string;
  label?: string;
  path?: string;
  is_default?: boolean;
  model?: string | null;
  provider?: string | null;
  has_env?: boolean;
  /**
   * Cheap avatar-existence flag. Live reading (2026-10-11): `/api/profiles` returns it as `null`
   * for every profile on this box — the REST list does not attach it (the ui-meta helper the plan
   * cited runs on the RPC path), so `false` means "definitely none" and `null`/absent means
   * "unknown". The roster therefore probes unknown ones in the background, never blocking the rail.
   */
  has_avatar?: boolean | null;
  skill_count?: number;
  gateway_running?: boolean;
  description?: string;
  description_auto?: boolean;
};

export type DashboardSession = {
  id: string;
  title?: string | null;
  preview?: string | null;
  profile?: string;
  is_default_profile?: boolean;
  model?: string | null;
  source?: string | null;
  started_at?: number;
  last_active?: number;
  message_count?: number;
  tool_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
  is_active?: boolean;
  /** Last time this phone read the session; drives the emerald "unread" dot (§2.1). */
  last_read_at?: number | null;
  parent_session_id?: string | null;
};

export type DashboardMessage = {
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
  /** Set by the dashboard's display projection (web_routers/sessions.py `_project_for_display`). */
  kind?: string | null;
};

export type DashboardSessionsResponse = {
  sessions: DashboardSession[];
  total?: number;
  limit?: number;
  offset?: number;
  storage?: Record<string, string>;
};

export type RailResponse = DashboardSessionsResponse & {
  profile_totals?: Record<string, { sessions?: number; unread?: number } | number>;
  errors?: { profile: string; error: string }[];
};

/**
 * `GET /api/profiles/sessions/sidebar` — measured against the live dashboard (2026-10-11):
 * `{recents:{sessions,profiles_truncated,profiles_usage}, cron:{sessions}, messaging:{sessions,total},
 *  errors, storage}`. Note the slices are OBJECTS wrapping `sessions`, not bare arrays.
 */
export type SidebarSlice = {
  sessions: DashboardSession[];
  profiles_truncated?: Record<string, boolean>;
  profiles_usage?: Record<string, unknown>;
  total?: number;
};

export type SidebarResponse = {
  recents?: SidebarSlice;
  cron?: SidebarSlice;
  messaging?: SidebarSlice;
  errors?: { profile: string; error: string }[];
  storage?: Record<string, string>;
};

export type DashboardMessagesResponse = {
  session_id?: string;
  profile?: string;
  messages: DashboardMessage[];
  pagination?: { limit: number; offset: number; order: string; returned: number };
};

export type GatewayEvent = {
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  seq?: number;
};

export type SocketHandlers = {
  onOpen?: () => void;
  onEvent?: (event: GatewayEvent) => void;
  onClose?: (info: { code?: number; reason?: string }) => void;
  onError?: (error: Error) => void;
};

/** Minimal structural type both the browser/RN `WebSocket` and a test double satisfy. */
export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: unknown) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
};

export type DashboardSocket = {
  /** JSON-RPC request/response. A JSON-RPC `error` object becomes an ApiError(kind:'http'). */
  rpc<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Subscribe to one event type (`message.delta`, `tool.start`, …). Returns an unsubscribe fn. */
  on(type: string, handler: (event: GatewayEvent) => void): () => void;
  close(): void;
  closed: boolean;
};

export type DashboardOptions = {
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
  timeoutMs?: number;
  rpcTimeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RPC_TIMEOUT_MS = 120_000;

type ConnectionInfo = { baseUrl: string; token: string; model: string };

/** Same validation ladder as the gateway client, so a bad URL/key fails before any request. */
export function resolveDashboardConnection(settings: Settings): ConnectionInfo {
  const checked = checkBaseUrl(settings.baseUrl);
  if (!checked.ok) {
    throw new ApiError(
      checked.reason === 'empty' ? t.errors.noBaseUrl : t.errors.badBaseUrl(settings.baseUrl),
      { kind: 'config' },
    );
  }
  if (!settings.apiKey) throw new ApiError(t.errors.noKey, { kind: 'config' });
  return { baseUrl: checked.value, token: settings.apiKey, model: settings.model };
}

export function dashboardHeaders(connection: ConnectionInfo): Record<string, string> {
  return { Authorization: `Bearer ${connection.token}`, Accept: 'application/json' };
}

function wsUrlOf(baseUrl: string, path: string, ticket: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = `?ticket=${encodeURIComponent(ticket)}`;
  return url.toString();
}

export function createDashboardClient(settings: Settings, options: DashboardOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));
  const socketFactory: (url: string) => SocketLike =
    options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);

  let seq = 0;

  async function json<T>(
    path: string,
    init: RequestInit,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const connection = resolveDashboardConnection(settings);
    let url = joinUrl(connection.baseUrl, path);
    if (query) {
      const params = Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      if (params.length) url = `${url}?${params.join('&')}`;
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: { ...dashboardHeaders(connection), ...(init.headers || {}) },
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
    if (!response.ok) throw httpError(response.status, parsed);
    return (parsed ?? {}) as T;
  }

  /** Mint a fresh, single-use WS ticket. Never cached: one ticket per connection. */
  async function wsTicket(): Promise<{ ticket: string; ttlSeconds: number }> {
    const body = await json<{ ticket?: string; ttl_seconds?: number }>('/api/auth/ws-ticket', {
      method: 'POST',
    });
    if (!body.ticket) {
      throw new ApiError(t.errors.server(500, 'ticket ausente'), { kind: 'http', status: 500 });
    }
    return { ticket: body.ticket, ttlSeconds: Number(body.ttl_seconds ?? 30) };
  }

  /**
   * Open `/api/ws` for one connection.
   *
   * The ticket is minted immediately before the upgrade and never reused; the socket speaks the
   * gateway's newline-delimited JSON-RPC (`tui_gateway`): requests `{jsonrpc,id,method,params}`,
   * events `{jsonrpc,method:"event",params:{type,payload,session_id,seq}}`.
   */
  async function connect(handlers: SocketHandlers = {}): Promise<DashboardSocket> {
    const connection = resolveDashboardConnection(settings);
    const { ticket } = await wsTicket();
    const socket = socketFactory(wsUrlOf(connection.baseUrl, '/api/ws', ticket));
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }>();
    const listeners = new Map<string, Set<(event: GatewayEvent) => void>>();
    const state = { closed: false, open: false };

    const failAll = (error: Error) => {
      for (const [, entry] of pending) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };

    /**
     * The gateway's wire format is newline-delimited JSON-RPC on both sides
     * (`tui_gateway/ws.py`: "identical to stdio"), and one WS message may carry several lines,
     * so each line is parsed on its own and a half-line is simply not JSON (ignored).
     */
    const dispatchFrame = (raw: string) => {
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        dispatchOne(trimmed);
      }
    };

    const dispatchOne = (raw: string) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return; // the gateway only writes JSON; anything else is noise
      }
      if (frame.method === 'event' && frame.params && typeof frame.params === 'object') {
        const params = frame.params as Record<string, unknown>;
        const type = String(params.type ?? '');
        const event: GatewayEvent = {
          type,
          payload: (params.payload && typeof params.payload === 'object' ? params.payload : {}) as Record<string, unknown>,
          sessionId: typeof params.session_id === 'string' ? params.session_id : undefined,
          seq: typeof params.seq === 'number' ? params.seq : undefined,
        };
        handlers.onEvent?.(event);
        for (const handler of listeners.get(type) ?? []) handler(event);
        return;
      }
      const id = frame.id !== undefined && frame.id !== null ? String(frame.id) : '';
      if (!id) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      if (frame.error && typeof frame.error === 'object') {
        const err = frame.error as { message?: string; code?: number };
        entry.reject(
          new ApiError(t.errors.server(Number(err.code ?? 500), err.message || 'erro RPC'), {
            kind: 'http',
            status: Number(err.code ?? 500),
            detail: err.message,
          }),
        );
        return;
      }
      entry.resolve((frame.result ?? {}) as Record<string, unknown>);
    };

    const ready = new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        state.open = true;
        handlers.onOpen?.();
        resolve();
      };
      const onMessage = (event: unknown) => {
        const data = (event as { data?: unknown })?.data;
        if (typeof data === 'string') dispatchFrame(data);
      };
      const onError = (event: unknown) => {
        const error = new Error((event as { message?: string })?.message || 'falha no WebSocket');
        handlers.onError?.(error);
        if (!state.open) reject(error);
        failAll(error);
      };
      const onClose = (event: unknown) => {
        state.closed = true;
        const info = { code: (event as { code?: number })?.code, reason: (event as { reason?: string })?.reason };
        handlers.onClose?.(info);
        failAll(new ApiError(t.errors.streamDropped, { kind: 'stream', detail: info.reason }));
        if (!state.open) reject(new Error(t.errors.streamDropped));
      };
      if (socket.addEventListener) {
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      } else {
        socket.onopen = onOpen;
        socket.onmessage = onMessage;
        socket.onerror = onError;
        socket.onclose = onClose;
      }
    });

    await ready;

    return {
      get closed() {
        return state.closed;
      },
      rpc<T>(method: string, params: Record<string, unknown> = {}, requestTimeout = rpcTimeoutMs): Promise<T> {
        if (state.closed) {
          return Promise.reject(new ApiError(t.errors.streamDropped, { kind: 'stream' }));
        }
        seq += 1;
        const id = `pm${seq}`;
        return new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new ApiError(t.errors.timeout(Math.round(requestTimeout / 1000)), { kind: 'timeout' }));
          }, requestTimeout);
          pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
          try {
            // Trailing newline: the gateway's wire protocol is newline-delimited JSON-RPC.
            socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
          } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(normalizeError(error));
          }
        });
      },
      on(type: string, handler: (event: GatewayEvent) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
        return () => set.delete(handler);
      },
      close() {
        if (state.closed) return;
        state.closed = true;
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      },
    };
  }

  return {
    resolve: () => resolveDashboardConnection(settings),
    wsTicket,

    /** GET /api/profiles — the roster's source of truth, including `has_avatar`. */
    async profiles(): Promise<DashboardProfile[]> {
      const body = await json<{ profiles?: DashboardProfile[] }>('/api/profiles', { method: 'GET' });
      return Array.isArray(body.profiles) ? body.profiles : [];
    },

    /** GET /api/profiles/sessions — every profile's sessions in one call, with `profile_totals`. */
    rail(profile = 'all', query: Record<string, string | number | undefined> = {}): Promise<RailResponse> {
      return json<RailResponse>('/api/profiles/sessions', { method: 'GET' }, {
        profile: profile && profile !== 'all' ? profile : undefined,
        limit: query.limit ?? 100,
        offset: query.offset ?? 0,
        order: query.order ?? 'recent',
      });
    },

    /** GET /api/profiles/sessions/sidebar — the batched recents/cron/messaging slices. */
    sidebar(profile = 'all', query: Record<string, string | number | undefined> = {}): Promise<SidebarResponse> {
      return json<SidebarResponse>('/api/profiles/sessions/sidebar', { method: 'GET' }, {
        recents_profile: profile || 'all',
        recents_limit: query.recentsLimit ?? 50,
        cron_limit: query.cronLimit ?? 20,
        messaging_limit: query.messagingLimit ?? 20,
      });
    },

    /** GET /api/sessions — one profile's sessions (order=recent follows the compression chain). */
    listSessions(profile = '', limit = 50, offset = 0): Promise<DashboardSessionsResponse> {
      return json<DashboardSessionsResponse>('/api/sessions', { method: 'GET' }, {
        limit,
        offset,
        order: 'recent',
        profile: profile && profile !== 'default' ? profile : undefined,
      });
    },

    /** GET /api/sessions/{id} — authoritative once loaded; how a rename lands while open (F4). */
    session(sessionId: string, profile = ''): Promise<DashboardSession> {
      return json<DashboardSession>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' }, {
        profile: profile && profile !== 'default' ? profile : undefined,
      });
    },

    /** GET /api/sessions/{id}/messages — note the key is `messages`, not the api_server's `data`. */
    messages(sessionId: string, profile = '', limit = 200): Promise<DashboardMessagesResponse> {
      return json<DashboardMessagesResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        { method: 'GET' },
        {
          limit,
          offset: 0,
          order: 'latest',
          profile: profile && profile !== 'default' ? profile : undefined,
        },
      );
    },

    /** PATCH /api/sessions/{id} — title and/or flags; returns the stored title. */
    rename(sessionId: string, title: string, profile = ''): Promise<{ ok: boolean; title: string }> {
      return json<{ ok: boolean; title: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, ...(profile && profile !== 'default' ? { profile } : {}) }) },
      );
    },

    /** PATCH flags: pinned / archived / hidden / unread (unread=false marks read up to now). */
    patchFlags(
      sessionId: string,
      patch: { pinned?: boolean; archived?: boolean; hidden?: boolean; unread?: boolean },
      profile = '',
    ): Promise<Record<string, unknown>> {
      return json<Record<string, unknown>>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...patch, ...(profile && profile !== 'default' ? { profile } : {}) }),
        },
      );
    },

    /**
     * profiles.get_asset (RPC) — the avatar as a data URL (never a new route). `found:false` is a
     * normal answer, not an error, so the caller falls back to the monogram (F1).
     */
    async asset(socket: DashboardSocket, profile: string): Promise<string | null> {
      // The RPC resolves the profile from `name` (methods_profiles.py:71-83), not `profile`:
      // measured against the live dashboard — `{asset, profile}` answers 4063 "name required".
      const result = await socket.rpc<{ found?: boolean; data?: string }>('profiles.get_asset', {
        asset: 'avatar',
        name: profile,
      });
      if (!result.found || typeof result.data !== 'string' || !result.data) return null;
      return result.data;
    },

    connect,
  };
}

export type DashboardClient = ReturnType<typeof createDashboardClient>;
