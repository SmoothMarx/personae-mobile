/**
 * The support bundle the wizard can SHARE (0.10.0 S3.4).
 *
 * the user, 2026-10-13: *"Include a support log share button, so the user may share their troubleshooting
 * with their own hermes instances."* His own call, and decision §3.7: **a share sheet, never an
 * upload** — there is no server route for this and there will not be one.
 *
 * WHAT GOES IN: the app version, the platform and its OS version, the device model, the connection
 * timeline (each entry with its HTTP status and duration), the server version from `/api/status`, and
 * the plugin list.
 *
 * WHAT CANNOT GO IN, and how that is enforced rather than promised:
 *   * the builder takes NO credential field at all — there is no `apiKey`, no cookie, no pair code, no
 *     message or session content in its input shape, so they cannot leak by accident;
 *   * every line is passed through `redact()` (`src/logging.ts` — the same rule the exported log
 *     uses, so a token-shaped string is `[REDACTED]` wherever it came from);
 *   * every address is MASKED: the last IPv4 octet becomes `*`, and an IPv6 address keeps its first
 *     and last hextet only.
 *   * the timeline is a CAPPED ring buffer, so the bundle is bounded no matter how long the user
 *     fiddled.
 */

import { redact } from '../logging';
import type { GatewayStatus } from '../gateway/status';

/** How many timeline entries a bundle can carry. Oldest are dropped. */
export const TIMELINE_CAP = 40;

export type TimelineEntry = {
  /** ISO timestamp — a share bundle is read by another machine, so no locale formatting. */
  at: string;
  /** What happened, in the app's own words. Addresses inside it are masked on export. */
  what: string;
  /** The HTTP status, or 0 when the attempt never got one. */
  status: number;
  ms: number;
};

/** Push onto the capped buffer: the newest entry wins, the oldest falls off. */
export function pushTimeline(entries: TimelineEntry[], entry: TimelineEntry, cap = TIMELINE_CAP): TimelineEntry[] {
  const limit = Math.max(1, Math.trunc(cap));
  const next = [...entries, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Mask the identifying half of an address, keeping it recognisable:
 *   `http://10.0.0.15:9119`  -> `http://10.0.0.*:9119`
 *   `100.64.0.2`             -> `100.64.0.*`
 *   `fd7a:115c:a1e0:ab12::1` -> `fd7a:*:*:*:*:1`   (first and last hextet only)
 *
 * The point is that a bundle shared with someone can be compared against THEIR logs ("the LAN address
 * fails") without publishing the exact address of the user's own box.
 */
export function maskAddress(text: string): string {
  let out = String(text ?? '');
  // IPv4 first: a 4-part dotted quad, any part 1-3 digits.
  out = out.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, '$1.$2.$3.*');
  // IPv6: three or more colon-separated hextet groups.
  out = out.replace(/[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,}/g, (match) => {
    const parts = match.split(':');
    if (parts.length < 4) return match;
    const head = parts[0];
    const tail = parts[parts.length - 1];
    return [head, ...parts.slice(1, parts.length - 1).map(() => '*'), tail].join(':');
  });
  return out;
}

/**
 * A long opaque run — a bearer token, a device token, a pairing code — is `[REDACTED]`, whatever field
 * it arrived in. `redact()` covers the header/query/JSON shapes; this covers the case where somebody
 * pasted one into a message, which is the shape a timeline entry can actually take.
 */
const OPAQUE_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g;

/** Every line goes through ALL THREE rules; nothing is written raw. */
function safe(text: string): string {
  return maskAddress(redact(String(text ?? '').replace(OPAQUE_TOKEN, '[REDACTED]')));
}

export type SupportBundleInput = {
  app: { name: string; version: string; versionCode: string | number | null };
  platform: { os: string; osVersion: string };
  device: { model: string };
  server: GatewayStatus | null;
  plugins: string[];
  timeline: TimelineEntry[];
  /** The addresses the app tried, in order — masked on the way out. */
  addresses?: string[];
};

export type SupportBundle = {
  generatedAt: string;
  app: { name: string; version: string; versionCode: string };
  platform: { os: string; osVersion: string };
  device: { model: string };
  server: { version: string; gatewayState: string } | null;
  plugins: string[];
  addresses: string[];
  timeline: TimelineEntry[];
};

/** Build the bundle. `now` is injected so the suite can pin the timestamp. */
export function buildSupportBundle(input: SupportBundleInput, now: number = Date.now()): SupportBundle {
  return {
    generatedAt: new Date(now).toISOString(),
    app: {
      name: String(input.app.name ?? ''),
      version: String(input.app.version ?? ''),
      versionCode: input.app.versionCode === null || input.app.versionCode === undefined ? '' : String(input.app.versionCode),
    },
    platform: { os: String(input.platform.os ?? ''), osVersion: String(input.platform.osVersion ?? '') },
    device: { model: String(input.device.model ?? '') },
    server: input.server ? { version: String(input.server.version ?? ''), gatewayState: String(input.server.gatewayState ?? '') } : null,
    plugins: (input.plugins ?? []).map((name) => safe(name)),
    addresses: (input.addresses ?? []).map((url) => safe(url)),
    timeline: (input.timeline ?? []).slice(-TIMELINE_CAP).map((entry) => ({
      at: String(entry.at ?? ''),
      what: safe(entry.what),
      status: Number.isFinite(entry.status) ? entry.status : 0,
      ms: Number.isFinite(entry.ms) ? entry.ms : 0,
    })),
  };
}

/**
 * The text handed to the OS share sheet. `expo-sharing` takes a file, so the screen writes exactly
 * this and shares the file — one place decides what leaves the phone.
 */
export function supportText(bundle: SupportBundle): string {
  const lines: string[] = [];
  lines.push(`Personae support bundle · ${bundle.generatedAt}`);
  lines.push('');
  lines.push(`app: ${bundle.app.name} ${bundle.app.version} (${bundle.app.versionCode})`);
  lines.push(`platform: ${bundle.platform.os} ${bundle.platform.osVersion}`);
  lines.push(`device: ${bundle.device.model}`);
  lines.push(`server: ${bundle.server ? `${bundle.server.version} · ${bundle.server.gatewayState}` : 'not known'}`);
  lines.push(`plugins: ${bundle.plugins.length ? bundle.plugins.join(', ') : 'none reported'}`);
  if (bundle.addresses.length) {
    lines.push('');
    lines.push('connections tried:');
    for (const address of bundle.addresses) lines.push(`  ${address}`);
  }
  lines.push('');
  lines.push(`timeline (last ${TIMELINE_CAP}):`);
  if (!bundle.timeline.length) lines.push('  (nothing recorded)');
  for (const entry of bundle.timeline) {
    lines.push(`  ${entry.at} · ${entry.what} · HTTP ${entry.status} · ${entry.ms} ms`);
  }
  lines.push('');
  lines.push('Addresses are masked and credentials are never included.');
  // The last gate: even a field that somehow carried a secret goes through both rules on the way out.
  return safe(lines.join('\n'));
}
