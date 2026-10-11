/**
 * Failure taxonomy and retry discipline (§D of the brief).
 *
 * On 5G "unreachable" is not one thing: it is CGNAT, an IP change, radio sleep, doze, a dead
 * route and a wrong API key, and each has a different fix and different words on screen. This
 * module is the single place that decides which of those a failure is, and therefore whether the
 * app waits, retries, gives up, or stops and tells the user to fix something.
 *
 * The rule that matters most: **401/403 is permanent. It is never retried.** Hammering a gateway
 * with a rejected key produces account lockouts and hides the real problem behind a spinner.
 *
 *   | Condition                        | Class     | Behaviour                                    |
 *   |----------------------------------|-----------|----------------------------------------------|
 *   | 401 / 403                        | permanent | stop, name the credential, NEVER retry       |
 *   | 429                              | backoff   | wait the server's own period (Retry-After)   |
 *   | 5xx                              | server    | retry with backoff, surface as server-side   |
 *   | 404                              | route     | the URL is not the expected route; no retry  |
 *   | connect timeout / DNS / unreach  | transient | retry, capped exponential backoff + jitter   |
 */

import { ApiError, isApiError } from './errors';

export type FailureClass = 'permanent' | 'backoff' | 'server' | 'route' | 'transient';

/** Short machine label used by the diagnostics panel (`lastErrorKind`). */
export const FAILURE_LABEL: Record<FailureClass, string> = {
  permanent: 'permanent',
  backoff: 'backoff',
  server: 'server',
  route: 'route',
  transient: 'transient',
};

export function classifyStatus(status: number): FailureClass {
  if (status === 401 || status === 403) return 'permanent';
  if (status === 429) return 'backoff';
  if (status === 404) return 'route';
  // A redirect means this address serves something else (a login page, another service) — that is a
  // wrong-route problem, and it must fall through to the next candidate rather than aborting the
  // whole connect the way a rejected credential does.
  if (status >= 300 && status < 400) return 'route';
  if (status === 408) return 'transient';
  if (status >= 500) return 'server';
  // Any other 4xx is a client-side mistake: the same request will keep failing identically, so it
  // is permanent rather than something to retry.
  return 'permanent';
}

/** Classify an ApiError (or any thrown value) into one of the five classes. */
export function classifyApiError(error: unknown): FailureClass {
  if (isApiError(error)) {
    if (error.kind === 'timeout') return 'transient';
    if (error.kind === 'network') return 'transient';
    if (error.kind === 'config') return 'permanent';
    if (error.kind === 'parse') return 'server';
    if (error.kind === 'stream') return 'transient';
    if (typeof error.status === 'number') return classifyStatus(error.status);
    return 'transient';
  }
  return 'transient';
}

/** Only these ever get another attempt. Permanent and route failures never do. */
export function shouldRetry(cls: FailureClass): boolean {
  return cls === 'backoff' || cls === 'server' || cls === 'transient';
}

export type BackoffOptions = {
  baseMs?: number;
  capMs?: number;
  /** Injected for deterministic tests; 0..1. */
  random?: () => number;
};

export const DEFAULT_BACKOFF = { baseMs: 500, capMs: 15_000 };

/**
 * Capped exponential backoff with equal jitter.
 *
 * `raw = min(cap, base * 2^attempt)`; the returned delay is uniformly distributed in
 * `[raw/2, raw]`. Jitter matters on cellular: without it, every wake-up after a doze retries in
 * lockstep and a sleeping radio gets a burst of simultaneous connects instead of one.
 * The result is always <= cap, whatever the attempt number or the jitter source.
 */
export function retryDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const cap = options.capMs ?? DEFAULT_BACKOFF.capMs;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, Math.trunc(attempt));
  // 2 ** exponent overflows to Infinity for large attempts; min() then clamps it to the cap.
  const raw = Math.min(cap, base * 2 ** exponent);
  const half = raw / 2;
  const jittered = half + random() * half;
  return Math.max(0, Math.min(cap, Math.round(jittered)));
}

