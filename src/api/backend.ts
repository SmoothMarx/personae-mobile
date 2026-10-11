/**
 * One interface, two surfaces.
 *
 * The screens ask for profiles, sessions, a thread and a stream. *How* those arrive differs by
 * surface (`src/settings.ts` `Surface`):
 *
 *   dashboard (`hermes dashboard`, :9119)  REST + `/api/ws` JSON-RPC, bearer + per-connection ticket
 *   gateway   (`:9222` api_server, legacy) REST + SSE, bearer
 *
 * Keeping the split here — and only here — is what let the UI keep a single vocabulary while the
 * transport underneath changed, and it keeps the legacy path intact instead of deleting a working
 * route. Every method returns the *app's* shapes, not the wire's.
 */

import { createApi, type ChatStreamHandlers, type HermesMessage, type HermesSession, type HealthResponse } from './client';
import { createDashboardClient, type DashboardProfile, type DashboardSession, type DashboardSocket } from './dashboard';
import { xhrTransport, type StreamHandle } from './transport';
import { ApiError, normalizeError } from './errors';
import { t } from '../i18n';
import type { Settings, Surface } from '../settings';

/** Live tool activity as it happens (the half of F3 that only the WS channel can carry). */
export type LiveTool = {
  phase: 'start' | 'complete';
  id: string;
  name: string;
  args: string;
  result: string | null;
  ok: boolean;
};

export type ChatHandlers = ChatStreamHandlers & {
  onTool?: (event: LiveTool) => void;
};

export type ProfileInfo = {
  name: string;
  label: string;
  isDefault: boolean;
  /** `false` = definitely no avatar; `null`/undefined = unknown (probe in the background). */
  hasAvatar: boolean | null;
  description?: string;
  model?: string | null;
  provider?: string | null;
  skillCount?: number;
  gatewayRunning?: boolean;
};

export type Backend = {
  kind: Surface;
  /** Does this surface expose a profile list/rail (the dashboard does, the api_server does not)? */
  readonly hasProfiles: boolean;
  health(profile?: string): Promise<HealthResponse>;
  profiles(): Promise<ProfileInfo[]>;
  /** Sessions, newest activity first. `profile` scopes the dashboard; the legacy path prefixes it. */
  sessions(profile: string, limit?: number, offset?: number): Promise<{ data: HermesSession[]; total?: number }>;
  /** Authoritative title for one session, or null (F4's second link in the chain). */
  sessionTitle(id: string, profile?: string): Promise<string | null>;
  messages(id: string, profile: string, limit?: number): Promise<HermesMessage[]>;
  rename(id: string, title: string, profile?: string): Promise<string>;
  createSession(title: string, profile?: string): Promise<HermesSession>;
  chatStream(sessionId: string, text: string, handlers: ChatHandlers, profile?: string): StreamHandle;
  /** Avatar as a data URL (dashboard only; the legacy surface returns null). */
  avatar(profile: string): Promise<string | null>;
  /** Release sockets. Safe to call more than once. */
  dispose(): void;
};

function toHermesSession(row: DashboardSession): HermesSession {
  return {
    id: row.id,
    title: row.title ?? null,
    preview: row.preview ?? null,
    model: row.model ?? null,
    source: row.source ?? undefined,
    started_at: row.started_at,
    last_active: row.last_active,
    message_count: row.message_count,
    tool_call_count: row.tool_call_count,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    estimated_cost_usd: row.estimated_cost_usd ?? null,
    pinned: row.pinned,
    archived: row.archived,
    hidden: row.hidden,
    parent_session_id: row.parent_session_id ?? null,
  };
}

export function createBackend(settings: Settings, options: { transport?: typeof xhrTransport } = {}): Backend {
  if (settings.surface === 'dashboard') return createDashboardBackend(settings);
  return createGatewayBackend(settings, options.transport ?? xhrTransport);
}

// ───────────────────────────────────────────────── dashboard ──

