/**
 * Session checkpoints (0.8.0 H) — the operator's ask, in his own words: warn the user when a session
 * "has reached a checkpoint (either done, or waiting on user interaction)".
 *
 * WHAT THIS IS: **device-side local notifications**, not push. They fire while the app is running
 * (foreground, or shortly after backgrounding) because the only thing that knows about a checkpoint
 * is the phone's own poll of the dashboard. True closed-app push needs an FCM project, credentials
 * and a sender on the gateway; that is 0.9.0's business, and nothing in this app calls this "push".
 *
 * Everything the feature DECIDES is here, as a pure function of two snapshots — so "waiting fires,
 * a hidden type never fires, the thread you are reading never fires, and the same transition does
 * not fire twice" are assertions rather than hopes. The clock, the transport and the notification
 * API are all injected by the caller.
 *
 * MEASURED ON THE LIVE BOX (2026-10-12, the authorised probe this phase asks for first):
 *   `is_active`   PRESENT on every one of the 74 recents rows (2 true, 72 false)  → "finished" is
 *                 knowable exactly, by the true→false transition;
 *   `waiting`     ABSENT on all 74 rows, `needs_input` ABSENT on all 74 rows      → a "waiting"
 *                 checkpoint CANNOT be observed on this surface today.
 * So the surface's own capability is reported rather than assumed (`surfaceCapability`), the
 * "waiting" kind is implemented and tested with synthetic rows, and Settings shows it disabled with
 * that reason while the dashboard serves no such field. Nothing is claimed that cannot be seen.
 */

import { isWaiting } from './lights';
import { t } from '../i18n';
import { sessionVisible } from './rosterFeed';
import type { SessionTypes } from '../settings';

export type CheckpointKind = 'waiting' | 'finished';

/** The subset of a session row these rules read. Extra fields are ignored. */
export type CheckpointSession = {
  id: string;
  profile?: string | null;
  title?: string | null;
  source?: string | null;
  is_active?: boolean | null;
  waiting?: boolean | null;
  needs_input?: boolean | null;
  needsInput?: boolean | null;
  last_active?: number | null;
  started_at?: number | null;
  last_read_at?: number | null;
};

export type CheckpointSnapshot = Record<string, CheckpointSession>;

export type CheckpointEvent = {
  kind: CheckpointKind;
  sessionId: string;
  profile: string;
  title: string;
  lastActive: number | null;
  /** The dedupe watermark key: `(sessionId, kind, last_active)`. */
  key: string;
  /**
   * Which rule fired. `'is_active'` is the exact transition (a turn that was running and is not);
   * `'activity'` is the honest fallback used when the surface serves no `is_active` at all, and it
   * means "there is new activity", never "it finished".
   */
  basis: 'is_active' | 'activity';
};

/** A surface can only report what it actually serves. */
export type SurfaceCapability = {
  waiting: boolean;
  finished: boolean;
  basis: 'is_active' | 'activity';
};

/** The dedupe map: event key -> when it was notified. Persisted by the caller. */
export type Watermark = Record<string, number>;

/** How long a watermark entry is worth keeping, and how many of them. */
export const WATERMARK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WATERMARK_MAX_ENTRIES = 200;

/** Epoch seconds (the dashboard) or ms — either way, ms. */
export function activityMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value > 10_000_000_000 ? value : Math.round(value * 1000);
}

/** The dedupe key. `last_active` is part of it, so a LATER checkpoint on the same session notifies. */
export function checkpointKey(sessionId: string, kind: CheckpointKind, lastActive: number | null | undefined): string {
  return `${sessionId}\u0000${kind}\u0000${activityMs(lastActive) ?? 'unknown'}`;
}

/** Index rows by id. A later row for the same id wins (the slices are newest-first). */
export function snapshotOf(sessions: CheckpointSession[]): CheckpointSnapshot {
  const out: CheckpointSnapshot = {};
  for (const session of sessions ?? []) {
    const id = String(session?.id ?? '');
    if (!id) continue;
    out[id] = session;
  }
  return out;
}

