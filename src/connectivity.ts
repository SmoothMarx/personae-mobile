/**
 * The connect engine: which route, and is it actually ready?
 *
 * This is the part that makes a phone work on 5G. Walking out of the house kills the LAN route and
 * the cellular network raises a tunnel instead; the same gateway is now behind a different address.
 * One stored URL cannot survive that, and "the network changed" is not a signal we can act on until
 * we have re-probed and re-chosen. So: probe the candidates in strict priority order, use the
 * highest-priority one that answers, and redo the whole thing whenever the network changes.
 *
 * Two rules the brief is explicit about, and that the code below encodes:
 *
 *  1. **Readiness is proven, never assumed.** The trigger that raises the tunnel is fire-and-forget
 *     (`result=0` whether it connected or posted a "please open Tailscale" notification), and
 *     `TRANSPORT_VPN` on the active network is true even when a *competing* VPN owns the tunnel. The
 *     only trustworthy answer is a probe that actually reaches the target. See `probeRoute`.
 *
 *  2. **Reachability never promotes a lower priority over a higher one.** A priority-10 route being
 *     reachable does not let it outrank a priority-0 route; priority groups are consumed in order and
 *     a lower group is only consulted once every higher group has failed. That is failover, and
 *     `src/routes.ts::pickByPriority` is where it lives.
 *
 * Everything here is pure with respect to the outside world: the clock, the sleep, the randomness
 * and the probe itself are all injected, so the whole policy is unit-testable without a device.
 */

import { classifyStatus, nextDelayMs, shouldRetry, type FailureClass } from './api/failures';
import { checkRoute, hostOf, orderRoutes, portOf, selectRoute, type RouteCandidate, type RouteDecision } from './routes';

export type ProbeOk = { ok: true; ms: number };
export type ProbeFail = {
  ok: false;
  failure: FailureClass;
  detail?: string;
  /** From a 429 `Retry-After`; the server's own period wins over our backoff. */
  retryAfterMs?: number | null;
};
export type ProbeOutcome = ProbeOk | ProbeFail;

/** probe(route, timeoutMs) -> did we actually reach it? */
export type ProbeFn = (route: RouteCandidate, timeoutMs: number) => Promise<ProbeOutcome>;

export type Attempt = {
  url: string;
  role: string;
  ok: boolean;
  at: number;
  ms: number;
  failure?: FailureClass;
  detail?: string;
  pass: number;
};

export type RouteProbeState = {
  url: string;
  ok: boolean;
  at: number;
  failure?: FailureClass;
  detail?: string;
  /** Epoch ms before which this route must not be probed again. Infinity = never again this run. */
  retryAt: number;
  attempts: number;
  /** A non-retryable failure (401/403, or a 404 that means "wrong route"). */
  dead: boolean;
};

export type ProbeCache = {
  get: (url: string) => RouteProbeState | undefined;
  isReachable: (route: RouteCandidate) => boolean;
  record: (url: string, outcome: ProbeOutcome, at: number) => RouteProbeState;
  entries: () => RouteProbeState[];
  reset: () => void;
};

export type ProbeCacheOptions = {
  random?: () => number;
  baseMs?: number;
  capMs?: number;
};

/**
 * Per-candidate probe state. Keyed by URL, so one dead candidate can never mark a healthy one
 * unreachable, and a healthy one can never hide a dead one.
 */
export function createProbeCache(options: ProbeCacheOptions = {}): ProbeCache {
  const states = new Map<string, RouteProbeState>();

  return {
    get: (url) => states.get(url),

    isReachable: (route) => {
      const state = states.get(route.url);
      return state !== undefined && state.ok;
    },

    record: (url, outcome, at) => {
      const previous = states.get(url);
      const attempts = (previous?.attempts ?? 0) + 1;
      if (outcome.ok) {
        const state: RouteProbeState = { url, ok: true, at, attempts, retryAt: 0, dead: false };
        states.set(url, state);
        return state;
      }
      const retryable = shouldRetry(outcome.failure);
      const delay = retryable
        ? nextDelayMs(outcome.failure, attempts - 1, {
            random: options.random,
            baseMs: options.baseMs,
            capMs: options.capMs,
            retryAfterMs: outcome.retryAfterMs ?? null,
          })
        : null;
      const state: RouteProbeState = {
        url,
        ok: false,
        at,
        failure: outcome.failure,
        detail: outcome.detail,
        retryAt: delay === null ? Number.POSITIVE_INFINITY : at + delay,
        attempts,
        dead: delay === null,
      };
      states.set(url, state);
      return state;
    },

    entries: () => Array.from(states.values()),
    reset: () => states.clear(),
  };
}

export type ConnectReason =
  | 'selected'
  | 'pin-bypassed'
  | 'no-routes'
  | 'none-reachable'
  | 'permanent'
  | 'backgrounded'
  | 'deadline';

export type ConnectResult = {
  route: RouteCandidate | null;
  reason: ConnectReason;
  decision: RouteDecision;
  attempts: Attempt[];
  cache: ProbeCache;
  /** Set only for a 401/403-class failure: the credential is wrong, stop and say so. */
  permanent?: { failure: FailureClass; detail?: string };
  elapsedMs: number;
  passes: number;
};

export type ConnectOptions = {
  routes: RouteCandidate[];
  insecureAck: boolean;
  preferredRole?: string | null;
  probeTimeoutMs: number;
  deadlineMs: number;
  probe: ProbeFn;
  cache?: ProbeCache;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Polling must stop the moment the app leaves the foreground. */
  isForeground?: () => boolean;
  onAttempt?: (attempt: Attempt) => void;
  baseMs?: number;
  capMs?: number;
};

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Probe the candidates until one is reachable, the deadline passes, the credential is rejected, or
 * the app goes to the background.
 *
 * The loop probes in priority order and, when no candidate answers at all, waits a jittered
 * exponential backoff before the next pass — never a tight spin, and never a retry of a
 * non-retryable failure.
 */
