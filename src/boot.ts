/**
 * 0.13.0 W4 — the boot state machine: what the app does when it launches.
 *
 * The behaviour was never specified, so nothing here is a bug fix and nothing is redesigned: this
 * module states the ONE decision the app makes at launch, in one place, so the screen cannot invent a
 * second one.
 *
 *   boot
 *    ├── no stored credential        → the connect screen   (`app/connect.tsx`)
 *    └── stored credential present   → the token-gated probe
 *           ├── valid                → the profiles screen  (the roster, `app/index.tsx`)
 *           └── refused (401)        → the login screen WITH the reason, ONCE
 *
 * "Resume" means the main profiles screen listing every profile — it does NOT reopen the last thread.
 *
 * There is NO toggle and NO new persisted field. Persistence is already a fact (`expo-secure-store`
 * holds the token and the base URL); the only condition for connecting on launch is that BOTH are
 * present. `src/settings.ts`'s `autoConnect` is the Tailscale tunnel's master switch and is
 * deliberately NOT repurposed here.
 */

import type { Backend } from './api/backend';
import { normalizeError } from './api/errors';
import type { Settings } from './settings';

/** Where the boot machine must land. */
export type BootStage =
  /** The settings have not loaded: decide nothing yet. */
  | 'wait'
  /** No stored credential — the connect screen (`app/connect.tsx`, which hosts `src/connect/Wizard`). */
  | 'connect'
  /** The stored credential was refused: the login screen, once, with the reason. */
  | 'login'
  /**
   * The profiles screen. Also the answer while the probe is still running AND when the gateway could
   * not be reached at all: an unreachable gateway is NOT an invalid token, and the roster already owns
   * the honest connectivity banner for it.
   */
  | 'profiles';

/** The wizard step the login fallback opens on (`src/connect/wizard.ts`'s "2 · Sign in"). */
export const LOGIN_STEP = 'sign-in';

/** What the token-gated probe said. */
export type ProbeResult =
  | { kind: 'valid' }
  /** The credential itself was refused (401 / `gateway_auth_failed`) — the login fallback's case. */
  | { kind: 'refused'; reason: string }
  /** Anything else: no route, a timeout, a 5xx. NEVER treated as a bad credential. */
  | { kind: 'unreachable'; reason: string };

/**
 * Both halves of the stored connection, and only those two.
 *
 * A base URL with no token (or the reverse) is not a connection: the app has nothing to authenticate
 * with, so it is the connect screen's job, not the login screen's.
 */
export function hasStoredCredentials(settings: Pick<Settings, 'baseUrl' | 'apiKey'>): boolean {
  return Boolean(String(settings.baseUrl ?? '').trim()) && Boolean(settings.apiKey);
}

/** The ONE decision. Pure, so the screen cannot add a second one. */
export function bootStage(input: {
  /** The settings have loaded (`useSettings().ready`). */
  ready: boolean;
  /** Both halves of the connection are stored (`hasStoredCredentials`). */
  configured: boolean;
  /** What the probe said, or `null` while it is still running (or has not started). */
  probe: ProbeResult | null;
}): BootStage {
  if (!input.ready) return 'wait';
  if (!input.configured) return 'connect';
  if (input.probe?.kind === 'refused') return 'login';
  return 'profiles';
}

/**
 * The token-gated probe: `GET /api/profiles`, through `backend.profiles()` → the dashboard client's
 * `json('/api/profiles')` (`src/api/dashboard.ts`). It is bearer'd, so a 200 proves the token; it is
 * also the roster's own source of truth, so the probe is a real request the app needed anyway.
 *
 * A HEALTH/STATUS route is deliberately NOT the probe (the one whose path is spelled out in
 * `DESIGN-0.13.0.md` §6.3): it is UNAUTHENTICATED and reports only `auth_required`, so it answers 200
 * to anyone who can reach the host and can never prove a token is good. The boot path therefore opens
 * no such route — see `logs/verify-0.13.0.txt`, which greps this very file for it.
 *
 * The classification reuses the EXISTING classifier — `ApiError.isAuth` (`status === 401 ||
 * code === 'gateway_auth_failed'`) — rather than a second copy of the rule.
 */
export async function probeCredentials(backend: Pick<Backend, 'profiles'>): Promise<ProbeResult> {
  try {
    await backend.profiles();
    return { kind: 'valid' };
  } catch (error) {
    const normalized = normalizeError(error);
    if (normalized.isAuth) return { kind: 'refused', reason: normalized.message };
    return { kind: 'unreachable', reason: normalized.message };
  }
}

/**
 * What "Disconnect" clears: BOTH halves of the stored connection, and nothing else.
 *
 * `saveSettings` deletes the secure-store entry when `apiKey` is empty, so this patch removes the
 * token from the Keystore/Keychain as well as from the JSON blob. The dashboard password is never
 * persisted in the first place, so there is nothing of it to clear. The wizard's own dismissed flag is
 * NOT touched: it is UI state, not a credential.
 */
export function disconnectPatch(): Partial<Settings> {
  return { baseUrl: '', routes: [], apiKey: '' };
}
