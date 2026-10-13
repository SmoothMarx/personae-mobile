/**
 * The status dots (0.10.0 S2).
 *
 * the user, 2026-10-13: *"A dropdown that lists all created connections … along with a status dot
 * indicating their connectivity status."*
 *
 * The rules, and they are all about NOT lying:
 *
 *   * **One probe per row, in parallel.** `probeDots` maps the rows once and awaits them together, so
 *     a list of three addresses issues three requests — not one, not three per row, and not a
 *     sequence that makes the last row wait for the first.
 *   * **`GET /api/health`, with the user's own `probeTimeoutMs`.** That route is public by design (the
 *     dashboard answers it without a token), so a dot never depends on the app's credential — and it
 *     is the same budget the connect engine uses, so "slow" means the same thing in both places.
 *   * **Three states, and `checking` is a real one.** An address whose probe is still in flight is
 *     **checking**, never **down**: the screen must not accuse a connection it has not heard from yet,
 *     which is exactly the bug a default of 'down' would produce on every page open.
 *   * **No polling.** Nothing here schedules anything: the answers are cached for the life of the
 *     screen, and the screen re-probes when the page is opened again. A dot that refreshes itself is
 *     a battery drain and a source of flicker.
 */

import { normalizeRouteUrl, type RouteCandidate } from '../routes';

/** The three states. `checking` first, because that is what every row starts as. */
export const DOT_STATES = ['checking', 'up', 'down'] as const;
export type DotState = (typeof DOT_STATES)[number];

export type DotRow = {
  /** The route's address, as `healthUrlFor` keys it. */
  url: string;
  state: DotState;
  /** The HTTP status that answered, or 0 when nothing did. Shown to nobody; kept for the timeline. */
  status: number;
};

/** The public route the dots read. Never `/api/status` (that is the panel's own read, S1). */
export const HEALTH_PATH = '/api/health';

export function healthUrlFor(baseUrl: string): string {
  return `${normalizeRouteUrl(baseUrl)}${HEALTH_PATH}`;
}

/** Every row, before anything has answered: all three states of an unasked address are `checking`. */
export function initialDots(routes: RouteCandidate[]): DotRow[] {
  return routes.map((route) => ({ url: healthUrlFor(route.url), state: 'checking', status: 0 }));
}

/** The state of one row. A row with no answer yet is CHECKING — never `down`. */
export function dotStateOf(dots: DotRow[], url: string): DotState {
  const key = healthUrlFor(url);
  return dots.find((row) => row.url === key)?.state ?? 'checking';
}

/** What one probe answers: an HTTP status, or `null` when nothing answered in time. */
export type DotProbeResult = { status: number } | null;
export type DotProbe = (healthUrl: string, timeoutMs: number) => Promise<DotProbeResult>;

/**
 * The production probe: one timed GET of the health route.
 *
 * `null` covers every way of not answering — a refused socket, a DNS failure, an aborted timeout. Any
 * HTTP status at all means something IS there, and the dot is about connectivity, not authorization:
 * a 401 from the gateway is a reachable gateway.
 */
export function createDotProbe(fetchImpl?: typeof fetch): DotProbe {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  return async (healthUrl, timeoutMs) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(100, timeoutMs)) : null;
    try {
      const response = await doFetch(healthUrl, {
        headers: { Accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      return { status: response.status };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export type ProbeDotsOptions = {
  /** The user's own `settings.probeTimeoutMs`, passed to EVERY probe unchanged. */
  timeoutMs: number;
  probe: DotProbe;
};

/**
 * Probe every row ONCE, in parallel, and answer in the routes' own order.
 *
 * The mapping happens exactly once, which is the property the suite pins: "one probe per row and no
 * more" is a fact about this function, not a hope about the screen.
 */
export async function probeDots(routes: RouteCandidate[], options: ProbeDotsOptions): Promise<DotRow[]> {
  const targets = routes.map((route) => healthUrlFor(route.url));
  const answers = await Promise.all(
    targets.map(async (url): Promise<DotRow> => {
      const result = await options.probe(url, options.timeoutMs);
      if (result === null) return { url, state: 'down', status: 0 };
      return { url, state: 'up', status: result.status };
    }),
  );
  return answers;
}