export async function connectThrough(options: ConnectOptions): Promise<ConnectResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const isForeground = options.isForeground ?? (() => true);
  const cache = options.cache ?? createProbeCache({ random, baseMs: options.baseMs, capMs: options.capMs });
  const deadlineMs = Math.max(0, options.deadlineMs);
  const startedAt = now();
  const deadline = startedAt + deadlineMs;
  const attempts: Attempt[] = [];

  const ordered = orderRoutes(options.routes);
  const usable = ordered.filter((route) => checkRoute(route, { insecureAck: options.insecureAck }).ok);
  const decision = (): RouteDecision =>
    selectRoute(options.routes, cache.isReachable, {
      insecureAck: options.insecureAck,
      preferredRole: options.preferredRole,
    });

  const finish = (reason: ConnectReason, route: RouteCandidate | null, permanent?: ConnectResult['permanent']): ConnectResult => ({
    route,
    reason,
    decision: decision(),
    attempts,
    cache,
    permanent,
    elapsedMs: now() - startedAt,
    passes,
  });

  let passes = 0;
  let last: RouteDecision = decision();

  if (!usable.length) {
    return { ...finish('no-routes', null), decision: last };
  }

  for (;;) {
    if (!isForeground()) {
      last = decision();
      return { ...finish('backgrounded', null), decision: last };
    }
    passes += 1;

    for (const route of usable) {
      const check = checkRoute(route, { insecureAck: options.insecureAck });
      if (!check.ok) continue;
      const state = cache.get(check.url);
      const startedProbe = now();
      // Respect this route's own backoff, and never re-probe one that is dead for this run.
      if (state && (state.dead || state.retryAt > startedProbe)) continue;

      let outcome: ProbeOutcome;
      try {
        outcome = await options.probe({ ...route, url: check.url }, options.probeTimeoutMs);
      } catch (error) {
        outcome = { ok: false, failure: 'transient', detail: (error as Error)?.message };
      }
      const at = now();
      const attempt: Attempt = {
        url: check.url,
        role: route.role,
        ok: outcome.ok,
        at,
        ms: outcome.ok ? outcome.ms : Math.max(0, at - startedProbe),
        failure: outcome.ok ? undefined : outcome.failure,
        detail: outcome.ok ? undefined : outcome.detail,
        pass: passes,
      };
      attempts.push(attempt);
      cache.record(check.url, outcome, at);
      options.onAttempt?.(attempt);

      if (!outcome.ok && outcome.failure === 'permanent') {
        // 401/403: the credential is wrong for the whole server, so stop rather than keep knocking.
        last = decision();
        return {
          ...finish('permanent', null, { failure: outcome.failure, detail: outcome.detail }),
          decision: last,
        };
      }
    }

    last = decision();
    if (last.route) {
      return { ...finish(last.reason === 'pin-bypassed' ? 'pin-bypassed' : 'selected', last.route), decision: last };
    }
    if (!isForeground()) return { ...finish('backgrounded', null), decision: last };
    if (now() >= deadline) return { ...finish('deadline', null), decision: last };

    // Nothing answered this pass: wait before trying again, and never overrun the deadline.
    const delay = nextDelayMs('transient', passes - 1, {
      random,
      baseMs: options.baseMs,
      capMs: options.capMs,
    }) ?? 0;
    const remaining = deadline - now();
    if (remaining <= 0) return { ...finish('deadline', null), decision: last };
    await sleep(Math.min(delay, remaining));
  }
}

// ───────────────────────────────────────────────────────────── the real probe ──

export type ProbeDeps = {
  /** Native TCP connect. Returns false when no socket primitive is available (iOS, tests). */
  tcp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** Unauthenticated GET of the gateway's health route. */
  health: (url: string, timeoutMs: number) => Promise<{ status: number; ok: boolean; retryAfterMs?: number | null } | null>;
};

/**
 * The production probe: a TCP connect first, then the gateway's health route.
 *
 * Stage 1 (TCP) answers "is anything listening at that address through this network", which is
 * exactly what a tunnel coming up changes. Stage 2 (health) answers "and is it the gateway we think
 * it is" — a 404 there means the URL does not point at the expected route, which is a *route*
 * problem and must not be retried.
 *
 * Honesty note carried into the UI: the health route answering proves the route reaches the
 * gateway. It does NOT prove the route can serve a chat turn. Those are reported separately.
 */
export function probeRoute(deps: ProbeDeps): ProbeFn {
  return async (route, timeoutMs) => {
    const started = Date.now();
    const host = hostOf(route.url);
    const port = portOf(route.url);
    if (!host || port === null) {
      return { ok: false, failure: 'route', detail: 'endereço sem host ou porta' };
    }
    const open = await deps.tcp(host, port, timeoutMs);
    if (!open) {
      return {
        ok: false,
        failure: 'transient',
        detail: `${host}:${port} não respondeu em ${timeoutMs} ms`,
      };
    }
    const health = await deps.health(route.url, timeoutMs);
    if (health === null) {
      return { ok: false, failure: 'transient', detail: 'a ligação abriu mas não houve resposta' };
    }
    if (!health.ok) {
      return {
        ok: false,
        failure: classifyStatus(health.status),
        detail: `HTTP ${health.status}`,
        retryAfterMs: health.retryAfterMs ?? null,
      };
    }
    return { ok: true, ms: Date.now() - started };
  };
}
