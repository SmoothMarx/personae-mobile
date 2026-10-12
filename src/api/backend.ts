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
import {
  createDashboardClient,
  type DashboardProfile,
  type DashboardSession,
  type DashboardSocket,
  type PreferenceDocument,
  type ProfileCreateResult,
} from './dashboard';
import { normalizePeers, type PeersResult } from '../logic/peers';
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
  /**
   * The batched sidebar slices (`recents` / `cron` / `messaging`). `recents` is the roster's own
   * feed and carries no cron runs; `cron` is where those live. One call, no per-profile fan-out.
   */
  sidebar(profile?: string, limits?: { recents?: number; cron?: number }): Promise<SidebarSlices>;
  /** Message-body search (FTS). Dashboard only; the legacy surface answers with an empty list. */
  searchMessages(query: string, profile: string, limit?: number): Promise<MessageHit[]>;
  /** Archive one session (never a delete). */
  archiveSession(id: string, profile?: string): Promise<void>;
  /** Delete one session — the only irreversible verb in the roster. */
  deleteSession(id: string, profile?: string): Promise<void>;
  /** 0.9.0 D — `Session ▸ Hide from Personae / Unhide`. `hidden` is NOT `archived`. */
  setHidden(id: string, hidden: boolean, profile?: string): Promise<void>;
  /** 0.9.0 D — `Session ▸ Mark as unread` (the read watermark, not a flag on a message). */
  markUnread(id: string, profile?: string): Promise<void>;
  /** 0.9.0 D — `Session ▸ Branch`: a new session that continues this transcript. */
  branch(id: string, profile?: string): Promise<HermesSession | null>;
  /**
   * 0.9.0 G — stage one image onto the session server-side (`image.attach_bytes`, which exists for a
   * remote client). The next `chatStream` carries it to the agent: the image is written into the
   * session's OWN images directory, so this is a real attachment and not a phone-local picture.
   */
  attachImage(
    sessionId: string,
    base64: string,
    filename: string,
    profile?: string,
  ): Promise<{ path: string; count: number }>;
  /**
   * 0.9.0 H — stage ANY media type onto the session (`file.attach`, whose decoder is explicitly the
   * "any media type" one). A voice note rides this: the gateway writes it into the session workspace
   * and hands the agent an `@file:<ref>`, so the audio is a real file on the box.
   */
  attachFile(
    sessionId: string,
    dataUrl: string,
    name: string,
    profile?: string,
  ): Promise<{ path: string; refText: string; uploaded: boolean }>;
  /**
   * 0.9.0 Phase A/I — the portable-preference document. `null` means the state plugin is not mounted
   * on this host, which is an ordinary answer (older server), never an error.
   */
  preferences(): Promise<PreferenceDocument | null>;
  /** Merge a patch. `revision` is the one this client last saw; a stale one is merged, not applied. */
  putPreferences(patch: { revision?: number; preferences: Record<string, unknown> }): Promise<PreferenceDocument | null>;
  /** Lazy page of one profile's sessions, used when a row is expanded (R9). */
  profileSessions(profile: string, limit?: number): Promise<HermesSession[]>;
  /** Authoritative title for one session, or null (F4's second link in the chain). */
  sessionTitle(id: string, profile?: string): Promise<string | null>;
  messages(id: string, profile: string, limit?: number): Promise<HermesMessage[]>;
  rename(id: string, title: string, profile?: string): Promise<string>;
  createSession(title: string, profile?: string): Promise<HermesSession>;
  chatStream(sessionId: string, text: string, handlers: ChatHandlers, profile?: string): StreamHandle;
  /** Avatar as a data URL (dashboard only; the legacy surface returns null). */
  avatar(profile: string): Promise<string | null>;
  /**
   * The host's tailnet peers for the "Choose device" picker (0.7.0). The legacy `:9222` surface has
   * no such route — it declares no profiles at all, so it answers `{available:false}` rather than
   * issuing a request that cannot work.
   */
  tailscalePeers(): Promise<PeersResult>;
  /** Create a profile (dashboard only; the legacy surface has no profile list to add to). */
  createProfile(input: { name: string; description?: string }): Promise<ProfileCreateResult>;
  /** Release sockets. Safe to call more than once. */
  dispose(): void;
};

