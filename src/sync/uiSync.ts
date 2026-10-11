/**
 * Options sync, client half — the phone's side of `GET/PUT /api/plugins/messenger/state`
 * (server/messenger/dashboard/ui_state.py is the contract of record).
 *
 * Which keys the PHONE syncs, and why only these:
 *   sections-v1        ⇄ prefs.sections          (same shape as the desktop pane: groups, members,
 *                                                  collapsed, manual order, sort — "sort + groups")
 *   session-colors-v1  ⇄ prefs.colours.sessions  (same shape: {profile: {sessionId: colour}})
 * The other shared keys (session-sort/order/groups, hidden, apropos) describe desktop-pane features
 * the phone does not render; the phone never writes them, so it can never clobber them. Device-local
 * state (expanded rows, search, labels) never leaves the phone.
 *
 * Rules (same as the desktop writer in plugin.js):
 *  - local write is immediate; the push is DEBOUNCED (1.5 s idle) and carries a Lamport rev:
 *    rev = max(server rev seen, own last rev) + 1, persisted before the request;
 *  - a removed top-level entry is sent as a tombstone (the server keeps absent entries);
 *  - seed-then-authoritative: first contact per key — server empty → push local (seed); server has a
 *    value → ADOPT it (never overwrite a server value with a stale local one);
 *  - offline / 5xx → keep the queue, retry with backoff (2 s … 60 s); 404 → older plugin: sync off
 *    for this session, silently local-only; 400/413 → drop that batch (it would fail forever).
 * Pure + injected (remote, meta store, timers), so tests/run.ts drives it with fakes.
 */

export const SYNC_KEYS = ['sections-v1', 'session-colors-v1'] as const;
export type SyncKey = (typeof SYNC_KEYS)[number];
export type Obj = Record<string, unknown>;

export type StateView = { version?: number; keys?: Record<string, { value?: Obj; rev?: number; updated_at?: string }> };
export type PutBody = { keys: Record<string, { value: Obj; rev: number }>; tombstones: { key: string; entry: string; rev: number }[] };

/** `null` = the route does not exist (404). A thrown error with `.status` 400/413 = bad batch. */
export type Remote = { get(): Promise<StateView | null>; put(body: PutBody): Promise<StateView | null> };

export type SyncMeta = { revs: Partial<Record<SyncKey, number>>; serverRevs: Partial<Record<SyncKey, number>>; seeded: Partial<Record<SyncKey, true>>; pushed: Partial<Record<SyncKey, Obj>>; dirty: Partial<Record<SyncKey, Obj>> };

export const EMPTY_META: SyncMeta = { revs: {}, serverRevs: {}, seeded: {}, pushed: {}, dirty: {} };

export type SyncDeps = {
  remote: Remote;
  loadMeta(): Promise<SyncMeta | null>;
  saveMeta(meta: SyncMeta): Promise<void>;
  /** Called when the server's value should replace the local one. */
  onRemote(key: SyncKey, value: Obj): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  debounceMs?: number;
};

export type SyncStatus = 'idle' | 'unsupported' | 'offline' | 'synced';

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isEmpty = (v: Obj | undefined) => !v || Object.values(v).every((x) => x == null || (Array.isArray(x) ? !x.length : isObj(x) ? !Object.keys(x).length : false));

export function nextRev(meta: SyncMeta, key: SyncKey): number {
  return Math.max(meta.revs[key] ?? 0, meta.serverRevs[key] ?? 0) + 1;
}

/** The PUT for the dirty keys (also bumps + records the revs). Exported for the tests. */
export function buildPut(meta: SyncMeta): PutBody | null {
  const body: PutBody = { keys: {}, tombstones: [] };
  for (const key of SYNC_KEYS) {
    const value = meta.dirty[key];
    if (!value) continue;
    const rev = nextRev(meta, key);
    meta.revs[key] = rev;
    body.keys[key] = { value, rev };
    for (const entry of Object.keys(meta.pushed[key] ?? {})) {
      if (!(entry in value)) body.tombstones.push({ key, entry, rev });
    }
  }
  return Object.keys(body.keys).length ? body : null;
}

