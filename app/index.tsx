/**
 * Roster — the plugin's own main view, on the phone (0.5.0).
 *
 * 0.4.0 drew a flat session feed with a horizontal profile-chip scroller: one `Principal` pill and a
 * list of cron-job runs, with no profiles, no expansion, no search and no groups. This is the other
 * shape, the one the reference plugin actually has
 * (`hermes-desktop-plugins/personae/`: README "The rail", `plugin.js`):
 *
 *   * a **vertical roster**, one row per profile: face, name, a preview of its latest session, age,
 *     status light, unread count — no chip scroller anywhere;
 *   * tapping a row **expands its sessions underneath it** (a per-profile set: several may be open);
 *   * the feed is **`recents`, never cron** — job runs live under their own profile, marked;
 *   * **named groups** with collapsible headers and an implicit ungrouped section;
 *   * a **search bar** that filters profiles *and* sessions, and reveals a hit under its profile;
 *   * **colour that fills**, **status lights**, and **long-press menus** in place of right-click.
 *
 * It decides nothing: `useRoster` turns the pure modules into data and this file draws it. Splitting
 * the screen out of `app/index.tsx`'s 627 lines was part of the brief; the pieces live in
 * `src/roster/`.
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { ConnectivityBanner } from '../src/ConnectivityBanner';
import type { Diagnostic } from '../src/ConnectivityContext';
import { normalizeError } from '../src/api/errors';
import { t, useLanguage } from '../src/i18n';
import { monogramFor } from '../src/logic/avatars';
import type { SortMode } from '../src/logic/sections';
import {
  ActionSheet,
  ProfileRow,
  PromptSheet,
  SearchBar,
  SectionHeader,
  SessionRow,
  SwatchPicker,
} from '../src/roster/components';
import { profileMenuEntries, sectionMenuEntries, sessionMenuEntries, sortEntries } from '../src/roster/menus';
import { useRoster, type RosterListRow } from '../src/roster/useRoster';
import { colors, font, radius, space } from '../src/theme';

type MenuState =
  | { kind: 'none' }
  | { kind: 'profile'; name: string; label: string }
  | { kind: 'session'; profile: string; id: string; title: string }
  | { kind: 'section'; id: string; name: string };

type PromptMode = 'none' | 'group' | 'group-rename' | 'profile-label' | 'session-title' | 'new-session';

export default function RosterScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const roster = useRoster();
  // Re-render (and refresh the list cells) when the interface language changes.
  const language = useLanguage();

  const [menu, setMenu] = useState<MenuState>({ kind: 'none' });
  const [colourFor, setColourFor] = useState<{ kind: 'profile' | 'session'; profile: string; sessionId?: string } | null>(null);
  const [filing, setFiling] = useState<{ profile: string; label: string } | null>(null);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [prompt, setPrompt] = useState<PromptMode>('none');
  const [promptValue, setPromptValue] = useState('');
  const pendingProfile = useRef<string | null>(null);
  const pendingSession = useRef<{ profile: string; id: string } | null>(null);
  const pendingSection = useRef<string | null>(null);

  const { notice, clearNotice } = roster;
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clearNotice, 4000);
    return () => clearTimeout(timer);
  }, [notice, clearNotice]);

  /** One resolver for every verb key the menus emit — no string is ever shown raw. */
  const menuLabel = useCallback((key: string): string => {
    switch (key) {
      case 'newSession':
        return t.roster.menu.newSession;
      case 'rename':
        return t.roster.menu.rename;
      case 'colour':
        return t.roster.menu.colour;
      case 'group':
        return t.roster.menu.group;
      case 'sort':
        return t.roster.menu.sort;
      case 'sortActivity':
        return t.roster.menu.sortActivity;
      case 'sortName':
        return t.roster.menu.sortName;
      case 'sortSessions':
        return t.roster.menu.sortSessions;
      case 'copyId':
        return t.roster.menu.copyId;
      case 'hide':
        return t.roster.menu.hide;
      case 'unhide':
        return t.roster.menu.unhide;
      case 'archiveAll':
        return t.roster.menu.archiveAll;
      case 'open':
        return t.roster.menu.open;
      case 'sessionColour':
        return t.roster.menu.sessionColour;
      case 'archive':
        return t.roster.menu.archive;
      case 'deleteSession':
        return t.roster.menu.deleteSession;
      case 'rename-section':
        return t.roster.groups.rename;
      case 'delete-section':
        return t.roster.groups.delete;
      default:
        return key;
    }
  }, []);

  const closeMenu = useCallback(() => {
    setMenu({ kind: 'none' });
    setColourFor(null);
    setFiling(null);
  }, []);

  const openMenu = useCallback((state: MenuState) => {
    setColourFor(null);
    setFiling(null);
    setMenu(state);
  }, []);

  const askFor = useCallback((mode: PromptMode, value: string) => {
    setPromptValue(value);
    setPrompt(mode);
  }, []);

  /**
   * F7. A `/api/profiles` that fails on a surface that HAS profiles is shown as the connectivity
   * banner carrying the REAL error. 0.4.0 swallowed it and fell back to a single synthetic
   * `Principal` contact, which made "no profiles" and "not connected" look identical.
   */
  const contactDiagnostic = useMemo<Diagnostic | null>(() => {
    if (!roster.contactError) return null;
    return {
      ...roster.diagnostic,
      stage: 'failed',
      gatewayAnswering: false,
      message: `${t.roster.profileErrorTitle}: ${normalizeError(roster.contactError).message}`,
    };
  }, [roster.contactError, roster.diagnostic]);

  const renderItem = useCallback(
    ({ item }: { item: RosterListRow }) => {
      if (item.kind === 'section') {
        return (
          <SectionHeader
            name={item.name}
            count={item.count}
            collapsed={item.collapsed}
            canManage={!item.implicit}
            onToggle={() => roster.sectionActions.toggle(item.id)}
            onMenu={() => openMenu({ kind: 'section', id: item.id, name: item.name })}
          />
        );
      }
      if (item.kind === 'empty') {
        return (
          <View style={styles.emptyGroup}>
            <Text style={styles.emptyGroupText}>{t.roster.groups.empty}</Text>
          </View>
        );
      }
      if (item.kind === 'profile') {
        const row = item.row;
        return (
          <ProfileRow
            row={row}
            avatarUrl={roster.avatarUrls[row.name] ?? null}
            monogram={monogramFor(row.name, row.label)}
            actionLabel={row.sessions[0]?.snippet ?? ''}
            onToggle={() => roster.toggleProfile(row.name)}
            onOpenLast={() => {
              const first = row.sessions[0];
              if (first) roster.openSession(row.name, first.sessionId, first.snippet);
            }}
            onMenu={() => openMenu({ kind: 'profile', name: row.name, label: row.label })}
          />
        );
      }
      return (
        <SessionRow
          model={item.model}
          automatic={item.automatic}
          onOpen={() => roster.openSession(item.model.profile, item.model.id, item.model.title)}
          onMenu={() =>
            openMenu({ kind: 'session', profile: item.model.profile, id: item.model.id, title: item.model.title })
          }
        />
      );
    },
    [openMenu, roster],
  );

  const openSessions = roster.model.rows.filter((row) => row.expanded);

  const header = (
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>{t.roster.title}</Text>
        <Pressable
          onPress={() => askFor('group', '')}
          accessibilityRole="button"
          accessibilityLabel={t.roster.groups.new}
          style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}
        >
          <Ionicons name="folder-outline" size={16} color={colors.text} />
        </Pressable>
        {/* One control, two states: it opens everything when nothing is open, and closes the open
            set otherwise. A separate pair would be two buttons for one idea. */}
        <Pressable
          onPress={() => {
            if (openSessions.length) {
              for (const row of openSessions) roster.toggleProfile(row.name);
            } else {
              for (const row of roster.model.rows) roster.openProfile(row.name);
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={openSessions.length ? t.roster.collapseAll : t.roster.expandAll}
          style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}
        >
          <Ionicons name={openSessions.length ? 'contract-outline' : 'expand-outline'} size={16} color={colors.text} />
        </Pressable>
        <Pressable
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          accessibilityLabel={t.a11y.settings}
          style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}
        >
          <Ionicons name="settings-outline" size={16} color={colors.text} />
        </Pressable>
      </View>

      <SearchBar
        value={roster.query}
        onChange={roster.setQuery}
        onClear={() => roster.setQuery('')}
        busy={roster.searching}
      />

      {contactDiagnostic ? (
        <View style={styles.bannerWrap}>
          <ConnectivityBanner
            diagnostic={contactDiagnostic}
            busy={roster.connectivityBusy}
            onRecheck={roster.recheck}
            onOpenSettings={() => router.push('/settings')}
          />
          <Text style={styles.bannerBody}>{t.roster.profileErrorBody}</Text>
        </View>
      ) : (
        <ConnectivityBanner
          diagnostic={roster.diagnostic}
          busy={roster.connectivityBusy}
          onRecheck={roster.recheck}
          onOpenSettings={() => router.push('/settings')}
        />
      )}

      {/* The :9222 surface has no /api/profiles at all — say so, because that is exactly the state a
          0.4.0 upgrade lands in when its stored credential is the old key. */}
      {!roster.fromServer && !roster.contactError && roster.configured ? (
        <Text style={styles.help}>{t.roster.surfaceNoProfiles}</Text>
      ) : null}

      {roster.query.trim() ? (
        <Text style={styles.help}>
          {roster.matches ? t.roster.searchResults(roster.matches) : t.roster.searchEmpty}
          {roster.searching ? ` · ${t.loading}` : ''}
        </Text>
      ) : null}
    </View>
  );

  if (!roster.ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.help}>{t.loading}</Text>
      </View>
    );
  }

  if (!roster.configured) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        {header}
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>{t.roster.notConfiguredTitle}</Text>
          <Text style={styles.emptyBody}>{t.roster.notConfiguredBody}</Text>
          <Pressable onPress={() => router.push('/settings')} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Text style={styles.primaryText}>{t.roster.openSettings}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const profileMenu = menu.kind === 'profile' ? menu : null;
  const sessionMenu = menu.kind === 'session' ? menu : null;
  const sectionMenu = menu.kind === 'section' ? menu : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <FlatList
        data={roster.listRows}
        keyExtractor={(item) => item.key}
        ListHeaderComponent={header}
        renderItem={renderItem}
        extraData={language}
        removeClippedSubviews
        initialNumToRender={14}
        windowSize={9}
        refreshControl={
          <RefreshControl refreshing={roster.refreshing} onRefresh={() => void roster.refresh()} tintColor={colors.muted} />
        }
        ListEmptyComponent={
          roster.loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.help}>{t.loading}</Text>
            </View>
          ) : roster.feedError ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{roster.feedError.message}</Text>
              {roster.feedError.technical ? <Text style={styles.errorDetail}>{roster.feedError.technical}</Text> : null}
              <Pressable onPress={() => void roster.refresh()} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
                <Text style={styles.primaryText}>{t.retry}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.centered}>
              <Text style={styles.emptyTitle}>{roster.query.trim() ? t.roster.searchEmpty : t.roster.emptyTitle}</Text>
              <Text style={styles.emptyBody}>{t.roster.emptyBody}</Text>
            </View>
          )
        }
        ListFooterComponent={
          <View style={styles.footer}>
            {roster.model.automaticSeen ? (
              <Text style={styles.help}>
                {t.roster.automaticCount(roster.model.automaticSeen)} · {t.roster.automaticHelp}
              </Text>
            ) : null}
            {roster.notice ? <Text style={styles.notice}>{roster.notice}</Text> : null}
          </View>
        }
      />

      {/* ── the profile menu ─────────────────────────────────────────────────── */}
      <ActionSheet
        visible={Boolean(profileMenu)}
        title={profileMenu?.label ?? ''}
        entries={
          profileMenu
            ? profileMenuEntries({
                label: profileMenu.label,
                hidden: roster.prefs.hidden.includes(profileMenu.name),
                canRename: true,
                canArchiveAll: true,
                sections: roster.sections.sections,
                currentSectionId: roster.sections.members[profileMenu.name] ?? '',
              })
            : []
        }
        labelOf={menuLabel}
        onClose={closeMenu}
        onPick={(key: string) => {
          const target = profileMenu;
          if (!target) return;
          switch (key) {
            case 'new-session':
              closeMenu();
              pendingProfile.current = target.name;
              askFor('new-session', '');
              break;
            case 'rename':
              closeMenu();
              pendingProfile.current = target.name;
              askFor('profile-label', target.label);
              break;
            case 'colour':
              setFiling(null);
              setColourFor({ kind: 'profile', profile: target.name });
              break;
            case 'group':
              setColourFor(null);
              setFiling({ profile: target.name, label: target.label });
              break;
            case 'sort':
              closeMenu();
              setSortSheetOpen(true);
              break;
            case 'copy-id':
              void Clipboard.setStringAsync(target.name);
              closeMenu();
              break;
            case 'hide':
              roster.hide(target.name);
              closeMenu();
              break;
            case 'archive-all':
              Alert.alert(t.roster.menu.archiveAll, t.roster.menu.archiveAllConfirm(target.label), [
                { text: t.roster.menu.cancel, style: 'cancel' },
                { text: t.roster.menu.archiveAll, onPress: () => void roster.archiveAll(target.name) },
              ]);
              closeMenu();
              break;
            default:
              closeMenu();
          }
        }}
      >
        {colourFor && colourFor.kind === 'profile' ? (
          <SwatchPicker
            value={roster.prefs.colours.profiles[colourFor.profile] ?? null}
            onPick={(colour) => {
              roster.setColour(colourFor.profile, colour);
              closeMenu();
            }}
          />
        ) : null}
        {filing ? (
          <View>
            <Text style={styles.sheetSection}>{t.roster.groups.help}</Text>
            <Pressable
              onPress={() => {
                roster.fileInto([filing.profile], null);
                closeMenu();
              }}
              style={({ pressed }) => [styles.sheetRow, pressed && styles.rowPressed]}
            >
              <Ionicons name="ban-outline" size={18} color={colors.text} />
              <Text style={styles.sheetLabel}>{t.roster.groups.ungrouped}</Text>
            </Pressable>
            {roster.sections.sections.map((section) => (
              <Pressable
                key={section.id}
                onPress={() => {
                  roster.fileInto([filing.profile], section.id);
                  closeMenu();
                }}
                style={({ pressed }) => [styles.sheetRow, pressed && styles.rowPressed]}
              >
                <Ionicons name="folder-outline" size={18} color={colors.text} />
                <Text style={styles.sheetLabel}>{t.roster.groups.assignment(section.name)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ActionSheet>

      {/* ── the session menu ─────────────────────────────────────────────────── */}
      <ActionSheet
        visible={Boolean(sessionMenu)}
        title={sessionMenu?.title ?? ''}
        entries={sessionMenu ? sessionMenuEntries({ title: sessionMenu.title, colour: null }) : []}
        labelOf={menuLabel}
        onClose={closeMenu}
        onPick={(key: string) => {
          const target = sessionMenu;
          if (!target) return;
          switch (key) {
            case 'open':
              roster.openSession(target.profile, target.id, target.title);
              closeMenu();
              break;
            case 'rename':
              closeMenu();
              pendingSession.current = { profile: target.profile, id: target.id };
              askFor('session-title', target.title);
              break;
            case 'colour':
              setColourFor({ kind: 'session', profile: target.profile, sessionId: target.id });
              break;
            case 'archive':
              void roster.archiveSession(target.profile, target.id);
              closeMenu();
              break;
            case 'copy-id':
              void Clipboard.setStringAsync(target.id);
              closeMenu();
              break;
            case 'delete':
              Alert.alert(t.roster.menu.deleteSession, t.roster.menu.deleteSessionConfirm(target.title), [
                { text: t.roster.menu.cancel, style: 'cancel' },
                {
                  text: t.roster.menu.deleteSession,
                  style: 'destructive',
                  onPress: () => void roster.deleteSession(target.profile, target.id),
                },
              ]);
              closeMenu();
              break;
            default:
              closeMenu();
          }
        }}
      >
        {colourFor && colourFor.kind === 'session' ? (
          <SwatchPicker
            value={roster.prefs.colours.sessions[colourFor.profile]?.[colourFor.sessionId ?? ''] ?? null}
            onPick={(colour) => {
              roster.setColour(colourFor.profile, colour, colourFor.sessionId);
              closeMenu();
            }}
          />
        ) : null}
      </ActionSheet>

      {/* ── the group menu — deleting a group never touches a session ─────────── */}
      <ActionSheet
        visible={Boolean(sectionMenu)}
        title={sectionMenu?.name ?? ''}
        entries={sectionMenu ? sectionMenuEntries() : []}
        labelOf={menuLabel}
        onClose={closeMenu}
        onPick={(key: string) => {
          const target = sectionMenu;
          if (!target) return;
          if (key === 'rename-section') {
            closeMenu();
            pendingSection.current = target.id;
            askFor('group-rename', target.name);
          } else if (key === 'delete-section') {
            Alert.alert(t.roster.groups.delete, t.roster.groups.deleteConfirm(target.name), [
              { text: t.roster.menu.cancel, style: 'cancel' },
              {
                text: t.roster.groups.delete,
                style: 'destructive',
                onPress: () => roster.sectionActions.remove(target.id),
              },
            ]);
            closeMenu();
          } else {
            closeMenu();
          }
        }}
      />

      <ActionSheet
        visible={sortSheetOpen}
        title={t.roster.menu.sort}
        entries={sortEntries()}
        labelOf={menuLabel}
        onClose={() => setSortSheetOpen(false)}
        onPick={(key: string) => {
          const mode: SortMode = key === 'sort-name' ? 'name' : key === 'sort-sessions' ? 'sessions' : 'activity';
          roster.sectionActions.setSort('all', mode);
          setSortSheetOpen(false);
        }}
      />

      <PromptSheet
        visible={prompt !== 'none'}
        title={promptTitle(prompt)}
        placeholder={prompt === 'group' || prompt === 'group-rename' ? t.roster.groups.namePlaceholder : t.roster.newSessionPlaceholder}
        value={promptValue}
        onChangeText={setPromptValue}
        submitLabel={prompt === 'group' ? t.roster.groups.create : t.roster.menu.rename}
        onClose={() => {
          setPrompt('none');
          pendingSection.current = null;
        }}
        onSubmit={() => {
          const value = promptValue.trim();
          if (prompt === 'group') {
            if (value) roster.sectionActions.create(value);
          } else if (prompt === 'group-rename' && pendingSection.current) {
            if (value) roster.sectionActions.rename(pendingSection.current, value);
          } else if (prompt === 'profile-label' && pendingProfile.current) {
            roster.label(pendingProfile.current, value || null);
          } else if (prompt === 'session-title' && pendingSession.current) {
            if (value) void roster.renameSession(pendingSession.current.profile, pendingSession.current.id, value);
          } else if (prompt === 'new-session' && pendingProfile.current) {
            void roster.createSession(pendingProfile.current, value);
          }
          setPrompt('none');
          pendingSection.current = null;
        }}
      />
    </View>
  );
}

function promptTitle(mode: PromptMode): string {
  if (mode === 'group') return t.roster.groups.new;
  if (mode === 'group-rename') return t.roster.groups.rename;
  if (mode === 'profile-label') return `${t.roster.menu.rename} · ${t.roster.menu.localOnly}`;
  if (mode === 'session-title') return t.roster.menu.renamePrompt;
  return t.roster.menu.newSession;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centered: { alignItems: 'center', gap: space.sm, padding: space.xl },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  headerTitle: { flex: 1, color: colors.text, fontSize: font.large, fontWeight: '700' },
  headerIcon: {
    width: 38,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.panelAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerWrap: { gap: 2, paddingBottom: space.sm },
  bannerBody: { color: colors.faint, fontSize: font.small, paddingHorizontal: space.md },
  help: { color: colors.faint, fontSize: font.small, paddingHorizontal: space.md, paddingBottom: space.xs },
  emptyGroup: { paddingHorizontal: space.md, paddingBottom: space.md },
  emptyGroupText: { color: colors.faint, fontSize: font.small, fontStyle: 'italic' },
  footer: { padding: space.md, gap: space.sm },
  notice: { color: colors.green, fontSize: font.small },
  errorCard: {
    margin: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.red,
    backgroundColor: '#2a1416',
    gap: space.sm,
  },
  errorText: { color: '#ffd7d3', fontSize: font.body, fontWeight: '600' },
  errorDetail: { color: '#f0a8a2', fontSize: font.small },
  emptyTitle: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  emptyBody: { color: colors.muted, fontSize: font.body, textAlign: 'center' },
  primary: {
    height: 40,
    minWidth: 120,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.accentText, fontWeight: '700', fontSize: font.body },
  sheetSection: { color: colors.faint, fontSize: font.small, paddingVertical: space.sm },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, borderRadius: radius.sm },
  sheetLabel: { color: colors.text, fontSize: font.body, flex: 1 },
  rowPressed: { backgroundColor: colors.panelAlt },
  pressed: { opacity: 0.8 },
});
