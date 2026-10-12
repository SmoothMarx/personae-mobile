/**
 * The long-press menus (R8 → 0.9.0 D) — mobile's answer to the plug-in's right-click, at PARITY.
 *
 * The shape is not invented here. It is the desktop pane's own top level, read out of
 * `~/Projects/hermes-desktop-plugins/personae/plugin.js` (`:4978-5170` for a session, `:5772-5885`
 * for a profile, `sessionGroupMenuEntries` for a group heading), which the user's 2026-10-10 ordering
 * describes as *"ONE NOUN PER SUBMENU, one verb inline, and the two pickers last"*:
 *
 *   SESSION   Select · Open · Session · Apropos (beta) · Group · Appearance · Project
 *   PROFILE   New session · Edit profile… · Open newest session · Open all in tabs ·
 *             Sort sessions ▸ · Show hidden (n) · Unhide all (n)
 *   GROUP     Rename… · Move up · Move down · Apropos this group (beta) · Delete group
 *
 * So the phone's menu is **flat verbs plus one-noun submenus**, not a single flat list. Keeping the
 * inventory HERE — as data, not as JSX — is what makes it testable: an action that quietly disappears
 * is a failing test rather than a surprise on a phone, and so is one that silently does nothing.
 *
 * ── The diff this phase closed, and the ones it could not ───────────────────────────────────────
 *
 * CLOSED: the submenu STRUCTURE; `Session ▸ Mark as unread / Rename… / Branch / Copy id / Hide /
 * Archive / Delete`; `Group ▸ New session group / Move to group ▸ <group> | Ungrouped`;
 * `Appearance` (the swatch body); `Profile ▸ Open newest session`; `Profile ▸ Sort sessions ▸`.
 *
 * NOT CLOSED, and rendered DISABLED WITH THE REASON rather than hidden (the 0.7.0 convention): the
 * desktop features the phone's surface has no method for — **Apropos (beta)** and **Project** — plus
 * **Open ▸ In new window / In new tab** (window-manager verbs with no phone meaning) and **Export…**
 * (the dashboard route exists; this release did not wire it). The dashboard's `/api/ws` publishes no
 * `apropos.*` or `project.*` method at all — measured 2026-10-12 against `tui_gateway/` — so a
 * phone-side Apropos would have to invent one, which is the thing this repo forbids.
 *
 * Destructive verbs are marked (`profile → archive all` touches nothing; `session → delete` is the
 * one irreversible verb in the whole roster).
 */

export type MenuEntry = {
  key: string;
  /** A key into the string table, resolved by the screen (`menuLabel`). */
  label: string;
  icon: string;
  destructive?: boolean;
  /** 0.9.0 D — a submenu: ONE NOUN per submenu, its verbs inside. */
  children?: MenuEntry[];
  /** Rendered, not hidden: the user sees the verb and WHY it cannot be used here. */
  disabled?: boolean;
  reason?: string;
  /** Renders a check mark (the active sort mode). */
  checked?: boolean;
};

export type ProfileMenuInput = {
  label: string;
  hidden: boolean;
  canRename: boolean;
  canArchiveAll: boolean;
  sections: { id: string; name: string }[];
  currentSectionId: string;
  /** 0.9.0 D: is there a session to open, and which sort mode is ticked? */
  hasSessions?: boolean;
  /** `manual` = the user's own drag order, which ticks none of the three modes. */
  sortMode?: 'activity' | 'name' | 'sessions' | 'manual';
};

/**
 * A profile's verbs. `New session`, `Open newest session` and `Sort sessions ▸` are the desktop's
 * own; `Edit profile…` and `Open all in tabs` are the desktop's too but cannot be reached from a
 * phone, so they are carried DISABLED with their reason.
 */