export function createUiSync(deps: SyncDeps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const debounceMs = deps.debounceMs ?? 1500;
  let meta: SyncMeta = structuredCloneish(EMPTY_META);
  let status: SyncStatus = 'idle';
  let timer: unknown = null;
  let backoff = 0;
  let inFlight = false;
  let started = false;

  function structuredCloneish<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }

  function schedule(ms: number) {
    if (status === 'unsupported') return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, ms);
  }

  /** Adopt the server's value for keys we are not editing; remember its rev either way. */
  function absorb(view: StateView | null, sent?: PutBody) {
    for (const key of SYNC_KEYS) {
      const slot = view?.keys?.[key];
      if (!slot || !isObj(slot.value)) continue;
      meta.serverRevs[key] = Math.max(meta.serverRevs[key] ?? 0, Number(slot.rev ?? 0));
      if (meta.dirty[key]) continue; // a local edit is pending: it will win by rev
      const known = meta.pushed[key];
      meta.pushed[key] = slot.value;
      const sentValue = sent?.keys[key]?.value;
      if (!same(slot.value, sentValue ?? known)) deps.onRemote(key, slot.value);
    }
  }

  async function start(local: Partial<Record<SyncKey, Obj>>): Promise<SyncStatus> {
    started = true;
    meta = { ...structuredCloneish(EMPTY_META), ...((await deps.loadMeta().catch(() => null)) ?? {}) };
    let view: StateView | null;
    try {
      view = await deps.remote.get();
    } catch {
      status = 'offline';
      // Seeds stay unpushed until the server can say whether it already has a value.
      if (Object.keys(meta.dirty).length) schedule(nextBackoff());
      return status;
    }
    if (view === null) {
      status = 'unsupported';
      return status;
    }
    for (const key of SYNC_KEYS) {
      if (meta.seeded[key]) continue;
      const slot = view.keys?.[key];
      const serverHas = slot && isObj(slot.value) && !isEmpty(slot.value);
      if (serverHas) {
        delete meta.dirty[key]; // never overwrite a server value with a stale local one
      } else if (local[key] && !isEmpty(local[key])) {
        meta.dirty[key] = local[key]!;
      }
      meta.seeded[key] = true;
    }
    absorb(view);
    status = 'synced';
    await deps.saveMeta(meta).catch(() => undefined);
    if (Object.keys(meta.dirty).length) schedule(0);
    return status;
  }

  /** A local change. Never throws; the push happens later. */
  function noteLocal(key: SyncKey, value: Obj) {
    if (status === 'unsupported') return;
    meta.dirty[key] = value;
    void deps.saveMeta(meta).catch(() => undefined);
    if (started && status !== 'offline') schedule(debounceMs);
    else if (started) schedule(nextBackoff());
  }

  function nextBackoff() {
    backoff = Math.min(backoff ? backoff * 2 : 2000, 60_000);
    return backoff;
  }

  async function flush(): Promise<void> {
    if (inFlight || status === 'unsupported') return;
    if (status === 'offline' || !meta.seeded[SYNC_KEYS[0]]) {
      // We never reached the server: do the seeding handshake first.
      const before = { ...meta.dirty };
      const s = await start(before);
      if (s !== 'synced') return;
    }
    const body = buildPut(meta);
    if (!body) return;
    inFlight = true;
    const sentDirty = { ...meta.dirty };
    await deps.saveMeta(meta).catch(() => undefined);
    try {
      const view = await deps.remote.put(body);
      if (view === null) {
        status = 'unsupported';
        return;
      }
      for (const key of SYNC_KEYS) if (meta.dirty[key] === sentDirty[key]) delete meta.dirty[key];
      absorb(view, body);
      status = 'synced';
      backoff = 0;
    } catch (error) {
      const code = Number((error as { status?: number })?.status ?? 0);
      if (code === 400 || code === 413) {
        for (const key of SYNC_KEYS) if (meta.dirty[key] === sentDirty[key]) delete meta.dirty[key];
      } else {
        status = 'offline';
        schedule(nextBackoff());
      }
    } finally {
      inFlight = false;
      await deps.saveMeta(meta).catch(() => undefined);
    }
  }

  return {
    start,
    noteLocal,
    flush,
    /** Reconnect / foreground: retry now. */
    online() {
      if (status !== 'unsupported') {
        backoff = 0;
        schedule(0);
      }
    },
    status: () => status,
    meta: () => meta,
    dispose() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

export type UiSync = ReturnType<typeof createUiSync>;

/** The real remote: the dashboard with the app's credential. 404 → null (older plugin). */
export function httpRemote(baseUrl: string, token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Remote {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/plugins/messenger/state`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  async function call(init: RequestInit): Promise<StateView | null> {
    const r = await fetchImpl(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (r.status === 404) return null;
    if (!r.ok) throw Object.assign(new Error(`state ${r.status}`), { status: r.status });
    return (await r.json()) as StateView;
  }
  return {
    get: () => call({ method: 'GET' }),
    put: (body) => call({ method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  };
}
