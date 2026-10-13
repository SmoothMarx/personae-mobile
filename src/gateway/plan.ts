/**
 * Gateway Settings as a PAGE PLAN (0.10.0 S1) — the user's §3 and §4, as data.
 *
 * the user, 2026-10-13, on what the page must be, top to bottom:
 *
 *   1. *"A dropdown that lists all created connections (both local and remote) along with a status
 *      dot indicating their connectivity status."*
 *   2. *"Keep the Connection status Section, put it on the top."* — and *"Upon selection of one, the
 *      Connection status section appears, populated with information regarding the SELECTED
 *      connection."*
 *   3. *"Underneath the Connection status section will be the pills so the user can choose which type
 *      of connection to prioritize (local or remote)."*
 *   4. *"…and after that, the 'Connection Wizard' button to trigger the connection wizard."*
 *   5. *"…and the Advanced dropdown after that, which includes all granular settings."*
 *
 * WHY THIS IS DATA AND NOT JSX. `app/settings.tsx` cannot be rendered on this host (no device, no
 * renderer), so "the page draws these five things in this order" and "the status fields describe the
 * SELECTED row, not the one the engine is currently using" would otherwise be unverifiable claims
 * about JSX. As a plan they are facts the suite checks, and the screen derives its sections from
 * `gatewaySections()` instead of from an ad-hoc order — the convention `src/settingsPages.ts` set for
 * 0.9.0 and `src/settingsLayout.ts` for 0.7.0.
 *
 * ONE SECTION THE BRIEF DOES NOT NAME, and why it is still here: `link` is 0.9.1 S3's Tailscale
 * section — Log in, Choose device, the auto-connect row. the user's list is what the page must have, not
 * a licence to delete a shipped control (§1.6/§1.11: extend, never re-implement), and the tunnel row
 * is now ALSO the wizard's own row (S3.2) because §1.1.2 asks for it there. It sits between the
 * wizard button and Advanced, so all five of his are still in his relative order and Advanced is
 * still LAST, which is what his §4 says.
 */

import { formatAge } from '../format';
import { t } from '../i18n';
import { connectionKind } from './connections';
import type { GatewayStatus } from './status';
import { transportSecurityNote, type RouteCandidate } from '../routes';
import { surfaceLabel, type Surface } from '../settings';

/** The page, top to bottom. `advanced` is last, by the user's own list. */
export const GATEWAY_SECTION_IDS = ['connections', 'status', 'pills', 'wizard', 'link', 'advanced'] as const;
export type GatewaySectionId = (typeof GATEWAY_SECTION_IDS)[number];

/**
 * Every string key this plan can name. They live FLAT under `t.settings.*` because that is the one
 * group the EN-only mechanism can narrow (see `EN_ONLY_SETTINGS_KEYS` in `src/i18n.ts`) — a new
 * top-level group would have to be translated into PT to compile, and §1.4 says the PT table is left
 * in place, unextended.
 */
export type GatewayTextKey =
  | 'gwConnectionsTitle'
  | 'gwConnectionsHelp'
  | 'gwStatusTitle'
  | 'gwStatusHelp'
  | 'gwPickOne'
  | 'gwKindsTitle'
  | 'gwKindsHelp'
  | 'gwWizardButton'
  | 'gwWizardHelp'
  | 'gwFieldOrigin'
  | 'gwFieldRole'
  | 'gwFieldSecurity'
  | 'gwFieldSurface'
  | 'gwFieldServer'
  | 'gwFieldDevice'
  | 'gwFieldLastSeen'
  | 'gwUnknown'
  | 'gwNone'
  | 'gwNoDevice'
  | 'gwNever';

export type GatewaySection = {
  id: GatewaySectionId;
  /**
   * The section's heading and its one-sentence explanation. `null` for the two sections that already
   * had their own copy before this batch — `link` (0.9.1 S3's Tailscale section, `t.connectivity.*`)
   * and `advanced` (the sub-page row, `t.settings.pages.advancedHelp`) — because re-wording a shipped
   * section is not what S1 asks for. The order is this plan's; those two keep their own words.
   */
  titleKey: GatewayTextKey | null;
  helpKey: GatewayTextKey | null;
};

const SECTIONS: readonly GatewaySection[] = [
  { id: 'connections', titleKey: 'gwConnectionsTitle', helpKey: 'gwConnectionsHelp' },
  { id: 'status', titleKey: 'gwStatusTitle', helpKey: 'gwStatusHelp' },
  { id: 'pills', titleKey: 'gwKindsTitle', helpKey: 'gwKindsHelp' },
  { id: 'wizard', titleKey: 'gwWizardButton', helpKey: 'gwWizardHelp' },
  { id: 'link', titleKey: null, helpKey: null },
  { id: 'advanced', titleKey: null, helpKey: null },
];

