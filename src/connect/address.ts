/**
 * The wizard's two address fields, as data (0.10.0 S3.1 / S3.2).
 *
 * the user, 2026-10-13, §2 of his own words: *"All IP address fields should only allow numbers and
 * periods. The http:// prefix should be automatically appended by the app. The port number field
 * should be separated from the IP field."*
 *
 * So there are TWO fields, and this module is the rule for each:
 *
 *   * **IPv4** — digits and periods while typing, and `octets()` (from `src/routes.ts`, 4 parts each
 *     <= 255) to decide whether it is an address. That is stricter than "numbers and periods" and it
 *     is the rule the route model already uses, so a typo cannot reach the route list.
 *   * **Port** — its own field, 1-65535, default `9119` (the dashboard's port).
 *   * **Remote** — a HOSTNAME, and the one field that is deliberately not IPv4-strict: MagicDNS
 *     names (`box.tailnet.ts.net`) are legal here, and Tailscale is exactly the case where a name is
 *     the right thing to type.
 *
 * `http://` is appended by the app, never typed: the scheme is a transport decision the security
 * policy in `src/routes.ts` makes, not something a user should have to spell.
 */

import { inferRole, isCgnatHost, hostOf, octets } from '../routes';

export const DEFAULT_PORT = 9119;
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

/** What the IPv4 field keeps: digits and periods, nothing else (a paste of junk keeps only these). */
export function ipInput(raw: string): string {
  return String(raw ?? '').replace(/[^0-9.]/g, '');
}

/** What the port field keeps: digits only. */
export function portInput(raw: string): string {
  return String(raw ?? '').replace(/[^0-9]/g, '');
}

/** The strict reader: exactly the `octets()` rule the route model uses. */
export function isValidIpv4(raw: string): boolean {
  return octets(String(raw ?? '').trim()) !== null;
}

/**
 * A pasted `1.2.3.4:9119` (or a full `http://1.2.3.4:9119`) SPLITS into the two fields.
 *
 * The scheme is dropped — the app appends it — and the port goes to its own field. A bare address
 * (no colon, or a colon with nothing after it) leaves the port empty, which the caller reads as "the
 * default". This is what makes pasting work instead of producing one field full of junk.
 */
export function splitAddress(raw: string): { host: string; port: string } {
  const text = String(raw ?? '').trim().replace(/^https?:\/\//i, '');
  const cut = text.lastIndexOf(':');
  if (cut < 0) return { host: text.trim(), port: '' };
  const host = text.slice(0, cut).trim().replace(/^\[|\]$/g, '');
  const port = portInput(text.slice(cut + 1)).trim();
  return { host, port };
}

/** A port the app can use: the typed one when it is a real port, else the default. */
export function portOr(raw: string | number | null | undefined, fallback = DEFAULT_PORT): number {
  const value = typeof raw === 'number' ? raw : Number(portInput(String(raw ?? '')));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(PORT_MAX, Math.max(PORT_MIN, Math.trunc(value)));
}

/**
 * Clamp a typed port into 1-65535. `null` means "this field does not hold a port" — empty, or zero,
 * or letters: the caller then falls back to the default (`portOr`), which is the same answer an empty
 * field gets. A port below 1 is not a port the app may quietly rewrite into 1.
 */
export function clampPort(raw: string | number | null | undefined): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const value = Number(portInput(text));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(PORT_MAX, Math.max(PORT_MIN, Math.trunc(value)));
}

/** The LAN address the app dials: `http://<ipv4>:<port>`. `null` for anything that is not an IPv4. */
export function lanUrl(ip: string, port: number): string | null {
  const clean = String(ip ?? '').trim();
  if (!isValidIpv4(clean)) return null;
  return `http://${clean}:${portOr(port)}`;
}

/**
 * Is this a legal hostname for the REMOTE field? Letters, digits, dots and hyphens, at least one dot,
 * no spaces, no scheme, no port. `box.tailnet.ts.net` and `host.example.com` pass; `1.2.3.4:9119` and
 * `http://x` do not (the port has its own field, and the scheme is appended).
 */
export function isHostname(raw: string): boolean {
  const text = String(raw ?? '').trim();
  if (text.length < 3 || text.length > 253) return false;
  // A bare dotted quad is an ADDRESS, not a name: it belongs in the IPv4 field, and accepting it here
  // would put "10.0.0.15" through a rule that never asked it for four valid parts.
  if (isValidIpv4(text)) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(text)) return false;
  if (!text.includes('.')) return false;
  if (text.startsWith('.') || text.endsWith('.') || text.includes('..')) return false;
  return text.split('.').every((label) => label.length > 0 && !label.startsWith('-') && !label.endsWith('-'));
}

/** The remote address the app dials: `http://<hostname>:<port>`. `null` for anything else. */
export function remoteUrl(host: string, port: number): string | null {
  const clean = String(host ?? '').trim();
  if (!isHostname(clean)) return null;
  return `http://${clean}:${portOr(port)}`;
}

/**
 * Is this address one that only a working Tailscale tunnel can reach? A `100.64/10` (CGNAT) address or
 * a `*.ts.net` name. It is what makes a timeout report "Tailscale may be off on this phone" instead of
 * "wrong address" (S3.2): the failure really is the tunnel, and saying otherwise sends the user
 * hunting for a typo that is not there.
 */
export function isRemoteTarget(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (host.endsWith('.ts.net')) return true;
  return isCgnatHost(host);
}

/** The kind of address a branch's field produces, so the UI can label it without re-deriving it. */
export function targetKind(url: string): 'local' | 'remote' | 'other' {
  const role = inferRole(url);
  return role === 'tailscale' ? 'remote' : role === 'lan' ? 'local' : 'other';
}
