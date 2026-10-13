/**
 * Route candidates: ONE logical gateway server, reached by SEVERAL network routes.
 *
 * Why this exists: the same gateway is `http://10.0.0.15:9222` at home and
 * `https://<host>.<tailnet>.ts.net:10443` on cellular. A single stored `baseUrl` is therefore wrong
 * in one of those two places half the time. A *list* of candidates, ordered by priority, is right in
 * both: on connect (and whenever the network changes) the highest-priority REACHABLE one is used, so
 * walking out of the house hops LAN → Tailscale instead of dying.
 *
 * Priority semantics are the DNS SRV contract (see DECISIONS D4):
 *   - lower `priority` number = tried first, strictly;
 *   - reachability NEVER promotes a lower priority over a higher one, it only breaks ties *within*
 *     one priority group;
 *   - a lower-priority group is consulted only when every candidate in the higher group is
 *     unreachable. That is failover, and it is not the same thing as promotion.
 *
 * `role` is an OPEN STRING on purpose. `lan` / `tailscale` / `public` get styled labels; anything
 * else (`wireguard`, `zerotunnel`, …) renders as `Personalizado (<role>)`. It is never enumerated,
 * normalized or rewritten, so a role this build has never heard of still works.
 */

import { t } from './i18n';

export type RouteRole = string;

export type RouteCandidate = {
  /** Open string. Styled labels exist for lan / tailscale / public; anything else is shown raw. */
  role: RouteRole;
  /** Strict: 0 = highest. Ties are broken by reachability, then by list order. */
  priority: number;
  /** Origin only, no trailing slash, no path: `https://host:10443`. */
  url: string;
  /** Consent flag for a plain-http route on a private overlay (see `checkRoute`). */
  insecure: boolean;
  /**
   * 0.10.0 S5 — the name the USER gave this connection ('' / absent = none).
   *
   * A label, never an identity: `role` stays inferred from the address (`inferRole`), and two routes
   * may share a label without confusing anything, because the dropdown keys its rows by address. It
   * exists so the connections dropdown can say "Home" instead of showing a bare address — nothing in
   * the route model reads it, and no security decision is taken from it.
   */
  label?: string;
};

/** Styled roles. Everything else renders as `Personalizado (<role>)`. */
export const STYLED_ROLES = ['lan', 'tailscale', 'public'] as const;

export function roleLabel(role: RouteRole): string {
  switch (role) {
    case 'lan':
      return t.routes.roleLan;
    case 'tailscale':
      return t.routes.roleTailscale;
    case 'public':
      return t.routes.rolePublic;
    default:
      return t.routes.customRole(role);
  }
}

// ───────────────────────────────────────────────────────────── address parsing ──

