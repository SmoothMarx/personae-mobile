/**
 * The checkpoint watcher (0.8.0 H) — when to poll, and when to keep your hands off the battery.
 *
 * A FOREGROUND-ONLY poll, by design: ~30 s while the app is in the user's hands, stopped the moment
 * `AppState` leaves `active`, and one immediate pass on resume so the user never waits 30 s to hear
 * about something that happened while they were away. No polling while backgrounded — that is what
 * drains a battery and gets an app killed by the OS.
 *
 * The poll itself is INJECTED: this module owns the timing, the single-flight rule and the
 * foreground gate, and knows nothing about HTTP, React or notifications. That is what lets the
 * "two ticks never overlap", "nothing polls in the background" and "resume polls at once" rules be
 * tested without a device or a fake clock: the scheduler is injected too.
 */

export type CancelSchedule = () => void;

export type CheckpointWatcher = {
  /** Begin polling. Idempotent. */
  start(): void;
  /** Stop polling and cancel the pending pass. Idempotent. */
  stop(): void;
  /** App came back to the foreground: cancel the pending pass and poll NOW, then carry on. */
  resume(): Promise<void>;
  /** One pass, honouring the foreground gate and the single-flight rule. Safe to call by hand. */
  tick(): Promise<boolean>;
  /** Is the chain running? */
  readonly running: boolean;
  /** How many passes actually fetched — the observable that proves single-flight. */
  readonly polls: number;
};

export type WatcherOptions = {
  /** One pass: fetch, detect, notify. Its duration is what single-flight protects. */
  poll: () => Promise<void>;
  /** Is the app in the foreground? Checked before every pass. */
  isForeground: () => boolean;
  intervalMs?: number;
  /** Injectable for tests; defaults to a self-rescheduling `setTimeout`. */
  schedule?: (run: () => void, ms: number) => CancelSchedule;
  /** Injectables for the tests' assertions only. */
  onSkip?: (reason: 'stopped' | 'background' | 'inflight') => void;
};

export const DEFAULT_POLL_MS = 30_000;

export function createCheckpointWatcher(options: WatcherOptions): CheckpointWatcher {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_MS;
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number): CancelSchedule => {
      const handle = setTimeout(run, ms);
      return () => clearTimeout(handle);
    });

  let running = false;
  let cancel: CancelSchedule | null = null;
  let inflight = false;
  let polls = 0;

  const arm = (): void => {
    cancel?.();
    cancel = null;
    if (!running) return;
    cancel = schedule(() => {
      void tick().catch(() => undefined);
    }, intervalMs);
  };

  async function tick(): Promise<boolean> {
    if (!running) {
      options.onSkip?.('stopped');
      return false;
    }
    if (!options.isForeground()) {
      // Deliberately NOT rescheduled here: the chain resumes on `resume()`, so a backgrounded app
      // does not keep a timer alive at all.
      options.onSkip?.('background');
      return false;
    }
    if (inflight) {
      // Single-flight: a slow pass never stacks up behind itself.
      options.onSkip?.('inflight');
      return false;
    }
    inflight = true;
    polls += 1;
    try {
      await options.poll();
      return true;
    } finally {
      inflight = false;
      arm();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      // The first pass is immediate: the roster is already loading, and a checkpoint needs a
      // baseline before it can be detected at all.
      void tick().catch(() => undefined);
    },
    stop(): void {
      running = false;
      cancel?.();
      cancel = null;
    },
    async resume(): Promise<void> {
      if (!running) return;
      await tick().catch(() => undefined);
    },
    tick,
    get running() {
      return running;
    },
    get polls() {
      return polls;
    },
  };
}