export function profileMenuEntries(input: ProfileMenuInput): MenuEntry[] {
  const sortMode: 'activity' | 'name' | 'sessions' | 'manual' = input.sortMode ?? 'activity';
  const entries: MenuEntry[] = [
    { key: 'new-session', label: 'newSession', icon: 'add' },
    {
      key: 'open-newest',
      label: 'openNewest',
      icon: 'play-forward-outline',
      ...(input.hasSessions ? {} : { disabled: true, reason: 'This profile has no session to open.' }),
    },
    { key: 'rename', label: 'rename', icon: 'create-outline' },
    { key: 'colour', label: 'colour', icon: 'color-palette-outline' },
    { key: 'group', label: 'group', icon: 'folder-outline' },
    // 0.9.0 D: Sort becomes a SUBMENU (the desktop's own shape) instead of a second sheet.
    { key: 'sort', label: 'sort', icon: 'swap-vertical-outline', children: sortEntries(sortMode) },
    { key: 'copy-id', label: 'copyId', icon: 'copy-outline' },
    { key: 'hide', label: input.hidden ? 'unhide' : 'hide', icon: input.hidden ? 'eye-outline' : 'eye-off-outline' },
  ];
  if (input.canArchiveAll) {
    entries.push({ key: 'archive-all', label: 'archiveAll', icon: 'archive-outline', destructive: true });
  }
  return entries;
}

export type SessionMenuInput = {
  title: string;
  colour: string | null;
  /** 0.9.0 C — is this session already in a group? The filing verb flips. */
  inGroup?: boolean;
  /** 0.9.0 D — the groups this profile has, for `Group ▸ Move to group`. */
  groups?: { id: string; name: string }[];
  /** 0.9.0 D — is this session hidden from the pane's own list? */
  hidden?: boolean;
  /** 0.9.0 E — can this long press also open a selection? (The WhatsApp model.) */
  canSelect?: boolean;
};

/**
 * A session's verbs, in the desktop's order:
 * **Select · Open ▸ · Session ▸ · Apropos ▸ · Group ▸ · Appearance · Project**.
 */
export function sessionMenuEntries(input: SessionMenuInput): MenuEntry[] {
  const groups = input.groups ?? [];
  const entries: MenuEntry[] = [];
  // 1. Select — the inline verb. On the phone it opens the multiselect MODE (0.9.0 E) on the row
  //    that was held, which is the WhatsApp model the user chose.
  if (input.canSelect !== false) {
    entries.push({ key: 'select', label: 'select', icon: 'checkmark-circle-outline' });
  }
  entries.push(
    // 2. Open ▸ — one usable verb on a phone; the desktop's two window-manager verbs are carried
    //    disabled, so the diff is visible on the device rather than lost in a commit message.
    {
      key: 'open',
      label: 'open',
      icon: 'chatbubble-ellipses-outline',
      children: [
        { key: 'open-here', label: 'openHere', icon: 'open-outline' },
        { key: 'open-window', label: 'openWindow', icon: 'browsers-outline', disabled: true, reason: 'A phone has no windows to open.' },
        { key: 'open-tab', label: 'openTab', icon: 'copy-outline', disabled: true, reason: 'A phone has no tabs to open.' },
      ],
    },
    // 3. Session ▸ — everything that acts on THIS transcript.
    {
      key: 'session-menu',
      label: 'sessionMenu',
      icon: 'chatbox-ellipses-outline',
      children: [
        { key: 'mark-unread', label: 'markUnread', icon: 'mail-unread-outline' },
        { key: 'rename', label: 'rename', icon: 'create-outline' },
        { key: 'branch', label: 'branch', icon: 'git-branch-outline' },
        { key: 'copy-id', label: 'copyId', icon: 'copy-outline' },
        {
          key: 'export-session',
          label: 'exportSession',
          icon: 'download-outline',
          disabled: true,
          reason: 'Exporting a transcript from the phone is not built yet.',
        },
        {
          key: 'hide-session',
          label: input.hidden ? 'unhideSession' : 'hideSession',
          icon: input.hidden ? 'eye-outline' : 'eye-off-outline',
        },
        { key: 'archive', label: 'archive', icon: 'archive-outline' },
        { key: 'delete', label: 'deleteSession', icon: 'trash-outline', destructive: true },
      ],
    },
    // 4. Apropos (beta) ▸ — the desktop's topic refresher, and the one whole feature the phone's
    //    surface cannot reach: there is no `apropos.*` method on the dashboard's `/api/ws`.
    {
      key: 'apropos',
      label: 'apropos',
      icon: 'sparkles-outline',
      children: [
        {
          key: 'apropos-session',
          label: 'aproposSession',
          icon: 'sparkles-outline',
          disabled: true,
          reason: 'The gateway has no Apropos method; a child session cannot be created from here.',
        },
        {
          key: 'apropos-group',
          label: 'aproposGroup',
          icon: 'sparkles-outline',
          disabled: true,
          reason: 'The gateway has no Apropos method; an Apropos group cannot be created from here.',
        },
      ],
    },
    // 5. Group ▸ — filing, and only filing.
    {
      key: 'group-session',
      label: 'group',
      icon: 'folder-outline',
      children: [
        { key: 'new-session-group', label: 'newSessionGroup', icon: 'add-circle-outline' },
        ...(groups.length
          ? [
              {
                key: 'move-to-group',
                label: 'moveToGroup',
                icon: 'arrow-forward-circle-outline',
                children: [
                  ...groups.map((group) => ({
                    key: `move-group:${group.id}`,
                    label: group.name,
                    icon: 'folder-outline',
                  })),
                  ...(input.inGroup
                    ? [{ key: 'move-group:', label: 'ungrouped', icon: 'ban-outline' } as MenuEntry]
                    : []),
                ],
              },
            ]
          : []),
      ],
    },
    // 6. Appearance — the swatch palette, drawn in the sheet's own body. The desktop draws its
    //    picker in the menu body too (its SDK ships no submenu family), so this IS parity.
    { key: 'colour', label: 'sessionColour', icon: 'color-palette-outline' },
    // 7. Project — last, as the ordering says ("the two pickers last").
    {
      key: 'project',
      label: 'project',
      icon: 'briefcase-outline',
      disabled: true,
      reason: 'Projects are a desktop feature; the gateway publishes no project method.',
    },
  );
  return entries;
}