/** Hostname of an origin, lowercased, without IPv6 brackets or a port. '' when unparseable. */
export function hostOf(url: string): string {
  const raw = (url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return (parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

export function portOf(url: string): number | null {
  try {
    const parsed = new URL((url || '').trim());
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : null;
  } catch {
    return null;
  }
}

function octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

/** 127.0.0.0/8 or ::1 or the literal `localhost`. */
export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost' || host === '::1') return true;
  const o = octets(host);
  return o !== null && o[0] === 127;
}

/** 100.64.0.0/10 — the CGNAT range Tailscale assigns (includes every `100.x` tailnet address). */
export function isCgnatHost(host: string): boolean {
  const o = octets(host);
  if (o === null) return false;
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

/** RFC1918: 10/8, 172.16/12, 192.168/16. */
export function isRfc1918Host(host: string): boolean {
  const o = octets(host);
  if (o === null) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return false;
}

/**
 * Infer the role from the address, so the user is never asked to classify their own network.
 *   *.ts.net name  or 100.64.0.0/10  -> tailscale
 *   RFC1918                          -> lan
 *   else                             -> public
 *
 * Documented refinement (DECISIONS D4): loopback is also `lan`, not `public`. 127.0.0.0/8 is by
 * definition not publicly routable, and labelling it `public` would both be false on screen and
 * wrongly force it through the https-only rule for public origins.
 */
export function inferRole(url: string): RouteRole {
  const host = hostOf(url);
  if (!host) return 'public';
  if (isLoopbackHost(host)) return 'lan';
  if (host.endsWith('.ts.net')) return 'tailscale';
  if (isCgnatHost(host)) return 'tailscale';
  if (isRfc1918Host(host)) return 'lan';
  return 'public';
}

/** True for anything whose traffic cannot leave the machine or the private overlay. */
export function isPrivateOverlay(role: RouteRole): boolean {
  return role === 'lan' || role === 'tailscale';
}

// ────────────────────────────────────────────────────────── per-route security ──

export type RouteProblem = 'bad-url' | 'public-http' | 'needs-ack';

export type RouteCheck = { ok: true; url: string } | { ok: false; reason: RouteProblem };

export function normalizeRouteUrl(raw: string): string {
  return (raw || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');
}

/**
 * Per-route security policy.
 *   - https is always acceptable;
 *   - plain http is acceptable ONLY on loopback (needs nothing) or a private overlay
 *     (lan / tailscale), and on a private overlay it additionally needs the explicit
 *     `insecureRouteAck` consent;
 *   - plain http on a PUBLIC origin is never acceptable.
 *
 * The role used here is always re-inferred from the URL, never taken from the stored `role` field:
 * a mislabelled route must not be able to talk its way past the https rule.
 */
export function checkRoute(route: RouteCandidate, opts: { insecureAck: boolean }): RouteCheck {
  const url = normalizeRouteUrl(route.url);
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, reason: 'bad-url' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'bad-url' };
  }
  if (!parsed.hostname) return { ok: false, reason: 'bad-url' };
  if (parsed.protocol === 'https:') return { ok: true, url };
  if (isLoopbackHost(parsed.hostname.toLowerCase())) return { ok: true, url };
  if (inferRole(url) === 'public') return { ok: false, reason: 'public-http' };
  if (!opts.insecureAck) return { ok: false, reason: 'needs-ack' };
  return { ok: true, url };
}

/**
 * How this route's traffic is actually protected, stated accurately.
 *
 * This is the honesty rule: a raw `http://<tailnet-ip>:<port>` route has no application-layer TLS,
 * but Tailscale's WireGuard data plane still encrypts every packet, so it is NOT "public
 * plaintext" and must never be described that way.
 */
export function transportSecurityNote(route: RouteCandidate): string {
  const url = normalizeRouteUrl(route.url);
  const role = inferRole(url);
  const https = /^https:\/\//i.test(url);
  if (role === 'tailscale') return https ? t.routes.secTailscaleTls : t.routes.secTailscaleWireguard;
  if (role === 'lan') return https ? t.routes.secLocalTls : t.routes.secLocalPlain;
  return https ? t.routes.secPublicTls : t.routes.secPublicPlain;
}

// ──────────────────────────────────────────────────────────────── ordering ──

/** Stable ascending sort by priority: equal priorities keep their list order. */
export function orderRoutes(routes: RouteCandidate[]): RouteCandidate[] {
  return routes
    .map((route, index) => ({ route, index }))
    .sort((a, b) => a.route.priority - b.route.priority || a.index - b.index)
    .map((entry) => entry.route);
}

/**
 * The highest-priority group that contains at least one reachable candidate, and the first
 * reachable candidate inside it. Returns null when nothing is reachable.
 *
 * `isReachable` is a plain predicate over an already-probed cache, which keeps this pure and
 * unit-testable — no I/O here.
 */
export function pickByPriority(
  routes: RouteCandidate[],
  isReachable: (route: RouteCandidate) => boolean,
): RouteCandidate | null {
  const ordered = orderRoutes(routes);
  let index = 0;
  while (index < ordered.length) {
    const priority = ordered[index].priority;
    const group: RouteCandidate[] = [];
    while (index < ordered.length && ordered[index].priority === priority) {
      group.push(ordered[index]);
      index += 1;
    }
    const reachable = group.find((route) => isReachable(route));
    if (reachable) return reachable;
  }
  return null;
}

export type RouteDecisionReason = 'selected' | 'no-routes' | 'none-reachable' | 'pin-bypassed';

export type RouteDecision = {
  route: RouteCandidate | null;
  reason: RouteDecisionReason;
  /** Candidates that were skipped because they violate the security policy, with the reason. */
  rejected: { route: RouteCandidate; reason: RouteProblem }[];
};

/**
 * Choose a route. `preferredRole` is an optional manual pin; when the pinned role has no reachable
 * candidate the pin is BYPASSED (a working connection beats a respected preference) and the caller
 * is told so via `reason === 'pin-bypassed'`, so the screen can say it out loud instead of silently
 * ignoring the user's choice.
 */
export function selectRoute(
  routes: RouteCandidate[],
  isReachable: (route: RouteCandidate) => boolean,
  opts: { insecureAck: boolean; preferredRole?: string | null },
): RouteDecision {
  const rejected: { route: RouteCandidate; reason: RouteProblem }[] = [];
  const usable: RouteCandidate[] = [];
  for (const route of routes) {
    const check = checkRoute(route, { insecureAck: opts.insecureAck });
    if (check.ok) usable.push({ ...route, url: check.url });
    else rejected.push({ route, reason: check.reason });
  }
  if (!usable.length) return { route: null, reason: 'no-routes', rejected };

  const pin = (opts.preferredRole || '').trim();
  if (pin) {
    const pinned = usable.filter((route) => route.role === pin);
    const chosen = pickByPriority(pinned, isReachable);
    if (chosen) return { route: chosen, reason: 'selected', rejected };
    const fallback = pickByPriority(usable, isReachable);
    if (fallback) return { route: fallback, reason: 'pin-bypassed', rejected };
    return { route: null, reason: 'none-reachable', rejected };
  }

  const chosen = pickByPriority(usable, isReachable);
  if (chosen) return { route: chosen, reason: 'selected', rejected };
  return { route: null, reason: 'none-reachable', rejected };
}

// ────────────────────────────────────────────────────── storage / migration ──

/** Derive the initial candidate list from a legacy single `baseUrl`. */
export function routesFromBaseUrl(baseUrl: string): RouteCandidate[] {
  const url = normalizeRouteUrl(baseUrl);
  if (!url || !/^https?:\/\//i.test(url)) return [];
  return [{ role: inferRole(url), priority: 0, url, insecure: false }];
}

/** Coerce whatever came out of storage into well-formed candidates. Bad rows are dropped. */
export function normalizeRoutes(raw: unknown): RouteCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: RouteCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Partial<RouteCandidate>;
    const url = normalizeRouteUrl(typeof value.url === 'string' ? value.url : '');
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const priority = typeof value.priority === 'number' && Number.isFinite(value.priority)
      ? Math.max(0, Math.trunc(value.priority))
      : 0;
    const role = typeof value.role === 'string' && value.role.trim() ? value.role.trim() : inferRole(url);
    const label = typeof value.label === 'string' ? value.label.trim() : '';
    const route: RouteCandidate = { role, priority, url, insecure: value.insecure === true };
    // 0.10.0 S5: a renamed connection's label survives a reload. Written only when non-empty, so a
    // blob without one normalizes to the same object shape the pre-0.10.0 build produced.
    if (label) route.label = label;
    out.push(route);
  }
  return out;
}

/** The candidate list in force: the stored list, or one derived from a legacy `baseUrl`. */
export function effectiveRoutes(settings: { baseUrl: string; routes?: RouteCandidate[] }): RouteCandidate[] {
  const stored = normalizeRoutes(settings.routes ?? []);
  if (stored.length) return stored;
  return routesFromBaseUrl(settings.baseUrl);
}

/** A new candidate appended below everything else, with the lowest priority in the list. */
export function nextRoute(routes: RouteCandidate[], url: string): RouteCandidate {
  const priority = routes.reduce((max, route) => Math.max(max, route.priority), -1) + 1;
  const clean = normalizeRouteUrl(url);
  return { role: inferRole(clean), priority, url: clean, insecure: false };
}

/** Re-number to 0..n-1 in current visual order, so the list can't drift into huge gaps. */
export function renumberRoutes(routes: RouteCandidate[]): RouteCandidate[] {
  return orderRoutes(routes).map((route, index) => ({ ...route, priority: index }));
}

export function moveRoute(routes: RouteCandidate[], index: number, delta: number): RouteCandidate[] {
  const ordered = orderRoutes(routes);
  const target = index + delta;
  if (index < 0 || index >= ordered.length || target < 0 || target >= ordered.length) return ordered;
  const swapped = [...ordered];
  const [item] = swapped.splice(index, 1);
  swapped.splice(target, 0, item);
  return swapped.map((route, position) => ({ ...route, priority: position }));
}
