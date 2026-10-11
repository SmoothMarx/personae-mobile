/**
 * The tailnet peer list — the app's half (0.7.0).
 *
 * The PHONE cannot enumerate a tailnet: Android has no such API, and `src/native/tailscale.ts`
 * bridges only installed/connect/disconnect/openApp/vpnTransportActive/probeTcp. The HOST can
 * (`tailscale status --json`), so the picker reads
 * `GET /api/plugins/personae-mobile-auth/tailscale/peers` — see
 * `server/personae-mobile-auth/dashboard/plugin_api.py` for the serving half.
 *
 * Two rules keep this honest:
 *   * the endpoint's own vocabulary is ``available`` / ``reason``, and anything that does not look
 *     like the documented shape is treated as unavailable rather than guessed at;
 *   * picking a device WRITES A ROUTE through the existing `src/routes.ts` model — it does not
 *     invent a second notion of "where the server is". A duplicate is refused rather than added
 *     twice, so the picker cannot fill the list with the same address.
 */

import { inferRole, normalizeRouteUrl, type RouteCandidate } from '../routes';
import type { Settings } from '../settings';

export const PEERS_PATH = '/api/plugins/personae-mobile-auth/tailscale/peers';

/** The reasons the endpoint may report. Anything else is shown raw, never swallowed. */
export const PEERS_REASONS = ['cli_missing', 'timeout', 'cli_error', 'unparseable_output'] as const;

export type PeerRow = { name: string; ip: string; os: string; online: boolean };

export type PeersResult = {
  available: boolean;
  self?: PeerRow;
  peers: PeerRow[];
  /** Present only when `available` is false. */
  reason?: string;
};

export const PEERS_EMPTY: PeersResult = { available: false, peers: [], reason: 'unavailable' };

function asPeer(value: unknown): PeerRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const ip = String(row.ip ?? '').trim();
  const name = String(row.name ?? '').trim();
  if (!ip || !name) return null;
  return { name, ip, os: String(row.os ?? '').trim(), online: row.online === true };
}

/**
 * Coerce whatever the endpoint (or an error envelope) returned into `PeersResult`. A 401 body, an
 * unknown shape or a bare list all land on `available: false` — the app then offers manual entry
 * instead of an empty picker with no explanation.
 */
export function normalizePeers(body: unknown): PeersResult {
  if (!body || typeof body !== 'object') return { ...PEERS_EMPTY, reason: 'bad_response' };
  const value = body as Record<string, unknown>;
  if (value.available !== true) {
    const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : 'unavailable';
    return { available: false, peers: [], reason };
  }
  const self = asPeer(value.self) ?? undefined;
  const rows = Array.isArray(value.peers) ? value.peers : [];
  const peers = rows.map(asPeer).filter((row): row is PeerRow => row !== null);
  return { available: true, self, peers };
}

/** A one-line status for the section, resolved by the caller from these facts. */
export function peersState(result: PeersResult): 'ready' | 'empty' | 'unavailable' {
  if (!result.available) return 'unavailable';
  return result.peers.length ? 'ready' : 'empty';
}

/** The port the picker dials: whatever the paired address uses, else the dashboard's own 9119. */
export function peersPort(settings: Settings): number {
  try {
    const parsed = new URL(settings.baseUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 9119;
  } catch {
    return 9119;
  }
}

/**
 * The route a picked device would write: `http://<ip>:<port>`, role inferred from the address
 * (`100.x` → `tailscale`), appended below everything already in the list.
 *
 * `null` means "this address is already a route" — the picker says so instead of adding a duplicate.
 */
export function peerRoute(
  peer: PeerRow,
  options: { port: number; routes: RouteCandidate[]; insecureAck: boolean },
): RouteCandidate | null {
  const url = normalizeRouteUrl(`http://${peer.ip}:${options.port}`);
  if (!url) return null;
  const existing = options.routes.some((route) => normalizeRouteUrl(route.url) === url);
  if (existing) return null;
  const priority = options.routes.reduce((max, route) => Math.max(max, route.priority), -1) + 1;
  // Plain http by construction, so the flag says so. `checkRoute` gates on the settings-level
  // `insecureRouteAck`, which the picker turns on as part of the same action: choosing a device on
  // your own tailnet IS the consent that flag stands for.
  return { role: inferRole(url), priority, url, insecure: true };
}

/** The address a peer would be dialled at — for the label under the name in the picker. */
export function peerAddress(peer: PeerRow, port: number): string {
  return `${peer.ip}:${port}`;
}
