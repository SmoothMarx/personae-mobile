/**
 * The export log (PLAN-UI.md §9) — one file that is "log + what went wrong".
 *
 * Rules it implements, in order of importance:
 *
 *  1. **A secret can never leave**, and that is unit-tested: the live bearer is registered as a
 *     known secret and replaced by `[REDACTED]` wherever it appears, on top of the pattern rules for
 *     auth headers, ticket/token query values and JSON credential fields. Credential-bearing bodies
 *     are never logged in the first place.
 *  2. **Capped ring buffer** (~500 entries): timestamp, level, category
 *     (`net|auth|api|ws|ui|error`), message; per call: method, path, status, duration, chosen
 *     connection, attempt #.
 *  3. **Header** with the app version + versionCode, device + OS, the active connection and the
 *     candidate list with priorities, the dashboard host (host only), Tailscale state and the last
 *     three failures.
 *  4. **A description box** on the export screen: what the user types lands at the top of the file.
 *  5. **Share, never upload.** Local only: no telemetry, no auto-send.
 */

import { t } from './i18n';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogCategory = 'net' | 'auth' | 'api' | 'ws' | 'ui' | 'error';

export type LogEntry = {
  at: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
};

export type CallRecord = {
  method: string;
  path: string;
  status: number | null;
  ms: number;
  attempt?: number;
};

export const LOG_LIMIT = 500;
export const REDACTED = '[REDACTED]';

const PATTERNS: [RegExp, string][] = [
  // Authorization headers, wherever they are echoed.
  [/(authorization"?\s*[:=]\s*"?)(bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${REDACTED}`],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // Query credentials: ?ticket=… , ?token=… , &api_key=…
  [/([?&](?:ticket|token|api_key|apikey|key|access_token|refresh_token|password)=)[^&\s"']+/gi, `$1${REDACTED}`],
  // JSON credential fields.
  [/("(?:ticket|token|access_token|refresh_token|apiKey|api_key|password|secret|authorization)"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`],
  // Form-encoded credentials.
  [/(\b(?:ticket|token|password|secret)=)[^&\s"']+/gi, `$1${REDACTED}`],
];

const knownSecrets = new Set<string>();

/** Register a live secret so its exact bytes can never appear in an exported log. */
export function addSecret(value: string | null | undefined): void {
  const trimmed = (value || '').trim();
  if (trimmed.length >= 6) knownSecrets.add(trimmed);
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  for (const secret of knownSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  // The header's own bearer is never written; this is belt and braces.
  return out;
}

export type ExportLogOptions = {
  now?: () => number;
  limit?: number;
};

export function createLog(options: ExportLogOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const limit = options.limit ?? LOG_LIMIT;
  const entries: LogEntry[] = [];

  const push = (level: LogLevel, category: LogCategory, message: string): void => {
    entries.push({ at: now(), level, category, message: redact(message) });
    while (entries.length > limit) entries.shift();
  };

  return {
    entries,
    info: (category: LogCategory, message: string) => push('info', category, message),
    warn: (category: LogCategory, message: string) => push('warn', category, message),
    error: (category: LogCategory, message: string) => push('error', category, message),
    /** One line per HTTP/RPC call — no bodies, only the identity of the call. */
    call: (record: CallRecord): void =>
      push(
        record.status !== null && record.status >= 400 ? 'warn' : 'info',
        'api',
        `${record.method} ${record.path}${record.attempt && record.attempt > 1 ? t.log.attempt(record.attempt) : ''} → ${t.log.took(record.status === null ? t.log.noResponse : String(record.status), record.ms)}`,
      ),
    clear: () => {
      entries.length = 0;
    },
  };
}

/** The one process-wide log the app writes to. */
export const log = createLog();

export type LogHeader = {
  appVersion: string;
  versionCode: string;
  surface: string;
  baseUrl: string;
  activeRoute?: string;
  routes?: { url: string; role: string; priority: number }[];
  tailscale?: string;
  deviceOs?: string;
  failures?: string[];
};

export function buildLogDocument(header: LogHeader, description: string, entries: LogEntry[]): string {
  const stamp = (ms: number) => new Date(ms).toISOString();
  const lines: string[] = [];
  lines.push(t.log.docTitle);
  lines.push('=================================');
  lines.push(t.log.generated(stamp(Date.now())));
  lines.push('');
  if (description.trim()) {
    lines.push(t.log.userNote);
    lines.push(description.trim());
    lines.push('');
  }
  lines.push(t.log.context);
  lines.push('--------');
  lines.push(`App: ${header.appVersion} (versionCode ${header.versionCode})`);
  lines.push(t.log.connection(header.surface, header.baseUrl || t.log.noAddress));
  if (header.activeRoute) lines.push(t.log.activeRoute(header.activeRoute));
  if (header.routes?.length) {
    lines.push(t.log.candidateRoutes);
    for (const route of header.routes) lines.push(`  ${route.priority}. ${route.url} [${route.role}]`);
  }
  if (header.tailscale) lines.push(`Tailscale: ${header.tailscale}`);
  if (header.failures?.length) {
    lines.push(t.log.recentFailures);
    for (const failure of header.failures.slice(-3)) lines.push(`  - ${failure}`);
  }
  lines.push(t.log.device(header.deviceOs ?? t.log.notAvailable));
  lines.push('');
  lines.push(t.log.entries(entries.length));
  lines.push('------------------------------------------------');
  for (const entry of entries) {
    lines.push(`${stamp(entry.at)} [${entry.level}] ${entry.category}: ${entry.message}`);
  }
  if (!entries.length) lines.push(t.log.empty);
  lines.push('');
  lines.push(t.log.redactionNote);
  return redact(lines.join('\n'));
}
