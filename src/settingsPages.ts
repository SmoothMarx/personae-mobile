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

import { t } from './i18n';

export type SettingsPageId = 'index' | 'agent' | 'notifications' | 'gateway' | 'advanced';

/** What happens to this row's settings when the other client edits theirs. */
export type PreferenceScope = 'portable' | 'device-local' | 'mixed';

/**
 * The string-table keys a page's title and help sentence live under (`t.settings.pages.*`). Kept as
 * literal unions so the table is indexed statically — a typo is a compile error, not a blank row.
 */
export type SettingsPageTitleKey = 'agentTitle' | 'notificationsTitle' | 'gatewayTitle' | 'advancedTitle';
export type SettingsPageHelpKey = 'agentHelp' | 'notificationsHelp' | 'gatewayHelp' | 'advancedHelp';

export type SettingsPageRow = {
  /** The sub-page this row opens. `index` is the page you are already on. */
  id: Exclude<SettingsPageId, 'index'>;
  /** A key into the string table, resolved by the screen (`t.settings.pages.*`). */
  title: SettingsPageTitleKey;
  /** One sentence saying what is inside. Never a bare noun. */
  help: SettingsPageHelpKey;
  /**
   * Whether the row sits UNDER the previous row (the user's "sibling row under Agent Preferences").
   *
   * **ADJACENCY METADATA ONLY (changed in 0.9.1 S1).** It says *where the row belongs in the reading
   * order*; it is read by `siblingBelow` and asserted by the suite. It is **not** a visual modifier any
   * more: until 0.9.1 it also indented the row and pulled it up, which is the offset the user saw on
   * Notifications. See `pageRowStyleKeys` — a row's style modifiers come from there, and that function
   * returns none for every row. **Do not reintroduce the indent.**
   */
  sibling: boolean;
  scope: PreferenceScope;
  /** The row renders only when this is true, so the Advanced row can be gated (it always is, today). */
  always: boolean;
};

/**
 * The index, in order. **Notifications is a sibling of Agent Preferences** — it is not a top-bar
 * destination of its own, and it is not a sixth icon: it lives inside Settings, one row under the
 * preferences it belongs with.
 *
 * 0.9.1 S3: **Advanced is no longer an index row.** the user, 2026-10-13: *"The 'advanced' page should be
 * inside the 'Gateway Settings'."* It moved, with its contents byte-for-byte unchanged, into
 * `SUBPAGE_ROWS.gateway` below.
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
];

/**
 * 0.9.1 S3 — the rows drawn INSIDE a sub-page. Today exactly one: **Advanced, inside Gateway Settings**.
 *
 * It is the same `SettingsPageRow` shape the index uses, so the row is rendered by the same code and
 * carries the same scope chip, title and help sentence — a move, not a rewrite. The advanced page's
 * CONTENTS were not touched: connection type, address, key, routes, tailnet internals, status and the
 * log are what 0.9.0 shipped. Its scope stays `device-local`, which is right: it holds the address,
 * the key and this device's routes.
 *
 * Being here (rather than gone) is what the suite is asked to prove: the index has no advanced row,
 * Gateway Settings has exactly one row that opens it, and `parentPage('advanced') === 'gateway'` (S2),
 * so the single header arrow returns here.
 */
export const SUBPAGE_ROWS: Partial<Record<SettingsPageId, readonly SettingsPageRow[]>> = {
  gateway: [
    {
      id: 'advanced',
      title: 'advancedTitle',
      help: 'advancedHelp',
      sibling: false,
      scope: 'device-local',
      always: true,
    },
  ],
};

/** The rows a sub-page draws, in order. Empty for a page that has none. */
export function subPageRows(id: SettingsPageId): SettingsPageRow[] {
  return (SUBPAGE_ROWS[id] ?? []).filter((row) => row.always);
}


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
  const row = findPageRow(page);
  return row ? row.scope : 'device-local';
}

/**
 * The rows a phone with no stored settings should still show — the regression guard for "promoting
 * Settings to a page must not delete anything". Every id here is one the index must render.
 */
export function visiblePageIds(): Exclude<SettingsPageId, 'index'>[] {
  return settingsRows().map((row) => row.id);
}

/**
 * The row that sits under another one. **Adjacency only** (0.9.1 S1): the screen no longer indents
 * anything from this, and must not — see `pageRowStyleKeys`. What it still states, as a fact the suite
 * checks, is the reading order: Notifications sits directly under Agent Preferences.
 */
export function siblingBelow(id: Exclude<SettingsPageId, 'index'>): Exclude<SettingsPageId, 'index'> | null {
  const index = SETTINGS_PAGE_ROWS.findIndex((row) => row.id === id);
  if (index <= 0) return null;
  const row = SETTINGS_PAGE_ROWS[index];
  return row.sibling ? SETTINGS_PAGE_ROWS[index - 1].id : null;
}

