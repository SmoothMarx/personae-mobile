/**
 * The wizard's Test connection, as three STAGED calls (0.10.0 S3.3).
 *
 * A single "it failed" tells the user nothing: an address can be wrong, a tunnel can be down, the
 * address can be right and something else entirely can be listening, and the credential can be the
 * one thing that is stale. So the test is three calls, and the FIRST failure names the problem:
 *
 *   1. **reachable** — the existing native `probeTcp` (host + port). A failure here is a network
 *      failure, and it is reported as the RIGHT network failure: a `100.64/10` or `*.ts.net` target
 *      timed out because the tunnel is down, not because the user mistyped an address (S3.2).
 *   2. **is this Hermes** — `GET /api/status` (public). An answer that is not a status body means
 *      something else is listening on that port.
 *   3. **authenticated** — ONE real call with the stored token. A **401 here means "sign in"**, and
 *      never "bad address": the address was proved good by stages 1 and 2.
 *
 * Injected I/O only (brief §1.12): the suite drives all three stages with fakes, and the screen passes
 * the native TCP probe, a real `/api/status` read, and one authenticated call.
 */

import type { Strings } from '../i18n';
import { hostOf, portOf } from '../routes';
import { parseGatewayStatus, statusUrl, type GatewayStatus } from '../gateway/status';
import { isRemoteTarget } from './address';

export const TEST_STAGE_IDS = ['reachable', 'hermes', 'authenticated'] as const;
export type TestStageId = (typeof TEST_STAGE_IDS)[number];

export type TestStage = {
  stage: TestStageId;
  ok: boolean;
  ms: number;
  /** The HTTP status the stage saw; 0 for a stage that never got that far. */
  status: number;
};

export type TestVerdict =
  | 'ok'
  /** Nothing answered, and the target is only reachable through Tailscale. */
  | 'tailscale-off'
  /** Nothing answered, and the target is a plain LAN/public address. */
  | 'unreachable'
  /** Something is listening, but it is not a Hermes gateway. */
  | 'not-hermes'
  /** The gateway answered and refused the credential: sign in again. */
  | 'sign-in'
  /** The address itself is unusable (no host/port, or a port the app cannot use). */
  | 'bad-address';

export type TestDeps = {
  /** The native TCP connect, with the user's timeout. */
  tcp: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** An unauthenticated `GET /api/status`. */
  status: (url: string, timeoutMs: number) => Promise<{ status: number; body: unknown } | null>;
  /** One authenticated call. The credential never appears in the result. */
  authed: (url: string) => Promise<{ status: number } | null>;
  timeoutMs: number;
  now?: () => number;
};

export type TestResult = {
  verdict: TestVerdict;
  stages: TestStage[];
  server: GatewayStatus | null;
};

/**
 * Run the stages, stopping at the first failure. `server` is filled only when stage 2 answered, so the
 * success panel can show the version and the gateway state without a second call.
 */
export async function stagedConnectionTest(url: string, deps: TestDeps): Promise<TestResult> {
  const now = deps.now ?? Date.now;
  const host = hostOf(url);
  const port = portOf(url);
  const stages: TestStage[] = [];
  if (!host || port === null) {
    return { verdict: 'bad-address', stages: [{ stage: 'reachable', ok: false, ms: 0, status: 0 }], server: null };
  }

  // Stage 1 — reachable.
  const started1 = now();
  const reachable = await deps.tcp(host, port, deps.timeoutMs);
  stages.push({ stage: 'reachable', ok: reachable, ms: now() - started1, status: 0 });
  if (!reachable) return { verdict: isRemoteTarget(url) ? 'tailscale-off' : 'unreachable', stages, server: null };

  // Stage 2 — is this Hermes?
  const started2 = now();
  const status = await deps.status(url, deps.timeoutMs);
  const server = status ? parseGatewayStatus(status.body) : null;
  const hermes = Boolean(status && server);
  stages.push({ stage: 'hermes', ok: hermes, ms: now() - started2, status: status?.status ?? 0 });
  if (!hermes) return { verdict: 'not-hermes', stages, server: null };

  // Stage 3 — authenticated. A 401/403 here is "sign in", NOT "bad address".
  const started3 = now();
  const authed = await deps.authed(url);
  const code = authed?.status ?? 0;
  const ok = code >= 200 && code < 300;
  stages.push({ stage: 'authenticated', ok, ms: now() - started3, status: code });
  if (ok) return { verdict: 'ok', stages, server };
  if (code === 401 || code === 403) return { verdict: 'sign-in', stages, server };
  return { verdict: 'not-hermes', stages, server: null };
}

/**
 * The message key for a verdict — the screen resolves it through the string table, and the type says
 * so, so a verdict without words is a compile error rather than a blank line on a phone.
 */
export const TEST_MESSAGE_KEY: Record<TestVerdict, keyof Strings['settings']> = {
  ok: 'wizTestOk',
  'tailscale-off': 'wizTestTailscaleOff',
  unreachable: 'wizTestUnreachable',
  'not-hermes': 'wizTestNotHermes',
  'sign-in': 'wizTestSignIn',
  'bad-address': 'wizTestBadAddress',
};

/** The `GET /api/status` reader the screen passes as `deps.status`, with its body kept. */
export async function readStatusBody(url: string, timeoutMs: number): Promise<{ status: number; body: unknown } | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(100, timeoutMs)) : null;
  try {
    const response = await fetch(statusUrl(url), {
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
