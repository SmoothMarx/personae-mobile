/**
 * The connections dropdown, as data (0.10.0 S0).
 *
 * the user, 2026-10-13: *"a dropdown that lists all created connections (both local and remote)"*, and
 * then, asked to confirm what a "connection" is: *"When I said connections, I was referring to
 * Routes"*.
 *
 * So this module is a READER, not a model: the rows the dropdown draws are exactly
 * `orderRoutes(effectiveRoutes(settings))` — the same candidates `selectRoute`/`connectThrough`
 * already use, in the same priority order, with no second storage shape, no "server" entity and no
 * credential per row. A route that an older build stored is a row here; a route this build has never
 * heard of (a `wireguard` role, say) is a row here too.
 *
 * WHY DATA AND NOT JSX: `app/settings.tsx` cannot be rendered on this host (no device, no renderer),
 * so "the dropdown lists the routes and nothing else, in priority order" would otherwise be an
 * unverifiable claim about JSX. As a plan it is a fact the suite checks, and the screen derives its
 * rows from `connectionRows()` instead of from ad-hoc mapping — the convention `src/settingsPages.ts`
 * set for 0.9.0.
 *
 * The one word this module owns is the KIND label: the two styled roles get the nouns the user uses for
 * them (**Local** and **Remote**), and every other role keeps `roleLabel()`'s own name — so a role
 * nobody enumerated still renders as something, never as a blank row.
 */

import { t } from '../i18n';
import { effectiveRoutes, orderRoutes, roleLabel, type RouteCandidate } from '../routes';
import type { Settings } from '../settings';

/** One row of the dropdown: a route, plus the two strings the row draws. */
export type ConnectionRow = {
  /** The route itself. The row is a VIEW of it — nothing is copied into a second shape. */
  route: RouteCandidate;
  /** Position in the drawn order, which is the priority order (`orderRoutes`). */
  index: number;
  /** `Local` / `Remote` for the two styled roles, else the role's own name. */
  kind: string;
  /** The role's own label from `roleLabel` — kept beside `kind` so an unlisted role is never blank. */
  role: string;
  /** Origin only, as stored (no trailing slash). */
  url: string;
};

/**
 * The noun for a role in the dropdown.
 *
 * `lan` → Local and `tailscale` → Remote are the user's own words for the two kinds of connection he
 * asked to prioritise; every other role (including `public`, and anything a future build invents)
 * falls through to `roleLabel()`, which is the open-string rule `src/routes.ts` documents.
 */
export function connectionKind(role: string): string {
  if (role === 'lan') return t.settings.gwKindLocal;
  if (role === 'tailscale') return t.settings.gwKindRemote;
  return roleLabel(role);
}

/**
 * What the row's main label says: the kind noun. A route the user renamed (0.10.0 S5) says its own
 * name instead — the address stays visible under it either way.
 */
export function connectionLabel(route: RouteCandidate): string {
  const label = (route.label ?? '').trim();
  return label || connectionKind(route.role);
}

/**
 * The rows the dropdown draws, in order.
 *
 * A fresh install with neither `routes` nor `baseUrl` yields **zero** rows (the screen then draws the
 * empty state that offers the wizard); a legacy install with only a `baseUrl` yields exactly one,
 * because `effectiveRoutes` derives it (`src/routes.ts:302`).
 */
export function connectionRows(settings: Settings): ConnectionRow[] {
  return orderRoutes(effectiveRoutes(settings)).map((route, index) => ({
    route,
    index,
    kind: connectionKind(route.role),
    role: roleLabel(route.role),
    url: route.url,
  }));
}

/** The row drawn for one route, by address. Used to keep the selection pointing at a real row. */
export function rowForUrl(rows: ConnectionRow[], url: string): ConnectionRow | null {
  return rows.find((row) => row.url === url) ?? null;
}

/**
 * Which row is selected after a delete (0.10.1 S5).
 *
 * the user, 2026-10-13: *"The user should be able to remove the route they created."* The panel that
 * hosts the new verb — Connection Status — describes the **selected** row, so removing one has to
 * re-derive the selection from what the delete left behind. `selectedIndex - 1` is the obvious-looking
 * answer and it is wrong twice over: it points at the wrong row when the deleted row sat BELOW the
 * selection, and it points past the end when the deleted row was the last one.
 *
 * The honest answer comes from the patch `deleteRoute` returns: the newly ACTIVE route
 * (`patch.baseUrl`) is the row to select, and `-1` — nothing selected, and the status block then
 * draws `t.settings.gwPickOne` — is what an emptied list gets.
 *
 * It lives HERE, beside `connectionRows()`, because UI state is not testable on this host: the suite
 * can pin a pure function, not a `useState`.
 */
export function selectionAfterDelete(rows: ConnectionRow[], baseUrl: string): number {
  const wanted = String(baseUrl ?? '');
  if (!wanted) return -1;
  const row = rowForUrl(rows, wanted);
  return row ? row.index : -1;
}
