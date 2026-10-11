/**
 * Device pairing — the client half of `personae-mobile-auth` 1.1.0 (server/personae-mobile-auth).
 *
 * The phone never types a secret. Three entry points carry the same payload:
 *   1. the in-app browser: `<base>/login?next=/pair?app=1` → sign in → the page's "Continuar" button
 *      navigates to `personae://connect?…`, which ends the auth session (expo-web-browser);
 *   2. the QR on the dashboard's /pair page (expo-camera), which encodes that same link;
 *   3. the link opened from anywhere else (Telegram, a paste) — cold start or foreground.
 * All three end in {@link redeemPairing}: `POST <base>/api/plugins/personae-mobile-auth/pair/redeem`
 * with `Authorization: Bearer <code>`. The answer is a per-device token, returned exactly once; it
 * replaces the static bearer in secure storage (settingsStore keeps `apiKey` in expo-secure-store).
 *
 * Pure: no React, no native module. `fetchImpl` is injected so the suite drives it offline.
 */

import { checkBaseUrl, type Settings } from './settings';
import { inferRole, isPrivateOverlay, normalizeRouteUrl, renumberRoutes } from './routes';

export const PAIR_PREFIX = '/api/plugins/personae-mobile-auth';
export const REDEEM_PATH = `${PAIR_PREFIX}/pair/redeem`;
export const CONNECT_LINK = 'personae://connect';

export type ConnectLink = { base: string; code: string; label: string; expires: number | null };

/** Parse a `personae://connect?base=…&code=…&label=…&expires=…` link. null = not one of ours. */
export function parseConnectLink(raw: string | null | undefined): ConnectLink | null {
  const text = String(raw ?? '').trim();
  const match = /^personae:\/\/+connect\/?\?(.*)$/i.exec(text);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const part of match[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  const base = checkBaseUrl(params.base ?? '');
  const code = (params.code ?? '').trim();
  if (!base.ok || code.length < 20 || /\s/.test(code)) return null;
  const expires = Number(params.expires);
  return {
    base: base.value,
    code,
    label: (params.label ?? '').trim() || 'Personae Mobile',
    expires: Number.isFinite(expires) && expires > 0 ? expires : null,
  };
}

export function isLinkExpired(link: ConnectLink, nowMs = Date.now()): boolean {
  return link.expires !== null && link.expires * 1000 <= nowMs;
}

/** Where the in-app browser starts: the dashboard login, landing on the pairing page. */
export function pairPageUrl(base: string, label = ''): string {
  const next = `/pair?app=1${label ? `&label=${encodeURIComponent(label)}` : ''}`;
  return `${base.replace(/\/+$/, '')}/login?next=${encodeURIComponent(next)}`;
}

export type PairingResult = { baseUrl: string; token: string; deviceId: string; label: string; createdAt: string };

export type PairingFailure =
  | 'used' // 410 code_used
  | 'expired' // 410 code_expired, or the link's own expiry already passed
  | 'unknown' // 401 — not a code this dashboard minted
  | 'rate_limited' // 429
  | 'no_pairing' // 404 — the dashboard has no pairing plugin (older server)
  | 'network'
  | 'server';

export class PairingError extends Error {
  constructor(readonly reason: PairingFailure, readonly status = 0) {
    super(`pairing failed: ${reason}${status ? ` (HTTP ${status})` : ''}`);
  }
}

/** Redeem a pairing code for a device token. Exactly-once on the server; every failure is typed. */
export async function redeemPairing(
  link: ConnectLink,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  nowMs = Date.now(),
): Promise<PairingResult> {
  if (isLinkExpired(link, nowMs)) throw new PairingError('expired');
  let response: Response;
  try {
    response = await fetchImpl(`${link.base}${REDEEM_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${link.code}`, Accept: 'application/json' },
    });
  } catch {
    throw new PairingError('network');
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (response.status === 200 && typeof body.token === 'string' && body.token) {
    return {
      // The base the PHONE used wins over what the server echoes (a proxy may rewrite Host).
      baseUrl: link.base,
      token: body.token,
      deviceId: String(body.device_id ?? ''),
      label: String(body.label ?? link.label),
      createdAt: String(body.created_at ?? ''),
    };
  }
  if (response.status === 410) throw new PairingError(body.error === 'code_expired' ? 'expired' : 'used', 410);
  if (response.status === 401) throw new PairingError('unknown', 401);
  if (response.status === 429) throw new PairingError('rate_limited', 429);
  if (response.status === 404) throw new PairingError('no_pairing', 404);
  throw new PairingError('server', response.status);
}

