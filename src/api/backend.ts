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
import type { SlashCompletion, SlashItem } from '../logic/slash';
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

/**
 * 0.11.0 R7 — what a live subscription delivers. Every one of these is a frame the gateway already
 * emits; the subscription adds no new vocabulary of its own.
 */
export type SessionWatchHandlers = {
  onDelta?: (text: string) => void;
  onFinal?: (text: string, payload: Record<string, unknown>) => void;
  /** `reasoning.delta` — the live thinking block. The SERVER gates this (a session flag, else the
   *  config default), so there is deliberately no client-side gate here. */
  onReasoning?: (text: string) => void;
  onTool?: (tool: LiveTool) => void;
  onError?: (error: ApiError) => void;
  /** The watcher re-attached (or the gateway restarted) and the caller must REFETCH, not stitch. */
  onRefetch?: (reason: 'truncated' | 'epoch') => void;
  /** The watcher could not attach at all: the thread must still be readable. Never an error card. */
  onUnavailable?: () => void;
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
  /**
   * 0.11.0 R7 — subscribe this device to a session's LIVE frames, on the socket it already sends on.
   *
   * The gateway routes events to the SESSION's transport, and a socket only receives a session's
   * frames once it has attached to it (`session.activate`, additive by construction:
   * `_rebind_live_transport` — "Attach a live peer without displacing existing subscribers"). Before
   * this method the app never attached, so a turn started anywhere else had NO listener here and the
   * only way to see it was to leave the screen and come back. Returns an unsubscribe.
   *
   * `handlers` are the SAME handlers the screen paints a turn with (delta / final / reasoning / tool),
   * which is what makes a turn started on another machine stream into the bubble this screen renders.
   */
  watchSession(
    sessionId: string,
    handlers: SessionWatchHandlers,
    profile?: string,
  ): Promise<{ close(): void }>;
  /**
   * 0.11.0 R5 — the gateway's OWN slash completer (`complete.slash`). One request over the shared
   * socket; the server decides what is offered (it answers nothing at all unless the text starts with
   * `/`, and `replace_from` is computed from the END of the string).
   */
  completeSlash(sessionId: string, text: string, profile?: string): Promise<SlashCompletion>;
  /**
   * 0.11.0 R6 — run one slash command and return its text. `prompt.submit` has NO slash handling;
   * commands are dispatched by client-called RPCs, which is why the menu would otherwise hand out dead
   * text. `slash.exec` first, `command.dispatch` once on the documented 4018 skill refusal.
   */
  runSlashCommand(sessionId: string, command: string, profile?: string): Promise<{ output: string }>;
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

/**
 * One message-body hit from `GET /api/plugins/messenger/search`. */
export type MessageHit = {
  session_id: string;
  role?: string;
  snippet: string;
};

// ───────────────────────────────────────── 0.11.0 R5/R6/R7: the live wire, in ONE place ──

/**
 * Turn one gateway frame into the app's channels (text / tool / reasoning).
 *
 * 0.11.0 R7 hoists this out of `chatStream` for a reason that is the item's whole point: the frames a
 * SUBSCRIPTION receives and the frames a turn's own socket receives are the same frames, and two
 * copies of this switch is how the two drift apart. `true` means the turn completed (`message.complete`)
 * — the value the caller must not throw away (§R7.c).
 *
 * `thinking.delta` is deliberately NOT here: it carries wait notices and the quiet spinner, with a
 * comment in the serving code saying outright they are not reasoning blocks
 * (`agent_callbacks.py:117-125`). It stays dropped (§15).
 */
function routeEvent(
  event: { type: string; payload: Record<string, unknown> },
  handlers: {
    onDelta?: (text: string) => void;
    onFinal?: (text: string, payload: Record<string, unknown>) => void;
    onReasoning?: (text: string) => void;
    onTool?: (tool: LiveTool) => void;
    onError?: (error: ApiError) => void;
  },
): boolean {
  const text = typeof event.payload.text === 'string' ? event.payload.text : '';
  switch (event.type) {
    case 'message.delta':
      if (text) handlers.onDelta?.(text);
      return false;
    case 'message.complete':
      handlers.onFinal?.(text, event.payload);
      return true;
    case 'tool.start':
      handlers.onTool?.({
        phase: 'start',
        id: String(event.payload.tool_call_id ?? event.payload.id ?? ''),
        name: String(event.payload.name ?? ''),
        args: typeof event.payload.arguments === 'string' ? event.payload.arguments : JSON.stringify(event.payload.arguments ?? ''),
        result: null,
        ok: true,
      });
      return false;
    case 'tool.complete':
      handlers.onTool?.({
        phase: 'complete',
        id: String(event.payload.tool_call_id ?? event.payload.id ?? ''),
        name: String(event.payload.name ?? ''),
        args: '',
        result: typeof event.payload.result === 'string' ? event.payload.result : JSON.stringify(event.payload.result ?? ''),
        ok: event.payload.ok !== false,
      });
      return false;
    case 'reasoning.delta':
      // 0.11.0 R7.b — the model's live reasoning. Emitted by the gateway as `reasoning.delta`
      // (`agent_callbacks.py:135-138`) and gated SERVER-side by `_session_show_reasoning(sid)`
      // ("missing means the config default, not hidden"), so there is no gate here.
      if (text) handlers.onReasoning?.(text);
      return false;
    case 'turn.error':
      handlers.onError?.(
        new ApiError(t.errors.server(500, String(event.payload.message ?? t.errors.turnFailed)), {
          kind: 'http',
          detail: String(event.payload.message ?? ''),
        }),
      );
      return false;
    default:
      // About two dozen more types ride the wire (`message.start`, `message.interim`,
      // `tool.generating`, `notification.show`, `status.update`, `session.usage`, …). An unknown frame
      // is not an error.
      return false;
  }
}

/**
 * The text a COMMAND's reply carries.
 *
 * `command.dispatch` payloads are command-specific and are not always `{output}`: a dispatch may answer
 * `{output}`, a `{type:'send', message}` seed, or a plugin's own shape. So this renders `output` when
 * it is there and otherwise the first message-like string — and it deliberately does NOT invent a
 * renderer per command.
 */
function commandText(result: Record<string, unknown>): string {
  for (const key of ['output', 'message', 'text', '_exec_out', 'warning']) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** One completion row as the app's shape, from the server's. Junk is dropped, never rendered. */
function toSlashItem(raw: unknown): SlashItem | null {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = String(row.text ?? '').trim();
  if (!text) return null;
  return {
    text,
    display: String(row.display ?? text).trim() || text,
    meta: String(row.meta ?? '').trim(),
    kind: String(row.kind ?? 'command'),
  };
}

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

/**
 * 0.13.0 W2 — is this rejection the gateway's IN-MEMORY session map miss?
 *
 * `_sess_nowait` (`tui_gateway/server.py`) does `s = _sessions.get(sid)`; when the id is not resident
 * it answers JSON-RPC error code **4001** with the message **`session not found`**, and `_sess_building`
 * only builds an agent AFTER that lookup succeeds — so no RPC can warm a cold session. The gateway's
 * own log line states the contract: *the client should resume the stored session.*
 *
 * Both halves are read, because either one alone can be the one that survives the wire: the code
 * (mapped onto `ApiError.status` by the socket's JSON-RPC error path) and the message (mapped onto
 * `detail`). Nothing else is treated as a cold session — this is not a general retry predicate.
 */
export function isColdSessionRpc(error: ApiError): boolean {
  if (error.status === 4001) return true;
  const detail = `${error.detail ?? ''} ${error.message}`.toLowerCase();
  return detail.includes('session not found');
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

  /**
   * 0.11.0 R7 — who wants to know when the ONE socket dies.
   *
   * `shared()` opens a single lazily-opened socket for everything this screen does, which is what makes
   * "one socket per mounted thread screen" true (§10.11). But nothing could OBSERVE that socket dying:
   * the subscription needs it (to re-attach and catch up) and so does the turn (a socket close without
   * `message.complete` is a TRUNCATED reply, not a finished turn — §R7.c). So the socket is opened
   * with one close hook that fans out to whoever registered.
   */
  const deathHandlers = new Set<() => void>();
  const onSocketDeath = (handler: () => void): (() => void) => {
    deathHandlers.add(handler);
    return () => deathHandlers.delete(handler);
  };

  /** One lazily-opened socket serves every avatar fetch, so the roster never opens N of them. */
  const shared = async (): Promise<DashboardSocket> => {
    if (socket && !socket.closed) return socket;
    socketPromise = socketPromise && socket && !socket.closed
      ? socketPromise
      : client.connect({
          onClose: () => {
            for (const notify of Array.from(deathHandlers)) {
              try {
                notify();
              } catch {
                /* one bad listener must not stop the others */
              }
            }
          },
        });
    socket = await socketPromise;
    return socket;
  };

  /**
   * 0.13.0 W2 — ONE liveness step for the ATTACH RPCs, on the socket this client already holds.
   *
   * The gateway resolves sessions from an in-memory map, so an attach to a session it no longer holds
   * resident is rejected `4001 session not found` — and an attach can never warm it (`_sess_building`
   * runs only after that lookup succeeds). The TEXT path already resolves first
   * (`watchSession`'s activate-then-resume, below); the attach path had no liveness step at all. That
   * asymmetry is the bug, and this is the missing half. Exactly one resume and one retry, then stop.
   */
  const attachRpc = async <T,>(
    method: string,
    params: Record<string, unknown>,
    profile: string,
  ): Promise<T> => {
    const live = await shared();
    try {
      return await live.rpc<T>(method, params);
    } catch (error) {
      const normalized = normalizeError(error);
      // Not a cold session: surface it unchanged. Nothing else is ever retried here.
      if (!isColdSessionRpc(normalized)) throw normalized;
      // ONE resume …
      await live.rpc('session.resume', {
        session_id: String(params.session_id ?? ''),
        ...(profile ? { profile } : {}),
      });
      // … and ONE retry. A second failure propagates: no loop, no backoff, no third attempt.
      return await live.rpc<T>(method, params);
    }
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
     *
     * 0.13.0 W2 — rides `attachRpc`, so a cold session is resumed once and the attach retried once
     * (the liveness step the text path already had and this one never did).
     */
    async attachImage(sessionId, base64, filename, profile = '') {
      const result = await attachRpc<Record<string, unknown>>(
        'image.attach_bytes',
        {
          session_id: sessionId,
          content_base64: base64,
          filename,
          ...(profile ? { profile } : {}),
        },
        profile,
      );
      return { path: String(result.path ?? ''), count: Number(result.count ?? 0) };
    },

    /**
     * 0.9.0 H — `file.attach` (`tui_gateway/methods_prompt.py:938-959`): stages a non-image file into
     * the session workspace and returns the `@file:` ref the agent reads. `data_url` carries the
     * bytes because the phone has no gateway-visible path.
     *
     * 0.13.0 W2 — the voice note rides THIS call, and this is the path that was failing: same
     * resume-once/retry-once liveness step as the image path, on the same shared socket.
     */
    async attachFile(sessionId, dataUrl, name, profile = '') {
      const result = await attachRpc<Record<string, unknown>>(
        'file.attach',
        {
          session_id: sessionId,
          data_url: dataUrl,
          name,
          ...(profile ? { profile } : {}),
        },
        profile,
      );
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

    /**
     * 0.11.0 R7 (§R7.e) — the turn is SUBMITTED on the socket this screen already holds, and the
     * returned handle keeps its `{close}` shape.
     *
     * What changed from 0.10.0 and why: the per-turn socket is FOLDED IN rather than run alongside the
     * subscription (§10.11 — one socket per mounted thread screen). Paint is the SUBSCRIPTION's job
     * (`watchSession` routes every frame of this session through the same handlers), so a turn started
     * here and a turn started on another machine take ONE code path. This method owns exactly two
     * things: the `prompt.submit` that starts the turn, and the END of it —
     *
     *   * `message.complete` is a completed turn;
     *   * a socket close without one is a TRUNCATED reply. `sawCompletion` used to be computed and then
     *     thrown away (`void sawCompletion`), which painted a mid-turn disconnect as a normal end of
     *     turn, while the comment above it promised the caller was told "never silently".
     */
    chatStream(sessionId, text, handlers, profile = '') {
      let live: DashboardSocket | null = null;
      let settled = false;
      let sawCompletion = false;
      const offs: (() => void)[] = [];

      const finish = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        for (const off of offs.splice(0)) off();
        offDeath();
        handlers.onClose({ aborted });
      };

      const offDeath = onSocketDeath(() => {
        if (!settled && !sawCompletion) finish(true);
      });

      void (async () => {
        try {
          live = await shared();
          offs.push(
            live.on('message.complete', (event) => {
              if (event.sessionId && event.sessionId !== sessionId) return;
              sawCompletion = true;
              finish(false);
            }),
            live.on('turn.error', (event) => {
              if (event.sessionId && event.sessionId !== sessionId) return;
              routeEvent(event, handlers); // handlers.onError for this frame
            }),
          );
          handlers.onOpen?.();
          await live.rpc('prompt.submit', { session_id: sessionId, text, ...(profile ? { profile } : {}) });
        } catch (error) {
          handlers.onError(normalizeError(error));
          finish(false);
        }
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

    /**
     * 0.11.0 R7 — attach this device to a session's live frames, and CATCH UP when the connection
     * comes back.
     *
     * Three defects, one symptom ("your responses and reasoning should show up on the conversation in
     * real time, it should not need a refresh — exit session and come back in"):
     *
     *   a. nothing was subscribed. The gateway routes events to the SESSION's transport, and a socket
     *      receives a session's frames only after attaching to it. Attach is ADDITIVE by construction
     *      (`_rebind_live_transport`: "Attach a live peer without displacing existing subscribers"), so
     *      this never steals the desktop's view — see §R7.d, which is the server's own policy, untouched.
     *   b. `reasoning.delta` was emitted by the gateway and dropped by the client's five-case switch.
     *   c. a dropped socket was reported as a finished turn.
     *
     * ONE SOCKET: listeners first, THEN `session.activate` — a frame must never arrive before something
     * is listening. `omit_messages: true` because this device already read the history over REST.
     */
    async watchSession(sessionId, handlers, profile = '') {
      let offs: (() => void)[] = [];
      let closed = false;
      /** The highest `seq` seen — the watermark a reconnect replays from. */
      let lastSeen = 0;
      /** The server process's seq numbering (`gateway.ready`'s `replay_epoch`). */
      let epoch = '';
      let offDeath: (() => void) | null = null;

      const catchUp = async (live: DashboardSocket) => {
        // Nothing was seen yet: this is a fresh attach, and the history came from the REST read.
        if (lastSeen <= 0) return;
        try {
          const answer = await live.rpc<{
            events?: unknown;
            latest_seq?: unknown;
            truncated?: unknown;
            epoch?: unknown;
          }>('session.events.since', { session_id: sessionId, last_seen: lastSeen });
          if (answer.truncated === true) {
            // Past the ring window: a REFETCH, never a stitched replay with a hole in it.
            lastSeen = Number(answer.latest_seq ?? 0) || lastSeen;
            handlers.onRefetch?.('truncated');
            return;
          }
          if (epoch && String(answer.epoch ?? '') && String(answer.epoch) !== epoch) {
            epoch = String(answer.epoch);
            lastSeen = 0;
            handlers.onRefetch?.('epoch');
            return;
          }
          const frames = Array.isArray(answer.events) ? answer.events : [];
          for (const frame of frames) {
            const event = frame as { type?: unknown; payload?: unknown; session_id?: unknown; seq?: unknown };
            route(event as never);
          }
          const latest = Number(answer.latest_seq ?? 0);
          if (Number.isFinite(latest)) lastSeen = Math.max(lastSeen, latest);
        } catch {
          /* a catch-up that cannot answer must not break the watcher */
        }
      };

      const route = (event: { type: string; payload: Record<string, unknown>; sessionId?: string; seq?: number }) => {
        if (closed) return;
        if (event.type === 'gateway.ready') {
          // The FIRST frame of every connection (ws.py:367) — the reconnect signal. A changed epoch
          // means the gateway restarted and this device's seq watermark means nothing any more.
          const next = String(event.payload.replay_epoch ?? '');
          if (epoch && next && next !== epoch) {
            epoch = next;
            lastSeen = 0;
            handlers.onRefetch?.('epoch');
            return;
          }
          if (next) epoch = next;
          void catchUp(liveRef);
          return;
        }
        // FILTER BY SESSION: this socket also carries whatever else the app does, and another
        // session's frames must change nothing here.
        if (event.sessionId && event.sessionId !== sessionId) return;
        if (typeof event.seq === 'number') lastSeen = Math.max(lastSeen, event.seq);
        routeEvent(event, handlers);
      };

      let liveRef: DashboardSocket;
      const listen = (live: DashboardSocket) => {
        liveRef = live;
        offs = [
          live.on('message.delta', route),
          live.on('message.complete', route),
          live.on('tool.start', route),
          live.on('tool.complete', route),
          live.on('reasoning.delta', route),
          live.on('turn.error', route),
          live.on('gateway.ready', route),
        ];
      };

      /**
       * `session.activate` can fail TRANSIENTLY, and that is not an error card: `_reattach_refusal`
       * answers `4007 "session no longer live; retry resume"` and `4009 "session disconnect interrupt
       * settling"` (`session_lifecycle.py:819-827`). On 4007 fall back to `session.resume`; on 4009
       * retry once after a short delay; on anything else the thread simply stays readable without a
       * subscription. A watcher that cannot attach must not look broken.
       */
      const activate = async (live: DashboardSocket) => {
        const params = { session_id: sessionId, omit_messages: true, ...(profile ? { profile } : {}) };
        try {
          await live.rpc('session.activate', params);
          return;
        } catch (error) {
          const normalized = normalizeError(error);
          if (normalized.status === 4007) {
            try {
              await live.rpc('session.resume', { session_id: sessionId, ...(profile ? { profile } : {}) });
              return;
            } catch {
              handlers.onUnavailable?.();
              return;
            }
          }
          if (normalized.status === 4009) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            try {
              await live.rpc('session.activate', params);
              return;
            } catch {
              handlers.onUnavailable?.();
              return;
            }
          }
          handlers.onUnavailable?.();
        }
      };

      const live = await shared();
      listen(live);
      await activate(live);
      // A dead socket is re-attached on a FRESH one: `shared()` sees `socket.closed` and opens again,
      // and its `gateway.ready` frame drives the epoch check and the replay-watermark catch-up.
      offDeath = onSocketDeath(() => {
        if (closed) return;
        void (async () => {
          try {
            for (const off of offs.splice(0)) off();
            const next = await shared();
            listen(next);
            await activate(next);
          } catch {
            handlers.onUnavailable?.();
          }
        })();
      });

      return {
        close() {
          if (closed) return;
          closed = true;
          for (const off of offs.splice(0)) off();
          offDeath?.();
          offDeath = null;
        },
      };
    },

    /**
     * 0.11.0 R5 — the server's own completer, over the shared socket. No new connection (§10.10) and
     * no new dependency: `complete.*` is a WS method with no HTTP route.
     */
    async completeSlash(sessionId, text, profile = '') {
      const live = await shared();
      const result = await live.rpc<{ items?: unknown; replace_from?: unknown }>('complete.slash', {
        text,
        session_id: sessionId,
        ...(profile ? { profile } : {}),
      });
      const raw = Array.isArray(result.items) ? result.items : [];
      return {
        items: raw.map(toSlashItem).filter((item): item is SlashItem => item !== null),
        replaceFrom: Number(result.replace_from),
      } satisfies SlashCompletion;
    },

    /**
     * 0.11.0 R6 (approach A) — run one command.
     *
     * `prompt.submit` has NO slash handling at all: the word "slash" does not occur once in
     * `tui_gateway/methods_prompt.py`, and nothing downstream of it parses a leading `/`. Slash
     * commands are dispatched by separate, CLIENT-CALLED RPCs — `slash.exec`
     * (`methods_tools.py:1113`) and `command.dispatch` (`:1093`) — and that file states the contract in
     * as many words: *"Recognized skills keep the 4018 gate so clients command.dispatch."*
     *
     * So: `slash.exec` FIRST, and `command.dispatch` exactly once on that documented 4018. The retry
     * exists only for the skill path — `slash.exec` already routes pending-input commands and bundles
     * to `command.dispatch` itself (`:1132-1137`).
     */
    async runSlashCommand(sessionId, command, profile = '') {
      const live = await shared();
      const cleaned = String(command ?? '').trim();
      const body = cleaned.replace(/^\//, '');
      const [name = '', ...rest] = body.split(/\s+/);
      const arg = rest.join(' ');
      const scope = profile ? { profile } : {};
      try {
        const result = await live.rpc<Record<string, unknown>>('slash.exec', {
          command: cleaned,
          session_id: sessionId,
          ...scope,
        });
        return { output: commandText(result) };
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.status !== 4018) throw normalized;
        const dispatched = await live.rpc<Record<string, unknown>>('command.dispatch', {
          name,
          arg,
          session_id: sessionId,
          ...scope,
        });
        return { output: commandText(dispatched) };
      }
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
      // Nobody can hear a death that happens after the screen is gone.
      deathHandlers.clear();
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

    /**
     * 0.11.0 R7 — no WS event channel on this surface, so there is nothing to subscribe TO. It
     * resolves to a watcher that does nothing rather than throwing: the thread stays readable, which is
     * the same rule the dashboard path follows when an attach is refused.
     */
    watchSession: () => Promise.resolve({ close: () => undefined }),

    /** 0.11.0 R5 — `complete.*` is a WS method; this surface answers "no items", never an error. */
    completeSlash: () => Promise.resolve({ items: [], replaceFrom: 1 }),

    /** 0.11.0 R6 — same: the dispatch RPCs are WS-only, and the refusal is said out loud. */
    runSlashCommand() {
      return Promise.reject(
        new ApiError(t.errors.server(501, t.errors.attachUnsupported), { kind: 'http', status: 501 }),
      );
    },

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