/**
 * What THIS surface can actually tell us, measured from its own rows rather than assumed from the
 * docs. `waiting` is true only when a row carries the field at all (even `false` is information);
 * `finished` is true when `is_active` is served, which is what makes the exact rule possible.
 */
export function surfaceCapability(sessions: CheckpointSession[]): SurfaceCapability {
  const rows = (sessions ?? []).filter(Boolean);
  const has = (field: keyof CheckpointSession) => rows.some((row) => field in (row as Record<string, unknown>));
  const finished = has('is_active');
  return {
    waiting: has('waiting') || has('needs_input') || has('needsInput'),
    finished,
    basis: finished ? 'is_active' : 'activity',
  };
}

/** The capability of a snapshot's own rows, for a caller that only kept the snapshot. */
export function capabilityOfSnapshot(snapshot: CheckpointSnapshot): SurfaceCapability {
  return surfaceCapability(Object.values(snapshot));
}

export type DetectInput = {
  /** The previous poll. `null` on the first one: nothing to compare, so nothing fires. */
  previous: CheckpointSnapshot | null;
  current: CheckpointSnapshot;
  /** The user's two per-kind switches. */
  kinds: { waiting: boolean; finished: boolean };
  /** Phase D's filter. A session type the user hid NEVER notifies — one source of truth. */
  types?: SessionTypes | null;
  /** The thread on screen right now: never notify about what the user is already looking at. */
  openThreadId?: string | null;
  /** Already-notified keys, so the same checkpoint fires once. */
  seen?: Watermark;
  /** What the surface can report (from the PREVIOUS rows, which is where the fields were seen). */
  capability?: SurfaceCapability;
  now?: number;
};

function profileOf(session: CheckpointSession): string {
  const name = String(session?.profile ?? '').trim();
  return name || 'default';
}

function titleOf(session: CheckpointSession): string {
  const title = String(session?.title ?? '').trim();
  return title || String(session?.id ?? '');
}

/**
 * previous + current → the events worth showing. In order: a session is only ever considered once,
 * and the ORDER is deterministic so a test can pin it.
 */
export function detectCheckpoints(input: DetectInput): CheckpointEvent[] {
  const { previous, current } = input;
  if (!previous) return [];
  const capability = input.capability ?? capabilityOfSnapshot(current);
  const seen = input.seen ?? {};
  const types = input.types ?? null;
  const openThread = String(input.openThreadId ?? '');
  const events: CheckpointEvent[] = [];

  const ids = Object.keys(current).sort();
  for (const id of ids) {
    const session = current[id];
    const before = previous[id];
    // 0.8.0 D: a hidden type never notifies.
    if (!sessionVisible(session as never, types)) continue;
    // The user is looking at that thread: no notification about it.
    if (openThread && id === openThread) continue;

    /**
     * ONE notification per session per pass: a session that asked a question has not also "finished"
     * for the user's purposes, and two notices about the same row in the same second would be noise.
     */
    let notified = false;

    if (input.kinds.waiting && capability.waiting) {
      const nowWaiting = isWaiting(session);
      const wasWaiting = isWaiting(before ?? null);
      if (nowWaiting && !wasWaiting) {
        const key = checkpointKey(id, 'waiting', session.last_active);
        if (!(key in seen)) {
          notified = true;
          events.push({
            kind: 'waiting',
            sessionId: id,
            profile: profileOf(session),
            title: titleOf(session),
            lastActive: activityMs(session.last_active ?? session.started_at),
            key,
            basis: 'is_active',
          });
        }
      }
    }

    if (!notified && input.kinds.finished && before) {
      const nowMs = activityMs(session.last_active ?? session.started_at);
      const beforeMs = activityMs(before.last_active ?? before.started_at);
      const advanced = nowMs !== null && beforeMs !== null && nowMs > beforeMs;
      if (capability.basis === 'is_active') {
        // The exact rule: it was running, it is not, and the activity moved on.
        if (before.is_active === true && session.is_active === false && advanced) {
          const key = checkpointKey(id, 'finished', session.last_active);
          if (!(key in seen)) {
            events.push({
              kind: 'finished',
              sessionId: id,
              profile: profileOf(session),
              title: titleOf(session),
              lastActive: nowMs,
              key,
              basis: 'is_active',
            });
          }
        }
      } else if (advanced) {
        // The honest fallback: this surface cannot tell "finished" from "still going".
        const key = checkpointKey(id, 'finished', session.last_active);
        if (!(key in seen)) {
          events.push({
            kind: 'finished',
            sessionId: id,
            profile: profileOf(session),
            title: titleOf(session),
            lastActive: nowMs,
            key,
            basis: 'activity',
          });
        }
      }
    }
  }
  return events;
}