// ─────────────────────────────── S1 (0.9.1): every index row looks the same ──

/**
 * the user, 2026-10-13: *"Notifications is offset from the rest of the rows. Fix it."* The offset was
 * real and had one cause: 0.9.0 applied `styles.pageRowSibling`
 * (`{ marginLeft: space.lg, marginTop: -space.sm + 2 }`) to the single row whose `sibling` flag is
 * true, so Notifications was indented and pulled up while the other rows were not.
 *
 * The fix is a MOVE, not a new flag: the style modifiers a row contributes are decided HERE, by the
 * plan, and this function returns **none for every row** — so the rows are geometrically identical and
 * the screen has nothing to derive an indent from.
 *
 * `sibling` and `siblingBelow` are deliberately KEPT (see both docstrings): the adjacency they state is
 * still true and still asserted. It simply stopped being a visual modifier. **A future reader must not
 * move that indent back in here** — the suite names this function and fails if a row's modifiers can
 * move a row off its neighbours' geometry (`keysAreGeometricallyPlain` below).
 */
export function pageRowStyleKeys(_row: SettingsPageRow): string[] {
  return [];
}

/** A style key that would move a row off its neighbours' geometry. The guard, as a predicate. */
const OFFSET_STYLE_KEY = /margin|padding|left|right|indent|offset|translate/i;

/**
 * The exact modifier 0.9.0 used to indent Notifications, kept by NAME so a re-introduction is caught
 * even if it is renamed out of the positional vocabulary (`pageRowSibling` carries no `margin`, so the
 * regex above would not see it). This list is the regression, written down.
 */
export const BANNED_ROW_STYLE_KEYS: readonly string[] = ['pageRowSibling'];

/** Would these modifier keys break the "every row is laid out identically" promise? */
export function keysAreGeometricallyPlain(keys: readonly string[]): boolean {
  return !keys.some((key) => OFFSET_STYLE_KEY.test(key) || BANNED_ROW_STYLE_KEYS.includes(key));
}

/** The whole S1 claim for one row, as a question a test can ask. */
export function rowIsGeometricallyPlain(row: SettingsPageRow): boolean {
  return keysAreGeometricallyPlain(pageRowStyleKeys(row));
}

// ──────────────────────────── S2 (0.9.1): ONE back control, in the header, walking this plan ──

/**
 * Where the single back control goes from each page.
 *
 * the user, 2026-10-13: *"the back arrow should be the top, the UI should not introduce a new one."* 0.9.0
 * drew TWO: the Stack header's arrow, and a `backRow` in the body of every sub-page hard-wired to
 * `setPage('index')`. The body one could only ever reach the index — so "back" from Advanced skipped
 * Gateway Settings, which is where Advanced is about to live (S3).
 *
 * `index: null` means **leave Settings**: the roster sits behind this route, which is what the header
 * arrow has always done on the index. Every sub-page names its own parent. As data, so the header
 * arrow, Android's hardware back and the suite all read ONE fact.
 */
export const SETTINGS_PAGE_PARENT: Record<SettingsPageId, SettingsPageId | null> = {
  index: null,
  agent: 'index',
  notifications: 'index',
  gateway: 'index',
  advanced: 'gateway',
};

/** The page a back tap goes to, or `null` when it leaves Settings for the roster. */
export function parentPage(id: SettingsPageId): SettingsPageId | null {
  return SETTINGS_PAGE_PARENT[id] ?? null;
}

/** What one back tap does. The header arrow and Android's hardware back BOTH read this. */
export type BackOutcome = { kind: 'page'; page: SettingsPageId } | { kind: 'leave' };

export function backFrom(id: SettingsPageId): BackOutcome {
  const parent = parentPage(id);
  return parent === null ? { kind: 'leave' } : { kind: 'page', page: parent };
}

/** The row that draws a page, wherever it is drawn: the index, or inside a sub-page (S3). */
export function findPageRow(id: SettingsPageId): SettingsPageRow | null {
  const onIndex = SETTINGS_PAGE_ROWS.find((row) => row.id === id);
  if (onIndex) return onIndex;
  for (const rows of Object.values(SUBPAGE_ROWS)) {
    const found = (rows ?? []).find((row) => row.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * The title the top bar shows for a page. The index shows the page's own title (`pagesTitle`); every
 * other page shows its row's title — so the bar says where you are, and it is resolved LIVE, so a
 * language switch follows it (`t` is a view over the current table).
 */
export function pageTitle(id: SettingsPageId): string {
  if (id === 'index') return t.settings.pagesTitle;
  const row = findPageRow(id);
  return t.settings.pages[row ? row.title : 'agentTitle'];
}


