/**
 * What Settings shows, in what order, and what an "Advanced" disclosure hides (0.7.0).
 *
 * The screen is one long scroll of fields, and 0.6.1 opened with a *button* that pushed to
 * `/connect`. 0.7.0 turns that around: the Connection section IS the wizard, drawn in place, and
 * everything an ordinary user never touches moves behind a closed disclosure.
 *
 * WHY THIS IS DATA. `app/settings.tsx` cannot be rendered on this host (no device, no renderer), so
 * "the Advanced disclosure is closed by default and the internals are not on screen" would otherwise
 * be an unverifiable claim about JSX. As a plan it is a fact the test suite can check, and the screen
 * derives its rendering from `isAdvanced`/`ADVANCED_OPEN_BY_DEFAULT` rather than from ad-hoc `if`s.
 *
 * NOTHING IS DELETED, and nothing changes behaviour: every field that was on the screen in 0.6.1 is
 * still on the screen — most of them one tap away. `visibleFieldIds(false)` names exactly what a user
 * sees after a fresh install.
 */

import { WIZARD_STEP_IDS } from './connect/wizard';

export const ADVANCED_OPEN_BY_DEFAULT = false;

export type SettingsArea = 'connection' | 'tailscale' | 'sessions' | 'advanced';

export type SettingsFieldId =
  | 'connection'
  | 'language'
  | 'sessionTypes'
  | 'tailscale'
  | 'surface'
  | 'baseUrl'
  | 'apiKey'
  | 'profiles'
  | 'model'
  | 'routes'
  | 'tailscalePackage'
  | 'deadlines'
  | 'openOnFailure'
  | 'diagnostics'
  | 'testConnection'
  | 'log';

export type SettingsField = { id: SettingsFieldId; area: SettingsArea };

/**
 * In render order. The three `connection` / `language` / `tailscale` AREAS are what a user sees;
 * everything else is `advanced`.
 *
 * `tailscalePackage`, `deadlines` and `openOnFailure` are the Tailscale knobs the brief names as
 * internals ("package name and both timeout fields move under Advanced, intact"). The section itself
 * stays visible — it is Log in / Choose device / start automatically.
 */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  { id: 'connection', area: 'connection' },
  { id: 'language', area: 'connection' },
  // 0.8.0 D: the two Session-types checkboxes are a USER-facing choice, so the section stays on the
  // main screen, right after the language — not behind Advanced. "An option in settings where users
  // can check/uncheck the type of sessions they want to see" is an ask from the operator's own list.
  { id: 'sessionTypes', area: 'sessions' },
  { id: 'tailscale', area: 'tailscale' },
  { id: 'surface', area: 'advanced' },
  { id: 'baseUrl', area: 'advanced' },
  { id: 'apiKey', area: 'advanced' },
  { id: 'profiles', area: 'advanced' },
  { id: 'model', area: 'advanced' },
  { id: 'routes', area: 'advanced' },
  { id: 'tailscalePackage', area: 'advanced' },
  { id: 'deadlines', area: 'advanced' },
  { id: 'openOnFailure', area: 'advanced' },
  { id: 'diagnostics', area: 'advanced' },
  { id: 'testConnection', area: 'advanced' },
  { id: 'log', area: 'advanced' },
];

export function advancedFieldIds(): SettingsFieldId[] {
  return SETTINGS_FIELDS.filter((field) => field.area === 'advanced').map((field) => field.id);
}

/** What is on screen, in order, given whether the disclosure is open. */
export function visibleFieldIds(advancedOpen: boolean): SettingsFieldId[] {
  return SETTINGS_FIELDS.filter((field) => field.area !== 'advanced' || advancedOpen).map((field) => field.id);
}

export function isAdvanced(id: SettingsFieldId): boolean {
  return SETTINGS_FIELDS.some((field) => field.id === id && field.area === 'advanced');
}

/** The Connection section is the first thing on the screen, and it is the wizard. */
export function connectionRendersWizard(): boolean {
  return SETTINGS_FIELDS[0]?.id === 'connection' && WIZARD_STEP_IDS.length === 3;
}