/** One message-body hit from `GET /api/plugins/messenger/search`. */
export type MessageHit = {
  session_id: string;
  role?: string;
  snippet: string;
};

/** The batched slices, normalised away from the wire (`recents.sessions` → `recents`). */
export type SidebarSlices = {
  recents: HermesSession[];
  cron: HermesSession[];
  messaging: HermesSession[];
  errors: { profile: string; error: string }[];
};

function toHermesSession(row: DashboardSession): HermesSession {
  return {
    id: row.id,
    title: row.title ?? null,
    preview: row.preview ?? null,
    model: row.model ?? null,
    source: row.source ?? undefined,
    profile: row.profile ?? null,
    started_at: row.started_at,
    last_active: row.last_active,
    last_read_at: row.last_read_at ?? null,
    is_active: row.is_active ?? null,
    waiting: row.waiting ?? null,
    needs_input: row.needs_input ?? null,
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

/**
 * 0.9.0 Phase A — the state plugin's verbs, ATTEMPTED then reported.
 *
 * `unreachable` is the sentence a surface with no such route answers with. The verb is always tried
 * first: a `404` is the *measured* answer "this host does not mount the plugin", never an assumption
 * made in advance from the surface's name.
 */
async function stateVerb(
  call: () => Promise<unknown>,
  unreachable: () => ApiError,
): Promise<void> {
  try {
    await call();
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.status === 404) throw unreachable();
    throw normalized;
  }
}

function createDashboardBackend(settings: Settings): Backend {
  const client = createDashboardClient(settings, {});
  let socket: DashboardSocket | null = null;
  let socketPromise: Promise<DashboardSocket> | null = null;
  /**
   * Whether this host mounts the state plugin. Probed ONCE per backend, because a host either has it
   * or does not; a mid-session `404` flips it back to `false` rather than retrying forever.
   */
  let stateProbe: Promise<boolean> | null = null;
  const stateUp = () => (stateProbe ??= client.stateAvailable());

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

    /**
     * The batched slices in one call. `recents` is the roster's feed; `cron` is where the job runs
     * live. Both are tagged with the profile they came from, which is what lets the roster group
     * without a per-profile fan-out (R9).
     */
    async sidebar(profile = 'all', limits: { recents?: number; cron?: number } = {}) {
      const body = await client.sidebar(profile, {
        recentsLimit: limits.recents ?? 50,
        cronLimit: limits.cron ?? 20,
      });
      const slice = (value: { sessions?: DashboardSession[] } | undefined) =>
        (value?.sessions ?? []).map(toHermesSession);
      return {
        recents: slice(body.recents),
        cron: slice(body.cron),
        messaging: slice(body.messaging),
        errors: body.errors ?? [],
      };
    },

    async searchMessages(query, profile = '', limit = 40) {
      return client.searchMessages(query, profile, limit);
    },

    /** The lazy page a row asks for when the user opens it. Cron runs are filtered by the roster. */
    async profileSessions(profile, limit = 25) {
      const body = await client.rail(profile || 'all', { limit, offset: 0 });
      return (body.sessions ?? []).map(toHermesSession);
    },

    /**
     * Archive one session. Through the state surface when the host mounts it — that is the route
     * that refuses a PINNED session out loud instead of silently archiving it — and through the
     * dashboard's own flags verb otherwise. One behaviour, two doors, never a second implementation.
     */
    async archiveSession(id, profile = '') {
      if (await stateUp()) {
        try {
          await client.stateArchive(id, profile);
          return;
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.status !== 404) throw normalized; // 409 'pinned' is a refusal, not a fallback
          stateProbe = Promise.resolve(false);
        }
      }
      await client.patchFlags(id, { archived: true }, profile);
    },

    async deleteSession(id, profile = '') {
      if (await stateUp()) {
        try {
          await client.stateDelete(id, profile);
          return;
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.status !== 404) throw normalized;
          stateProbe = Promise.resolve(false);
        }
      }
      await client.deleteSession(id, profile);
    },

    /** 0.9.0 D — the pane's own view filter, never a core mutation (the desktop's own rule). */
    async setHidden(id, hidden, profile = '') {
      await client.patchFlags(id, { hidden }, profile);
    },

    /** 0.9.0 D — the read watermark: `unread: true` is what the desktop's verb does. */
    async markUnread(id, profile = '') {
      await client.patchFlags(id, { unread: true }, profile);
    },

    /**
     * 0.9.0 G — `image.attach_bytes` over the WS channel the app already speaks. Reply is
     * `{attached, path, count, bytes, …}` (`tui_gateway/methods_prompt.py:849-877`).
     */
    async attachImage(sessionId, base64, filename, profile = '') {
      const live = await shared();
      const result = await live.rpc<Record<string, unknown>>('image.attach_bytes', {
        session_id: sessionId,
        content_base64: base64,
        filename,
        ...(profile ? { profile } : {}),
      });
      return { path: String(result.path ?? ''), count: Number(result.count ?? 0) };
    },

    /**
     * 0.9.0 H — `file.attach` (`tui_gateway/methods_prompt.py:938-959`): stages a non-image file into
     * the session workspace and returns the `@file:` ref the agent reads. `data_url` carries the
     * bytes because the phone has no gateway-visible path.
     */
    async attachFile(sessionId, dataUrl, name, profile = '') {
      const live = await shared();
      const result = await live.rpc<Record<string, unknown>>('file.attach', {
        session_id: sessionId,
        data_url: dataUrl,
        name,
        ...(profile ? { profile } : {}),
      });
      return {
        path: String(result.path ?? ''),
        refText: String(result.ref_text ?? ''),
        uploaded: result.uploaded === true,
      };
    },

    /** 0.9.0 D — `session.branch_stored`: a whole-session branch, server-side. */
    async branch(id, profile = '') {
      const live = await shared();
      const result = await live.rpc<Record<string, unknown>>('session.branch_stored', {
        session_id: id,
        ...(profile ? { profile } : {}),
      });
      const newId = String(result?.session_id ?? result?.id ?? '');
      if (!newId) return null;
      return { id: newId, title: (result?.title as string) ?? null, message_count: 0, last_active: Date.now() / 1000 };
    },

    /** The portable-preference document, or `null` when the state plugin is not mounted. */
    async preferences() {
      if (!(await stateUp())) return null;
      try {
        return await client.statePreferences('');
      } catch (error) {
        if (normalizeError(error).status === 404) {
          stateProbe = Promise.resolve(false);
          return null;
        }
        throw error;
      }
    },

    async putPreferences(patch) {
      if (!(await stateUp())) return null;
      try {
        return await client.statePutPreferences(patch, '');
      } catch (error) {
        if (normalizeError(error).status === 404) {
          stateProbe = Promise.resolve(false);
          return null;
        }
        throw error;
      }
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
      if (!id) throw new ApiError(t.errors.server(500, t.errors.sessionNoId), { kind: 'http', status: 500 });
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
                    new ApiError(t.errors.server(500, String(event.payload.message ?? t.errors.turnFailed)), {
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

    /** The host's tailnet peers (0.7.0). Any refusal is normalised to `available: false`. */
    async tailscalePeers() {
      try {
        return normalizePeers(await client.tailscalePeers());
      } catch (error) {
        return normalizePeers({ available: false, reason: normalizeError(error).status === 404 ? 'unsupported' : 'error' });
      }
    },

    createProfile(input) {
      return client.createProfile(input);
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

    /**
     * The legacy surface has no batched sidebar. Its flat list is what stands in for `recents`, so
     * the roster keeps ONE code path: the api_server's list carries no `source`, so nothing is
     * classified as a cron run here — and the surface has no cron slice to misread either.
     */
    async sidebar(profile = '') {
      const body = await api.listSessions(profile, 100, 0);
      const rows = (body.data ?? []).map((row) => ({ ...row, profile: row.profile ?? (profile || 'default') }));
      return { recents: rows, cron: [], messaging: [], errors: [] };
    },

    async searchMessages() {
      // Message bodies are not searchable on the api_server surface; the metadata sweep is all the
      // search is there, and saying so beats issuing a request that cannot answer.
      return [];
    },

    async profileSessions(profile = '', limit = 25) {
      const body = await api.listSessions(profile, limit, 0);
      return (body.data ?? []).map((row) => ({ ...row, profile: row.profile ?? (profile || 'default') }));
    },

    /**
     * 0.9.0 Phase A — archive, routed at the SAME verbs the dashboard uses.
     *
     * The `501 archiveUnsupported` stub that used to live here was a refusal without a request: it
     * could not tell "this surface has no such route" from "this host changed". It is now an attempt
     * through this surface's own credential and error ladder, and a `404` — the measured answer that
     * this host does not mount the dashboard's plugin routes — is turned into the same sentence the
     * button shows, so what the UI promises and what the call answers cannot drift.
     */
    archiveSession(id, profile = '') {
      return stateVerb(
        () => api.stateCall(`/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST' }, profile),
        () => new ApiError(t.errors.server(501, t.errors.archiveUnsupported), { kind: 'http', status: 501 }),
      );
    },

    /** 0.9.0 Phase A — delete, the same way (and the same single irreversible verb). */
    deleteSession(id, profile = '') {
      return stateVerb(
        () => api.stateCall(`/sessions/${encodeURIComponent(id)}/delete`, { method: 'POST' }, profile),
        () => new ApiError(t.errors.server(501, t.errors.deleteUnsupported), { kind: 'http', status: 501 }),
      );
    },

    /** 0.9.0 D — the hide flag is a dashboard route; this surface answers 501 out loud. */
    setHidden() {
      return Promise.reject(
        new ApiError(t.errors.server(501, t.errors.flagsUnsupported), { kind: 'http', status: 501 }),
      );
    },

    markUnread() {
      return Promise.reject(
        new ApiError(t.errors.server(501, t.errors.flagsUnsupported), { kind: 'http', status: 501 }),
      );
    },

    /** 0.9.0 G/H — the attach RPCs are WS methods; only the dashboard surface speaks that channel. */
    attachImage() {
      return Promise.reject(
        new ApiError(t.errors.server(501, t.errors.attachUnsupported), { kind: 'http', status: 501 }),
      );
    },

    attachFile() {
      return Promise.reject(
        new ApiError(t.errors.server(501, t.errors.attachUnsupported), { kind: 'http', status: 501 }),
      );
    },

    /** 0.9.0 D — branching needs the WS RPC channel, which only the dashboard surface speaks. */
    branch() {
      return Promise.reject(
        new ApiError(t.errors.server(501, t.errors.branchUnsupported), { kind: 'http', status: 501 }),
      );
    },

    /** No plugin routes on this surface either: a `404` is reported as "not mounted", never thrown. */
    async preferences() {
      try {
        return await api.stateCall<PreferenceDocument>('/preferences', { method: 'GET' }, '');
      } catch (error) {
        if (normalizeError(error).status === 404) return null;
        throw error;
      }
    },

    async putPreferences(patch) {
      try {
        return await api.stateCall<PreferenceDocument>(
          '/preferences',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
          '',
        );
      } catch (error) {
        if (normalizeError(error).status === 404) return null;
        throw error;
      }
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
      return Promise.reject(new ApiError(t.errors.server(501, t.errors.renameUnsupported), { kind: 'http', status: 501 }));
    },

    async createSession(title, profile = '') {
      const body = await api.createSession(title, profile);
      return body.session;
    },

    chatStream: (sessionId, text, handlers, profile = '') => api.chatStream(sessionId, text, handlers, profile),

    avatar: () => Promise.resolve(null),

    /** No such route on the api_server surface, and no profiles at all: say so without a request. */
    tailscalePeers: () => Promise.resolve(normalizePeers({ available: false, reason: 'unsupported_surface' })),

    createProfile() {
      return Promise.reject(
        new ApiError(t.errors.server(501, t.errors.profileCreateUnsupported), { kind: 'http', status: 501 }),
      );
    },

    dispose: () => undefined,
  };
}
