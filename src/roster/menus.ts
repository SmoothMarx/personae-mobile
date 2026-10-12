/**
 * The long-press menus (R8) — mobile's answer to the plugin's right-click.
 *
 * The desktop pane's rule is "the same verbs in each menu, narrowed to what makes sense on the thing
 * you clicked" (README "The menus"). Keeping the inventory here — as data, not as JSX — is what
 * makes it testable: an action that quietly disappears is a failing test rather than a surprise on
 * a phone. The screen renders these; it does not invent them.
 *
 * Destructive verbs are marked, and only ONE of them exists per noun:
 *   profile → archive all (nothing is deleted)
 *   session → delete (the only irreversible verb in the whole roster)
 */

export type MenuEntry = {
  key: string;
  label: string;
  icon: string;
  destructive?: boolean;
};

export type ProfileMenuInput = {
  label: string;
  hidden: boolean;
  canRename: boolean;
  canArchiveAll: boolean;
  sections: { id: string; name: string }[];
  currentSectionId: string;
};

/** Profile verbs: new session, rename, colour, file into a group, hide, sort, archive all. */
export function profileMenuEntries(input: ProfileMenuInput): MenuEntry[] {
  const entries: MenuEntry[] = [
    { key: 'new-session', label: 'newSession', icon: 'add' },
    { key: 'rename', label: 'rename', icon: 'create-outline' },
    { key: 'colour', label: 'colour', icon: 'color-palette-outline' },
    { key: 'group', label: 'group', icon: 'folder-outline' },
    { key: 'sort', label: 'sort', icon: 'swap-vertical-outline' },
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
  /** 0.9.0 C — is this session already in a group? The verb flips. */
  inGroup?: boolean;
};

/** Session verbs: open, rename, colour, group, archive, copy id. */
export function sessionMenuEntries(input: SessionMenuInput): MenuEntry[] {
  return [
    { key: 'open', label: 'open', icon: 'chatbubble-ellipses-outline' },
    { key: 'rename', label: 'rename', icon: 'create-outline' },
    { key: 'colour', label: 'sessionColour', icon: 'color-palette-outline' },
    // 0.9.0 C — filing, and only filing: the picker is the same sheet's child, as the colour is.
    // "New session group" sits beside the two filing verbs, exactly as the desktop's Group submenu
    // holds `New session group` + `Move to group`.
    { key: 'new-session-group', label: 'newSessionGroup', icon: 'add-circle-outline' },
    input.inGroup
      ? { key: 'remove-from-group', label: 'removeFromGroup', icon: 'folder-open-outline' }
      : { key: 'file-into-group', label: 'fileIntoGroup', icon: 'folder-outline' },
    { key: 'archive', label: 'archive', icon: 'archive-outline' },
    { key: 'copy-id', label: 'copyId', icon: 'copy-outline' },
    { key: 'delete', label: 'deleteSession', icon: 'trash-outline', destructive: true },
  ];
}

/** Profile-group verbs. Deleting a section is offered, and it never touches a session. */
export function sectionMenuEntries(): MenuEntry[] {
  return [
    { key: 'rename-section', label: 'rename', icon: 'create-outline' },
    { key: 'delete-section', label: 'delete', icon: 'trash-outline', destructive: true },
  ];
}

// ────────────────────────────────── 0.9.0 C: SESSION groups ──

/**
 * The session-group heading's verbs. A DIFFERENT noun from `sectionMenuEntries` above (that one
 * renames/deletes a group of PROFILES), and the two are deliberately separate functions so a change
 * to one can never silently move to the other.
 *
 * Deleting is offered and is destructive in appearance only in the sense that the GROUP goes: the
 * rule the desktop settled ("deleting a group never deletes sessions") is structural in
 * `src/logic/sessionGroups.ts`, which cannot reach a session at all.
 */
export function sessionGroupMenuEntries(): MenuEntry[] {
  return [
    { key: 'rename-session-group', label: 'rename', icon: 'create-outline' },
    { key: 'delete-session-group', label: 'deleteGroup', icon: 'trash-outline', destructive: true },
  ];
}

/** Sort modes, as menu entries, for the profile's "Ordenar" sub-menu. */
export function sortEntries(): MenuEntry[] {
  return [
    { key: 'sort-activity', label: 'sortActivity', icon: 'time-outline' },
    { key: 'sort-name', label: 'sortName', icon: 'text-outline' },
    { key: 'sort-sessions', label: 'sortSessions', icon: 'list-outline' },
  ];
}
