/**
 * `GET /api/status` — the one public call the Connection status panel makes (0.10.0 S1).
 *
 * Why this route and not `/api/health`: `/api/health` answers "is anything there and does it want a
 * token" (`auth_required`), while `/api/status` answers what the panel actually shows — the gateway's
 * own **version** and its **gateway_state**. Both are public by design, so neither needs the app's
 * credential; the authenticated call is the THIRD stage of the wizard's test (S3.3), not this read.
 *
 * Pure and injected on purpose: the suite drives it with a fake `fetch`, so nothing in `tests/` opens
 * a socket (brief §1.12), and the screen's timeout comes from the user's own `probeTimeoutMs` — the
 * same budget the probes use.
 */

import { normalizeRouteUrl } from '../routes';

export const STATUS_PATH = '/api/status';

/** What the panel shows for one address. `null` = nothing answered, or an unknown shape. */
export type GatewayStatus = { version: string; gatewayState: string };

export function statusUrl(baseUrl: string): string {
  return `${normalizeRouteUrl(baseUrl)}${STATUS_PATH}`;
}

/**
 * Read the two fields the panel needs, and NOTHING else.
 *
 * A body that is not an object, or that carries neither field, is `null` — never a fabricated
 * version. `gateway_state` missing is not an error (an older gateway may not send it): the version
 * alone is still a real answer, and the panel says "not known yet" for the other half.
 */
export function parseGatewayStatus(body: unknown): GatewayStatus | null {
  if (!body || typeof body !== 'object') return null;
  const row = body as Record<string, unknown>;
  const version = typeof row.version === 'string' ? row.version.trim() : '';
  const state = typeof row.gateway_state === 'string' ? row.gateway_state.trim() : '';
  if (!version && !state) return null;
  return { version, gatewayState: state };
}

export type StatusReadDeps = {
  /** Injected in tests; the screen passes the shared XHR transport. */
  fetchImpl?: typeof fetch;
  timeoutMs: number;
};

/**
 * One timed GET. Every failure — a network error, a non-200, a timeout, junk — is `null`, because the
 * panel's job is to say exactly what is known and the caller already renders "not known yet".
 */
export async function readGatewayStatus(baseUrl: string, deps: StatusReadDeps): Promise<GatewayStatus | null> {
  const url = statusUrl(baseUrl);
  if (!url.startsWith('http')) return null;
  const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(100, deps.timeoutMs)) : null;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return null;
    return parseGatewayStatus(await response.json());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