/** Revoke THIS device (the server lets a device token revoke itself only). */
export async function revokeSelf(
  base: string,
  token: string,
  deviceId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<boolean> {
  if (!deviceId) return false;
  try {
    const r = await fetchImpl(`${base.replace(/\/+$/, '')}${PAIR_PREFIX}/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    return r.status === 200 || r.status === 404;
  } catch {
    return false;
  }
}

// ── the connection check the wizard runs (names the surface that answered) ──────────────────────

export type ProbeVerdict =
  | { kind: 'dashboard'; version: string; authRequired: boolean; pairing: boolean }
  | { kind: 'gateway' } // hermes-gateway.service (:9222): no profiles, no sessions
  | { kind: 'refused' } // nothing listening / unreachable
  | { kind: 'tls' } // the address wants https
  | { kind: 'other'; status: number };

/**
 * Probe an address: `GET /api/health` (public on the dashboard) then `GET /api/auth/providers`.
 * A 404 on both health AND `/` is the gateway's signature (measured: :9222 answers 404 to both).
 */
export async function probeService(base: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<ProbeVerdict> {
  const root = base.replace(/\/+$/, '');
  let health: Response;
  try {
    health = await fetchImpl(`${root}/api/health`, { headers: { Accept: 'application/json' } });
  } catch (error) {
    const msg = String((error as Error)?.message ?? '');
    return /ssl|tls|https|certificate/i.test(msg) ? { kind: 'tls' } : { kind: 'refused' };
  }
  if (health.status === 404) return { kind: 'gateway' };
  if (health.status === 400 || health.status === 426) return { kind: 'tls' };
  if (!health.ok) return { kind: 'other', status: health.status };
  let info: Record<string, unknown> = {};
  try {
    info = (await health.json()) as Record<string, unknown>;
  } catch {
    return { kind: 'other', status: health.status };
  }
  if (info.ok !== true && typeof info.version !== 'string') return { kind: 'other', status: health.status };
  let pairing = false;
  try {
    const p = await fetchImpl(`${root}/api/auth/providers`, { headers: { Accept: 'application/json' } });
    const body = (await p.json()) as { providers?: { name?: string }[] };
    pairing = (body.providers ?? []).some((x) => x?.name === 'personae-mobile');
  } catch {
    pairing = false;
  }
  return { kind: 'dashboard', version: String(info.version ?? ''), authRequired: info.auth_required !== false, pairing };
}

/** The address the user most likely meant, when they pointed at the gateway port. */
export function dashboardAddressFor(base: string): string {
  return base.replace(/:9222(\/|$)/, ':9119$1');
}

/**
 * Addresses to offer in the wizard: what this phone already knows (the saved address and every
 * route), each moved onto the dashboard port, de-duplicated, saved order kept. Deliberately NOT a
 * hardcoded host list: the shipped bundle carries no tailnet/LAN address of the user's box (the 0.5.0
 * forensics check counts those and expects 0).
 */
export function candidateAddresses(known: string[]): string[] {
  const out: string[] = [];
  for (const raw of known) {
    const checked = checkBaseUrl(raw ?? '');
    if (!checked.ok) continue;
    const fixed = dashboardAddressFor(checked.value);
    if (!out.includes(fixed)) out.push(fixed);
  }
  return out;
}

/**
 * The settings a successful pairing leaves behind: the dashboard surface, the address the phone
 * used as the FIRST route (other known routes kept, behind it), and the per-device token as the
 * credential (settingsStore writes `apiKey` to secure storage only). A plain-http address on a
 * private overlay (LAN / tailnet) is marked as consented — the user just paired over it.
 */
export function settingsAfterPairing(settings: Settings, result: PairingResult): Partial<Settings> {
  const url = normalizeRouteUrl(result.baseUrl);
  const role = inferRole(url);
  const first = { role, priority: -1, url, insecure: url.startsWith('http://') && isPrivateOverlay(role) };
  const rest = settings.routes.filter((r) => normalizeRouteUrl(r.url) !== url);
  return {
    baseUrl: url,
    surface: 'dashboard',
    apiKey: result.token,
    deviceId: result.deviceId,
    deviceLabel: result.label,
    routes: renumberRoutes([first, ...rest]),
    healNote: '',
  };
}
