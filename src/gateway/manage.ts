/**
 * Managing the connections (0.10.0 S5): rename, edit the address, delete, and refuse a duplicate.
 *
 * All four are ROUTE operations and nothing else — same list, same model, same security policy. Two
 * rules are stated here because they are the ones a reader would otherwise wonder about:
 *
 *   * **Deleting a route never touches the credential.** The credential in this app is PER SERVER
 *     (one gateway, a device token inside secure storage), not per route — so there is nothing to
 *     revoke when an address goes away, and `deleteRoute` returns a patch made of `{routes, baseUrl}`
 *     and nothing else. Forgetting the device on the server is a separate, explicit action, and it
 *     uses the device's own self-revoke path (`src/pairing.ts::revokeSelf`).
 *   * **Deleting the route the app is ON leaves a defined state.** The remaining list is put through
 *     the existing `selectRoute`, so the app either lands on the next best route that is actually
 *     REACHABLE (`baseUrl` = its address) or on the empty state (`baseUrl: ''`), which is the state
 *     that offers the wizard. Nothing is left pointing at an address that no longer exists.
 */

import {
  inferRole,
  normalizeRouteUrl,
  orderRoutes,
  renumberRoutes,
  routeExists,
  selectRoute,
  type RouteCandidate,
  type RouteDecision,
} from '../routes';
import type { Settings } from '../settings';
import { DEFAULT_PORT } from '../connect/address';

/** The row at an index of the DRAWN order (which is the priority order). */
export function routeAt(routes: RouteCandidate[], index: number): RouteCandidate | null {
  return orderRoutes(routes)[index] ?? null;
}

/**
 * Rename a connection. The label is the only field that changes — `role`, `priority`, `url` and
 * `insecure` are copied through untouched, which is what makes "rename changes the label only" a fact
 * rather than a promise. An empty name clears the label (the row falls back to its kind noun).
 */
export function renameRoute(routes: RouteCandidate[], index: number, label: string): RouteCandidate[] {
  const ordered = orderRoutes(routes);
  if (index < 0 || index >= ordered.length) return ordered;
  const clean = String(label ?? '').trim();
  return ordered.map((route, position) => {
    if (position !== index) return { ...route };
    const next: RouteCandidate = { ...route };
    if (clean) next.label = clean;
    else delete next.label;
    return next;
  });
}

export type ManualAddResult =
  | { ok: true; route: RouteCandidate; routes: RouteCandidate[] }
  | { ok: false; reason: 'duplicate' | 'invalid' };

/**
 * Add a connection by hand — the path the user's §2 describes (an address, a port, `http://` appended by
 * the app).
 *
 * The text may arrive either way, and both are the same route: `10.0.0.15` with the port field beside
 * it, or a pasted `http://10.0.0.15:9119`. The scheme is added when it is missing and the port that is
 * already in the text WINS over the field, so pasting a full address cannot produce a doubled port.
 *
 * A duplicate is refused exactly as `peerRoute()` refuses one: same `routeExists` rule, same silence —
 * a second row is not created, and the user is not told their existing route is somehow wrong.
 */
export function manualAdd(
  routes: RouteCandidate[],
  raw: string,
  options: { port?: number | null; insecureAck?: boolean } = {},
): ManualAddResult {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'invalid' };
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!parsed.hostname) return { ok: false, reason: 'invalid' };
  const port = parsed.port || String(options.port && options.port > 0 ? options.port : DEFAULT_PORT);
  const url = normalizeRouteUrl(`${parsed.protocol}//${parsed.hostname}:${port}`);
  if (!url) return { ok: false, reason: 'invalid' };
  if (routeExists(routes, url)) return { ok: false, reason: 'duplicate' };
  const ordered = orderRoutes(routes);
  const route: RouteCandidate = {
    role: inferRole(url),
    priority: ordered.reduce((max, item) => Math.max(max, item.priority), -1) + 1,
    url,
    // `insecureAck` is the caller's consent flag for a plain-http private route; it is written on the
    // route the same way `peerRoute` writes it, so a manually added tailnet address behaves like a
    // picked one. A public http:// address is still refused by `checkRoute` — nothing here weakens it.
    insecure: url.startsWith('http://') && (options.insecureAck ?? true),
  };
  return { ok: true, route, routes: renumberRoutes([...ordered, route]) };
}

/**
 * Delete a connection and leave the app in a DEFINED state. `isReachable` is the caller's predicate
 * over already-probed answers (the same shape `selectRoute` takes), so this stays pure.
 */
export function deleteRoute(
  settings: Pick<Settings, 'routes' | 'baseUrl' | 'insecureRouteAck' | 'preferredRouteRole'>,
  index: number,
  isReachable: (route: RouteCandidate) => boolean,
): { routes: RouteCandidate[]; baseUrl: string; decision: RouteDecision; empty: boolean } {
  const ordered = orderRoutes(settings.routes);
  const remaining = renumberRoutes(ordered.filter((_route, position) => position !== index));
  const decision = selectRoute(remaining, isReachable, {
    insecureAck: settings.insecureRouteAck,
    preferredRole: settings.preferredRouteRole,
  });
  return {
    routes: remaining,
    // '' is the empty state, which is the state that OFFERS the wizard (S3, entry (a)/(d)).
    baseUrl: decision.route ? decision.route.url : '',
    decision,
    empty: remaining.length === 0,
  };
}