/** The sections in the order the page draws them. */
export function gatewaySections(): GatewaySection[] {
  return SECTIONS.map((section) => ({ ...section }));
}

/** The order, as ids — the one fact the layout test reads. */
export function gatewaySectionIds(): GatewaySectionId[] {
  return gatewaySections().map((section) => section.id);
}

/**
 * What the "Connection Wizard" button DOES. Named, so "the button opens the wizard in place" is a
 * fact and not a claim about a handler: the action is `open-wizard`, never a navigation away —
 * `app/settings.tsx` sets its own `wizardOpen` state, which is the same wizard component
 * (`src/connect/Wizard.tsx`) the standalone `personae://connect` route hosts.
 */
export const WIZARD_BUTTON_ACTION = 'open-wizard' as const;
export function wizardButtonAction(): typeof WIZARD_BUTTON_ACTION {
  return WIZARD_BUTTON_ACTION;
}

// ── the Connection status section: populated from the SELECTED row ───────────────────────────────

export const STATUS_FIELD_IDS = [
  'origin',
  'role',
  'security',
  'surface',
  'server',
  'device',
  'lastSeen',
] as const;
export type StatusFieldId = (typeof STATUS_FIELD_IDS)[number];

export const STATUS_LABEL_KEY: Record<StatusFieldId, GatewayTextKey> = {
  origin: 'gwFieldOrigin',
  role: 'gwFieldRole',
  security: 'gwFieldSecurity',
  surface: 'gwFieldSurface',
  server: 'gwFieldServer',
  device: 'gwFieldDevice',
  lastSeen: 'gwFieldLastSeen',
};

export type StatusField = { id: StatusFieldId; label: string; value: string };

export type StatusInput = {
  /**
   * THE SELECTED ROW (S1 §4: "populated with information regarding the selected connection"). It is
   * deliberately NOT the route the engine chose: the two are different questions, and the panel
   * answers the one the user just asked by tapping a row.
   */
  route: RouteCandidate | null;
  surface: Surface;
  /** `null` = not asked yet, or nothing answered. Never fabricated. */
  server: GatewayStatus | null;
  device: { label: string; lastSeenMs: number | null };
  now?: number;
};

/**
 * The rows the status panel draws, in order. `route === null` (nothing configured, or the selection
 * points at a row that is gone) yields the empty state's own words rather than a blank panel.
 */
export function statusFields(input: StatusInput): StatusField[] {
  const now = input.now ?? Date.now();
  const route = input.route;
  const value = (id: StatusFieldId, text: string): StatusField => ({
    id,
    label: t.settings[STATUS_LABEL_KEY[id]],
    value: text,
  });
  return [
    value('origin', route ? route.url : t.settings.gwNone),
    value('role', route ? connectionKind(route.role) : t.settings.gwNone),
    // The honesty rule travels with the row: a raw http:// tailnet address is WireGuard-encrypted,
    // never "public plaintext" (src/routes.ts::transportSecurityNote).
    value('security', route ? transportSecurityNote(route) : t.settings.gwNone),
    value('surface', surfaceLabel(input.surface)),
    value('server', input.server ? `${input.server.version} · ${input.server.gatewayState}` : t.settings.gwUnknown),
    value('device', input.device.label.trim() || t.settings.gwNoDevice),
    value('lastSeen', input.device.label.trim() && input.device.lastSeenMs ? formatAge(input.device.lastSeenMs, now) : t.settings.gwNever),
  ];
}

// ── the pills: `preferredRouteRole`, relabelled ──────────────────────────────────────────────────

export type PillOption = { role: string | null; label: string };

/**
 * The pills the page draws, in the order it draws them: **Automatic first**, then each kind the list
 * actually holds.
 *
 * These are `preferredRouteRole` (S1 §3 / decision §3.3), not a second preference: the pin already
 * works (`selectRoute` honours it) and `pin-bypassed` is already reported out loud. The labels are the
 * connection nouns — **Local / Remote** — which is the user's own wording for the two kinds.
 *
 * **A single-kind list draws NO pills at all** (§S1: "Hide the pills when the list holds only one
 * role"): with one kind there is nothing to prefer, and a one-option control is a control that cannot
 * change anything.
 */
export function pillOptions(routes: RouteCandidate[]): PillOption[] {
  const roles = Array.from(new Set(routes.map((route) => route.role)));
  if (roles.length <= 1) return [];
  return [
    { role: null, label: t.routes.preferredAuto },
    ...roles.map((role) => ({ role, label: connectionKind(role) })),
  ];
}