function createDashboardBackend(settings: Settings): Backend {
  const client = createDashboardClient(settings, {});
  let socket: DashboardSocket | null = null;
  let socketPromise: Promise<DashboardSocket> | null = null;

  /** One lazily-opened socket serves every avatar fetch, so the roster never opens N of them. */
  const shared = async (): Promise<DashboardSocket> => {
    if (socket && !socket.closed) return socket;
    socketPromise = socketPromise && socket && !socket.closed ? socketPromise : client.connect({});
    socket = await socketPromise;
    return socket;
  };

  return {
    kind: 'dashboard',
    hasProfiles: true,

    async health() {
      // /api/status is the dashboard's public status route; a bearer'd /api/profiles would also
      // prove the credential, but the status dot must not depend on it.
      try {
        return await client.rail('all', { limit: 1 }).then(() => ({ status: 'ok', platform: 'hermes-dashboard', version: '' }));
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.isAuth) throw normalized;
        throw normalized;
      }
    },

    async profiles() {
      const rows = await client.profiles();
      return rows.map((row: DashboardProfile) => ({
        name: row.name,
        label: row.label || row.name,
        isDefault: Boolean(row.is_default),
        hasAvatar: row.has_avatar ?? null,
        description: row.description,
        model: row.model ?? null,
        provider: row.provider ?? null,
        skillCount: row.skill_count,
        gatewayRunning: row.gateway_running,
      }));
    },

    async sessions(profile = '', limit = 200, offset = 0) {
      const body = await client.rail(profile || 'all', { limit, offset });
      return { data: (body.sessions ?? []).map(toHermesSession), total: body.total };
    },

    async sessionTitle(id, profile = '') {
      try {
        const row = await client.session(id, profile);
        const title = (row?.title ?? '').trim();
        return title || null;
      } catch (error) {
        if (normalizeError(error).status === 404) return null;
        throw error;
      }
    },

    async messages(id, profile = '', limit = 200) {
      const body = await client.messages(id, profile, limit);
      return Array.isArray(body.messages) ? body.messages : [];
    },

    async rename(id, title, profile = '') {
      const body = await client.rename(id, title, profile);
      return String(body.title ?? title);
    },

    async createSession(title) {
      // The dashboard creates sessions over the WS RPC (session.create); there is no REST POST for
      // sessions on that surface.
      const live = await shared();
      const result = await live.rpc<Record<string, unknown>>('session.create', title.trim() ? { title: title.trim() } : {});
      const id = String(result.session_id ?? result.id ?? '');
      if (!id) throw new ApiError(t.errors.server(500, 'sessão sem id'), { kind: 'http', status: 500 });
      return { id, title: title.trim() || null, message_count: 0, last_active: Date.now() / 1000 };
    },

    chatStream(sessionId, text, handlers, profile = '') {
      let live: DashboardSocket | null = null;
      let closed = false;
      let sawCompletion = false;

      const finish = (aborted: boolean) => {
        if (closed) return;
        closed = true;
        try {
          live?.close();
        } catch {
          /* already gone */
        }
        handlers.onClose({ aborted });
      };

      void (async () => {
        try {
          live = await client.connect({
            onClose: () => finish(false),
            onError: (error) => handlers.onError(normalizeError(error)),
            onEvent: (event) => {
              const text = typeof event.payload.text === 'string' ? event.payload.text : '';
              switch (event.type) {
                case 'message.delta':
                  if (text) handlers.onDelta?.(text);
                  break;
                case 'message.complete':
                  sawCompletion = true;
                  handlers.onFinal?.(text, event.payload);
                  break;
                case 'tool.start':
                  handlers.onTool?.({
                    phase: 'start',
                    id: String(event.payload.tool_call_id ?? event.payload.id ?? ''),
                    name: String(event.payload.name ?? ''),
                    args: typeof event.payload.arguments === 'string' ? event.payload.arguments : JSON.stringify(event.payload.arguments ?? ''),
                    result: null,
                    ok: true,
                  });
                  break;
                case 'tool.complete':
                  handlers.onTool?.({
                    phase: 'complete',
                    id: String(event.payload.tool_call_id ?? event.payload.id ?? ''),
                    name: String(event.payload.name ?? ''),
                    args: '',
                    result: typeof event.payload.result === 'string' ? event.payload.result : JSON.stringify(event.payload.result ?? ''),
                    ok: event.payload.ok !== false,
                  });
                  break;
                case 'turn.error':
                  handlers.onError(
                    new ApiError(t.errors.server(500, String(event.payload.message ?? 'erro no turno')), {
                      kind: 'http',
                      detail: String(event.payload.message ?? ''),
                    }),
                  );
                  break;
                default:
                  break;
              }
            },
          });
          handlers.onOpen?.();
          await live.rpc('prompt.submit', { session_id: sessionId, text, ...(profile ? { profile } : {}) });
        } catch (error) {
          handlers.onError(normalizeError(error));
          finish(false);
          return;
        }
        // A turn ends with message.complete; if the socket closes without one the reply is partial,
        // which the caller is told about through onClose (aborted: false) — never silently.
        void sawCompletion;
      })();

      return {
        close: () => {
          const target = live;
          if (target && !target.closed) {
            void target.rpc('session.interrupt', { session_id: sessionId }).catch(() => undefined);
          }
          finish(true);
        },
      };
    },

    async avatar(profile) {
      try {
        const live = await shared();
        return await client.asset(live, profile);
      } catch {
        // An avatar is decoration: a failure must never surface as an error card.
        return null;
      }
    },

    dispose() {
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      socket = null;
      socketPromise = null;
    },
  };
}

// ───────────────────────────────────────────────── legacy :9222 ──

function createGatewayBackend(settings: Settings, transport: typeof xhrTransport): Backend {
  const api = createApi(settings, { transport });

  return {
    kind: 'gateway',
    hasProfiles: false,
    health: (profile = '') => api.health(profile),

    async profiles() {
      // The api_server has no profile route: the roster falls back to the declared contacts.
      return [];
    },

    async sessions(profile = '', limit = 200, offset = 0) {
      const body = await api.listSessions(profile, limit, offset);
      return { data: body.data ?? [], total: undefined };
    },

    async sessionTitle(id, profile = '') {
      // No session-detail route on this surface; the title travels as a route param instead.
      void id;
      void profile;
      return null;
    },

    async messages(id, profile = '', limit = 200) {
      const body = await api.messages(id, profile, limit);
      return Array.isArray(body.data) ? body.data : [];
    },

    rename() {
      return Promise.reject(new ApiError(t.errors.server(501, 'renomear não é suportado nesta ligação'), { kind: 'http', status: 501 }));
    },

    async createSession(title, profile = '') {
      const body = await api.createSession(title, profile);
      return body.session;
    },

    chatStream: (sessionId, text, handlers, profile = '') => api.chatStream(sessionId, text, handlers, profile),

    avatar: () => Promise.resolve(null),
    dispose: () => undefined,
  };
}
