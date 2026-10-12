/**
 * Settings as a PAGE OF ROWS (0.9.0 Phase B) — the plan, as data.
 *
 * the user, 2026-10-12: *"Main page of section rows that open sub-pages — today's shape, just promoted to
 * a top-level page."* And, on where the second section lands: *"Agent Preferences (inside is the list
 * of session types to check/uncheck); Gateway Settings (inside is everything regarding connecting to
 * the gateway)."*
 *
 * WHY THIS IS DATA AND NOT JSX. `app/settings.tsx` cannot be rendered on this host (no device, no
 * renderer), so "the index has exactly these rows, in this order, and Notifications is a SIBLING of
 * Agent Preferences rather than a sixth top-bar icon" would otherwise be an unverifiable claim about
 * JSX. As a plan it is a fact the suite checks, and the screen derives its rendering from this module
 * instead of from ad-hoc conditionals — the same convention `src/settingsLayout.ts` set for 0.7.0.
 *
 * ── The split the page has to make VISIBLE (goal §5) ────────────────────────────────────────────────
 *
 * A setting is either **portable** (both clients should agree — it goes through Phase A's preference
 * document) or **device-local** (it must never leave this phone: pushing the phone's gateway address
 * over the desktop's `localhost` is how you lose a working desktop). A row that says nothing about
 * which it is reads as "synced" while quietly never syncing, so every row carries its scope.
 */

export type SettingsPageId = 'index' | 'agent' | 'notifications' | 'gateway' | 'advanced';

/** What happens to this row's settings when the other client edits theirs. */
export type PreferenceScope = 'portable' | 'device-local' | 'mixed';

export type SettingsPageRow = {
  /** The sub-page this row opens. `index` is the page you are already on. */
  id: Exclude<SettingsPageId, 'index'>;
  /** A key into the string table, resolved by the screen (`t.settings.pages.*`). */
  title: string;
  /** One sentence saying what is inside. Never a bare noun. */
  help: string;
  /** Whether the row sits UNDER the previous row (the user's "sibling row under Agent Preferences"). */
  sibling: boolean;
  scope: PreferenceScope;
  /** The row renders only when this is true, so the Advanced row can be gated (it always is, today). */
  always: boolean;
};

/**
 * The index, in order. **Notifications is a sibling of Agent Preferences** — it is not a top-bar
 * destination of its own, and it is not a sixth icon: it lives inside Settings, one row under the
 * preferences it belongs with.
 */
export const SETTINGS_PAGE_ROWS: readonly SettingsPageRow[] = [
  {
    id: 'agent',
    title: 'agentTitle',
    help: 'agentHelp',
    sibling: false,
    scope: 'portable',
    always: true,
  },
  {
    id: 'notifications',
    title: 'notificationsTitle',
    help: 'notificationsHelp',
    sibling: true,
    scope: 'mixed',
    always: true,
  },
  {
    id: 'gateway',
    title: 'gatewayTitle',
    help: 'gatewayHelp',
    sibling: false,
    scope: 'device-local',
    always: true,
  },
  {
    id: 'advanced',
    title: 'advancedTitle',
    help: 'advancedHelp',
    sibling: false,
    scope: 'device-local',
    always: true,
  },
];

export function settingsRows(): SettingsPageRow[] {
  return SETTINGS_PAGE_ROWS.filter((row) => row.always);
}

/** The key into the string table for a scope chip. Every scope has words, never a bare colour. */
export const SCOPE_LABEL_KEY: Record<PreferenceScope, string> = {
  portable: 'scopePortable',
  'device-local': 'scopeDeviceLocal',
  mixed: 'scopeMixed',
};

/**
 * The split, per setting the phone actually holds — the machine-readable half of what the page draws.
 *
 * It is deliberately keyed by the SAME ids `src/settingsLayout.ts` uses for its fields, so the two
 * plans cannot drift: a field that is on the screen but missing here fails a test.
 *
 * `portable` entries are exactly the keys the server's preference document accepts (Phase A's
 * `GET /preferences/keys`), which is the second, independent check on the same claim.
 */
export const PORTABLE_SETTING_IDS = [
  'sessionTypes', // which session types the list shows
  'notifications', // the checkpoint switches — the KINDS, not the OS permission
  'sortOrder', // display/ordering preferences (roster groups + sort)
] as const;

export const DEVICE_LOCAL_SETTING_IDS = [
  'connection', // pairing, this device's identity
  'surface', // which HTTP surface the address speaks
  'baseUrl', // the address THIS device dials (localhost vs the tailnet)
  'apiKey', // a credential never leaves the device it was issued to
  'routes', // built from this device's own network
  'model', // a per-request override, local by choice
  'tailscale', // the tunnel app on THIS OS
  'tailscalePackage',
  'deadlines', // budgets that reflect this device's network
  'openOnFailure',
  'profiles', // extra profiles served under /p/<name>/ are this device's routing choice
  'diagnostics', // a record of what this device did
  'testConnection',
  'log',
  'language', // kept local so a phone in one language cannot switch a desktop
] as const;

/**
 * The portable ids as the SERVER's preference-document key names (Phase A's `PORTABLE_KEYS`).
 * Asserted equal to the plugin's own list in the suite, so the page's promise and the document's
 * accepted keys cannot drift apart.
 */
export const PORTABLE_PREFERENCE_KEY = {
  sessionTypes: 'session-types',
  notifications: 'notifications',
  sortOrder: 'display-order',
} as const;

export type PortableSettingId = (typeof PORTABLE_SETTING_IDS)[number];
export type DeviceLocalSettingId = (typeof DEVICE_LOCAL_SETTING_IDS)[number];

const PORTABLE = new Set<string>(PORTABLE_SETTING_IDS);
const DEVICE_LOCAL = new Set<string>(DEVICE_LOCAL_SETTING_IDS);

/** Which class a setting belongs to. An id in neither list is a bug, and `unknown` says so. */
export function scopeOfSetting(id: string): PreferenceScope | 'unknown' {
  const portable = PORTABLE.has(id);
  const local = DEVICE_LOCAL.has(id);
  if (portable && local) return 'mixed';
  if (portable) return 'portable';
  if (local) return 'device-local';
  return 'unknown';
}

/**
 * The scope a ROW shows. A row whose settings are all portable says `portable`; one that mixes the two
 * classes (Notifications: the switches sync, the OS permission cannot) says `mixed` — which is the
 * honest word, and the reason the row's help text has to name the exception.
 */
export function scopeOfRow(page: Exclude<SettingsPageId, 'index'>): PreferenceScope {
  const row = SETTINGS_PAGE_ROWS.find((entry) => entry.id === page);
  return row ? row.scope : 'device-local';
}

/**
 * The rows a phone with no stored settings should still show — the regression guard for "promoting
 * Settings to a page must not delete anything". Every id here is one the index must render.
 */
export function visiblePageIds(): Exclude<SettingsPageId, 'index'>[] {
  return settingsRows().map((row) => row.id);
}

/** The row that sits under another one — used by the screen to indent, and asserted by the suite. */
export function siblingBelow(id: Exclude<SettingsPageId, 'index'>): Exclude<SettingsPageId, 'index'> | null {
  const index = SETTINGS_PAGE_ROWS.findIndex((row) => row.id === id);
  if (index <= 0) return null;
  const row = SETTINGS_PAGE_ROWS[index];
  return row.sibling ? SETTINGS_PAGE_ROWS[index - 1].id : null;
}
