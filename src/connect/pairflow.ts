/**
 * The wizard's LAN login, as an ORDERED flow (0.10.0 S3.1).
 *
 * the user, 2026-10-13: *"If the user manually inserts IP and Port, show the 'login' button that
 * redirects to the hermes dashboard page, where they can login to authenticate their Personae
 * session."*
 *
 * The dashboard page is `<base>/login?next=/pair`. Signing in there is what the user must do, and the
 * app cannot do it for them — so the flow is a SEQUENCE, and this module is that sequence:
 *
 *   1. **open the login page in the in-app browser** (`expo-web-browser`, already a dependency);
 *   2. **when the browser returns, poll `/pair/status?id=`** — the same-device case, where the page
 *      and the phone are on one phone and the user should not have to scan something already on their
 *      screen;
 *   3. **redeem** with `POST /pair/redeem` (the existing `redeemPairing`).
 *
 * The QR / `personae://` link path is untouched and still completes on its own: a return URL that
 * carries a connect link is redeemed through the same step 3, and a cross-device setup keeps using the
 * QR. The poll is what the brief asks for and it is also the honest fallback — when the dashboard
 * reports the pairing was completed elsewhere, this flow says so instead of pretending.
 *
 * Everything I/O is injected, so the suite drives the whole order offline (brief §1.12).
 */

import { PAIR_PREFIX, parseConnectLink, type ConnectLink, type PairingResult } from '../pairing';

/** The page the login button lands on after signing in. */
export const LOGIN_NEXT = '/pair';
export const PAIR_STATUS_PATH = `${PAIR_PREFIX}/pair/status`;

/** Where the in-app browser starts: the dashboard login, next stop the pairing page. */
export function wizardLoginUrl(base: string): string {
  return `${String(base ?? '').replace(/\/+$/, '')}/login?next=${encodeURIComponent(LOGIN_NEXT)}`;
}

/**
 * The dashboard's own progress route, EXACTLY as the plugin publishes it
 * (`plugin_api.py:190` — `poll_url = f"{API_PREFIX}/pair/status?id={pair_id}"`).
 */
export function pairStatusUrl(base: string, id: string): string {
  return `${String(base ?? '').replace(/\/+$/, '')}${PAIR_STATUS_PATH}?id=${encodeURIComponent(id)}`;
}

/** The dashboard's vocabulary for one pairing: `state` is one of these (`plugin_api.py:254`). */
export const PAIR_STATES = ['pending', 'redeemed', 'expired'] as const;
export type PairState = (typeof PAIR_STATES)[number];

/** Read the `id` the dashboard put in the URL it returned to. '' when there is none. */
export function pairIdFrom(url: string | null | undefined): string {
  const text = String(url ?? '');
  const query = text.slice(text.indexOf('?') + 1);
  if (!text.includes('?')) return '';
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).toLowerCase();
    if (key !== 'id' && key !== 'pair' && key !== 'pair_id') continue;
    try {
      return decodeURIComponent(part.slice(eq + 1));
    } catch {
      return part.slice(eq + 1);
    }
  }
  return '';
}

/** Whatever the status body says, mapped to the three states; anything else is `pending`. */
export function parsePairState(body: unknown): PairState {
  const state = body && typeof body === 'object' ? String((body as Record<string, unknown>).state ?? '') : '';
  return (PAIR_STATES as readonly string[]).includes(state) ? (state as PairState) : 'pending';
}

/** What the in-app browser handed back. `url` is the URL the session ended on, when there is one. */
export type BrowserReturn = { url?: string | null; cancelled?: boolean };

export type PairLoginDeps = {
  base: string;
  /** The in-app browser. Resolves when the session ends. */
  openBrowser: (loginUrl: string) => Promise<BrowserReturn>;
  /** ONE read of the dashboard's progress route. */
  pollStatus: (url: string) => Promise<unknown>;
  /** The existing redeem (`src/pairing.ts::redeemPairing`), injected. */
  redeem: (link: ConnectLink) => Promise<PairingResult>;
  /** Waits between polls. Injected so the suite does not spend real seconds. */
  wait?: (ms: number) => Promise<void>;
  /** How many times to ask. Small on purpose: this is a person watching a spinner. */
  attempts?: number;
  intervalMs?: number;
};

export type PairLoginOutcome =
  | { outcome: 'redeemed'; result: PairingResult; polled: boolean }
  /** The app cannot finish this one alone; the QR / pasted link path stays for it. */
  | { outcome: 'needs-qr'; reason: 'no-id' | 'browser-closed' | 'expired' | 'no-code' };

/**
 * Run the three steps, in that order. The order is the contract: the browser FIRST (it is where the
 * user signs in), the poll SECOND (it is how the app learns the dashboard finished), the redeem LAST.
 */
export async function runPairLogin(deps: PairLoginDeps): Promise<PairLoginOutcome> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, deps.attempts ?? 5);
  const intervalMs = Math.max(0, deps.intervalMs ?? 1000);

  const back = await deps.openBrowser(wizardLoginUrl(deps.base));
  const link = parseConnectLink(back.url ?? null);
  const id = pairIdFrom(back.url ?? '');

  // Step 2 — the poll. It runs whenever the dashboard told us which pairing to watch, including when a
  // connect link came back with it (the brief's order: poll, THEN redeem).
  let polled = false;
  let state: PairState = 'pending';
  if (id) {
    polled = true;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      state = parsePairState(await deps.pollStatus(pairStatusUrl(deps.base, id)));
      if (state !== 'pending') break;
      if (attempt < attempts - 1) await wait(intervalMs);
    }
    if (state === 'expired') return { outcome: 'needs-qr', reason: 'expired' };
  }

  // Step 3 — redeem. The deep link is the credential; without one there is nothing to redeem, and the
  // honest answer is the QR path rather than a fabricated success.
  if (link) return { outcome: 'redeemed', result: await deps.redeem(link), polled };
  if (back.cancelled) return { outcome: 'needs-qr', reason: 'browser-closed' };
  if (id) return { outcome: 'needs-qr', reason: 'no-code' };
  return { outcome: 'needs-qr', reason: 'no-id' };
}