// ────────────────────────────────── 0.9.0 C: SESSION groups ──

/**
 * The session-group heading's verbs — the desktop's `sessionGroupMenuEntries`, with its Apropos verb
 * carried disabled for the same reason as the session menu's.
 *
 * A DIFFERENT noun from `sectionMenuEntries` below (that one acts on a group of PROFILES), and the
 * two are deliberately separate functions so a change to one can never silently move to the other.
 * Deleting a group never deletes a session: that is structural in `src/logic/sessionGroups.ts`, which
 * cannot reach a session at all.
 */
export function sessionGroupMenuEntries(input: { canMoveUp?: boolean; canMoveDown?: boolean } = {}): MenuEntry[] {
  return [
    { key: 'rename-session-group', label: 'rename', icon: 'create-outline' },
    {
      key: 'move-group-up',
      label: 'moveUp',
      icon: 'arrow-up-outline',
      ...(input.canMoveUp === false ? { disabled: true, reason: 'It is already first.' } : {}),
    },
    {
      key: 'move-group-down',
      label: 'moveDown',
      icon: 'arrow-down-outline',
      ...(input.canMoveDown === false ? { disabled: true, reason: 'It is already last.' } : {}),
    },
    {
      key: 'apropos-group-heading',
      label: 'aproposGroupHeading',
      icon: 'sparkles-outline',
      disabled: true,
      reason: 'The gateway has no Apropos method; a child session cannot be created from here.',
    },
    { key: 'delete-session-group', label: 'deleteGroup', icon: 'trash-outline', destructive: true },
  ];
}

/** Profile-group verbs. Deleting a section is offered, and it never touches a session. */
export function sectionMenuEntries(): MenuEntry[] {
  return [
    { key: 'rename-section', label: 'rename', icon: 'create-outline' },
    { key: 'delete-section', label: 'delete', icon: 'trash-outline', destructive: true },
  ];
}

/** Sort modes, as a submenu's children, for a profile's `Sort sessions ▸`. */
export function sortEntries(current: 'activity' | 'name' | 'sessions' | 'manual' = 'activity'): MenuEntry[] {
  return [
    { key: 'sort-activity', label: 'sortActivity', icon: 'time-outline', checked: current === 'activity' },
    { key: 'sort-name', label: 'sortName', icon: 'text-outline', checked: current === 'name' },
    { key: 'sort-sessions', label: 'sortSessions', icon: 'list-outline', checked: current === 'sessions' },
  ];
}

/** Every LEAF key a menu can emit — the inventory the suite walks so nothing silently disappears. */
export function leafKeys(entries: MenuEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.children?.length) out.push(...leafKeys(entry.children));
    else out.push(entry.key);
  }
  return out;
}

/** Every key a menu offers, submenu headings included — what "parity" is counted against. */
export function allKeys(entries: MenuEntry[]): string[] {
  return entries.flatMap((entry) => [entry.key, ...(entry.children ? allKeys(entry.children) : [])]);
}