/** Record what was notified, and keep the map small: old entries first, then the cap. */
export function markNotified(watermark: Watermark, events: CheckpointEvent[], now = Date.now()): Watermark {
  const next: Watermark = { ...watermark };
  for (const event of events) next[event.key] = now;
  return pruneWatermark(next, now);
}

export function pruneWatermark(watermark: Watermark, now = Date.now(), maxAgeMs = WATERMARK_MAX_AGE_MS): Watermark {
  const fresh = Object.entries(watermark)
    .filter(([, at]) => typeof at === 'number' && now - at <= maxAgeMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, WATERMARK_MAX_ENTRIES);
  return Object.fromEntries(fresh);
}

/** Was this exact checkpoint already notified? */
export function alreadyNotified(watermark: Watermark, event: CheckpointEvent): boolean {
  return event.key in watermark;
}

// ──────────────────────────────────────────── what the notification says ──

export type NotificationContent = {
  title: string;
  body: string;
  /** Everything the tap needs to open the right session. */
  data: { sessionId: string; profile: string; kind: CheckpointKind };
};

/**
 * Copy for one event. The wording distinguishes the two kinds honestly, and says nothing about
 * "push": this is a notification from the app on this phone.
 */
export function notificationFor(event: CheckpointEvent): NotificationContent {
  const name = event.title || event.sessionId;
  const body =
    event.kind === 'waiting'
      ? t.notify.waitingBody(name)
      : event.basis === 'activity'
        ? t.notify.activityBody(name)
        : t.notify.finishedBody(name);
  return {
    title: event.kind === 'waiting' ? t.notify.waitingTitle : t.notify.finishedTitle,
    body,
    data: { sessionId: event.sessionId, profile: event.profile, kind: event.kind },
  };
}

// ───────────────────────────────────────────────── permission, as three states ──

export type PermissionState = 'granted' | 'denied' | 'not-asked';

/**
 * Android's permission object, reduced to the three things the Settings row says out loud.
 * `canAskAgain: false` with no grant is the one state a "request" button cannot fix, which is why
 * it is its own case rather than a generic "denied".
 */
export function permissionStateOf(status: {
  granted?: boolean | null;
  status?: string | null;
  canAskAgain?: boolean | null;
} | null | undefined): PermissionState {
  if (!status) return 'not-asked';
  if (status.granted === true || status.status === 'granted') return 'granted';
  if (status.status === 'undetermined' || status.status === 'notDetermined' || status.canAskAgain === true) {
    return 'not-asked';
  }
  return 'denied';
}

/** The sentence Settings shows for that state. */
export function permissionLabel(state: PermissionState): string {
  if (state === 'granted') return t.notify.granted;
  if (state === 'denied') return t.notify.denied;
  return t.notify.notAsked;
}

/** Every switch off: no polling, no notifications, nothing to ask permission for. */
export function notificationsWanted(settings: { enabled: boolean; waiting: boolean; finished: boolean }): boolean {
  return settings.enabled && (settings.waiting || settings.finished);
}
