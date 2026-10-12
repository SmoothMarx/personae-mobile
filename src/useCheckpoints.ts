/**
 * `useCheckpoints` — the app-side half of 0.8.0 H.
 *
 * It owns nothing that can be decided elsewhere: the detection rules are `src/logic/checkpoints.ts`,
 * the timing is `src/logic/watcher.ts`, and the notification API is `src/notifications.ts`. What is
 * left here is the glue the app has to do once — read `AppState`, keep the last snapshot, persist the
 * watermark, and start/stop the watcher when the user's switches change.
 *
 * The poll rides the feed call the roster already makes (ONE request per pass: the batched sidebar
 * slice), and it only runs when the master switch is on AND the permission has actually been granted.
 * Nothing here asks for a permission.
 */

import { AppState, type AppStateStatus } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  detectCheckpoints,
  markNotified,
  permissionStateOf,
  surfaceCapability,
  snapshotOf,
  type CheckpointSession,
  type CheckpointSnapshot,
  type PermissionState,
  type SurfaceCapability,
  type Watermark,
} from './logic/checkpoints';
import { createCheckpointWatcher, DEFAULT_POLL_MS, type CheckpointWatcher } from './logic/watcher';
import type { FeedSession } from './logic/rosterFeed';
import { loadWatermark, saveWatermark } from './notifyStore';
import { present, readPermission } from './notifications';
import { useSettings } from './SettingsContext';
import { useBackend } from './useBackend';

export type CheckpointsState = {
  /** The truth about the permission, as read (never requested) by this hook. */
  permission: PermissionState;
  /** What the connected surface can actually report — the "waiting" switch's honesty gate. */
  capability: SurfaceCapability;
  /** Run one pass by hand (used by the resume path, and by Settings' "check now"). */
  pollNow: () => Promise<void>;
  /** How many notifications this run has shown — for the Settings screen's evidence line. */
  shown: number;
};

export function useCheckpoints(options: { openThreadId?: string | null } = {}): CheckpointsState {
  const { settings } = useSettings();
  const { backend } = useBackend();
  const [permission, setPermission] = useState<PermissionState>('not-asked');
  const [capability, setCapability] = useState<SurfaceCapability>({ waiting: false, finished: false, basis: 'is_active' });
  const [shown, setShown] = useState(0);

  const previous = useRef<CheckpointSnapshot | null>(null);
  const watermark = useRef<Watermark>({});
  const foreground = useRef<AppStateStatus>(AppState.currentState ?? 'active');
  const openThread = useRef<string | null>(options.openThreadId ?? null);
  openThread.current = options.openThreadId ?? null;

  const notify = settings.notifications;
  const wanted = Boolean(notify?.enabled) && Boolean(notify?.waiting || notify?.finished);
  const configured = Boolean(settings.baseUrl.trim()) && Boolean(settings.apiKey);

  // AppState: the gate the watcher reads before every pass.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      foreground.current = next;
    });
    return () => subscription.remove();
  }, []);

  // The watermark survives a restart, so a relaunch does not re-announce a checkpoint.
  useEffect(() => {
    void loadWatermark().then((map) => {
      watermark.current = map;
    });
  }, []);

  // Read the permission — READ only. The request happens in Settings, on the master switch.
  useEffect(() => {
    let alive = true;
    void readPermission().then((value) => {
      if (alive) setPermission(value);
    });
    return () => {
      alive = false;
    };
  }, [wanted]);

  const poll = useCallback(async () => {
    const slices = await backend.sidebar('all', { recents: 60, cron: 20 });
    const rows = [...(slices.recents ?? []), ...(slices.cron ?? [])] as CheckpointSession[];
    const current = snapshotOf(rows);
    const before = previous.current;
    previous.current = current;

    // What this surface can report, measured from its own rows.
    const caps = surfaceCapability(rows);
    setCapability(caps);
    if (!before) return;

    const events = detectCheckpoints({
      previous: before,
      current,
      kinds: { waiting: Boolean(notify?.waiting), finished: Boolean(notify?.finished) },
      // Phase D: a session type the user hid never notifies — the same filter the list uses.
      types: settings.sessionTypes,
      openThreadId: openThread.current,
      seen: watermark.current,
      capability: caps,
    });
    if (!events.length) return;
    const sent = await present(events);
    watermark.current = markNotified(watermark.current, events);
    void saveWatermark(watermark.current);
    setShown((count) => count + sent);
  }, [backend, notify?.finished, notify?.waiting, settings.sessionTypes]);

  // The watcher itself, created once: only its `poll` needs to stay current.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const watcher = useMemo<CheckpointWatcher>(
    () =>
      createCheckpointWatcher({
        poll: () => pollRef.current(),
        isForeground: () => foreground.current === 'active',
        intervalMs: DEFAULT_POLL_MS,
      }),
    [],
  );

  // Master switch + permission decide whether anything polls at all.
  useEffect(() => {
    if (wanted && configured && permission === 'granted') {
      watcher.start();
      return () => watcher.stop();
    }
    watcher.stop();
    return undefined;
  }, [configured, permission, wanted, watcher]);

  // Coming back to the app polls at once, not 30 s later.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && wanted && configured && permission === 'granted') void watcher.resume();
    });
    return () => subscription.remove();
  }, [configured, permission, wanted, watcher]);

  return { permission, capability, pollNow: () => watcher.tick().then(() => undefined), shown };
}

/** Re-exported so the Settings screen can label the permission with the same mapping. */
export { permissionStateOf, type PermissionState, type SurfaceCapability };