/**
 * `Retry-After` on a 429 is the server's own timing instruction, so it wins over our backoff:
 * "wait the server's period; do not hammer". Accepts both forms the RFC allows — delta-seconds and
 * an HTTP-date — and returns milliseconds, or null when the header is absent/unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

/**
 * Delay before the next attempt, on a probe or a request that just failed.
 * Policy order: permanent/route -> no retry at all; 429 -> the server's period; else backoff.
 */
export function nextDelayMs(
  cls: FailureClass,
  attempt: number,
  options: BackoffOptions & { retryAfterMs?: number | null } = {},
): number | null {
  if (!shouldRetry(cls)) return null;
  if (cls === 'backoff' && typeof options.retryAfterMs === 'number' && options.retryAfterMs >= 0) {
    return Math.min(options.retryAfterMs, options.capMs ?? DEFAULT_BACKOFF.capMs);
  }
  return retryDelayMs(attempt, options);
}

/**
 * Human-facing explanation for a class, in PT-PT, so the screen never says only "it didn't work".
 */
export type FailureWords = { sentence: string; permanent: boolean };

export function describeFailure(cls: FailureClass, strings: {
  permanent: string;
  backoff: string;
  server: string;
  route: string;
  transient: string;
}): FailureWords {
  return {
    sentence: strings[cls],
    permanent: !shouldRetry(cls),
  };
}

/** Last-error label for the diagnostics panel: `<class>` or `<class> · HTTP <status>`. */
export function errorKindLabel(error: unknown): string {
  const cls = classifyApiError(error);
  const status = error instanceof ApiError ? error.status : undefined;
  return status ? `${FAILURE_LABEL[cls]} · HTTP ${status}` : FAILURE_LABEL[cls];
}

export type AttemptOptions = {
  /** Total tries, including the first. Default 3. */
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseMs?: number;
  capMs?: number;
  /** Polling must never continue once the app is backgrounded. */
  isForeground?: () => boolean;
  onRetry?: (info: { cls: FailureClass; error: unknown; delayMs: number; attempt: number }) => void;
};

export type AttemptResult<T> =
  | { ok: true; value: T; tries: number; cls: null }
  | { ok: false; error: unknown; cls: FailureClass; tries: number; reason: 'permanent' | 'exhausted' | 'backgrounded' };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Run an operation under the failure policy above.
 *
 * The two behaviours that matter: a permanent failure (401/403, config errors) returns after
 * exactly ONE try — the credential is wrong and hammering it produces lockouts while hiding the
 * real problem; and a transient failure backs off with jitter between tries, up to `capMs`.
 * Backgrounded means stop, so a doze never turns into a retry storm.
 */
export async function attemptWithPolicy<T>(run: () => Promise<T>, options: AttemptOptions = {}): Promise<AttemptResult<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const isForeground = options.isForeground ?? (() => true);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!isForeground()) return { ok: false, error: null, cls: 'transient', tries: attempt, reason: 'backgrounded' };
    try {
      const value = await run();
      return { ok: true, value, tries: attempt + 1, cls: null };
    } catch (error) {
      const cls = classifyApiError(error);
      const retryAfterMs = parseRetryAfter(
        (error as { headers?: { get?: (name: string) => string | null } })?.headers?.get?.('retry-after') ?? null,
        now(),
      );
      const delay = nextDelayMs(cls, attempt, {
        random: options.random,
        baseMs: options.baseMs,
        capMs: options.capMs,
        retryAfterMs,
      });
      if (delay === null) {
        return { ok: false, error, cls, tries: attempt + 1, reason: 'permanent' };
      }
      if (attempt + 1 >= maxAttempts) {
        return { ok: false, error, cls, tries: attempt + 1, reason: 'exhausted' };
      }
      options.onRetry?.({ cls, error, delayMs: delay, attempt: attempt + 1 });
      await sleep(delay);
      if (!isForeground()) return { ok: false, error, cls, tries: attempt + 1, reason: 'backgrounded' };
    }
  }
  return { ok: false, error: null, cls: 'transient', tries: maxAttempts, reason: 'exhausted' };
}
