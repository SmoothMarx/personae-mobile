/**
 * Roster — every profile as a contact, then that profile's sessions (GET /api/sessions).
 *
 * Layout order is deliberate and is a specification (pedro-app-defaults): one control row on one
 * baseline with fixed widths so nothing wraps, contacts as pills, sessions grouped by day, newest
 * first, 25 per page with the page label always visible.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createApi, type HermesApi, type HermesSession } from '../src/api/client';
import { ApiError, normalizeError } from '../src/api/errors';
import { xhrTransport } from '../src/api/transport';
import { useActiveUrl, useConnectivity } from '../src/ConnectivityContext';
import { ConnectivityBanner } from '../src/ConnectivityBanner';
import { t } from '../src/i18n';
import { contactsOf, countNew, groupByDay, pageLabel, paginate, probeFromHealth, statusColor, toRow, type Contact, type Probe, type RowGroup } from '../src/logic/roster';
import { settingsForRoute } from '../src/settings';
import { loadLastSeen, saveLastSeen } from '../src/settingsStore';
import { useSettings } from '../src/SettingsContext';
import { colors, font, radius, space } from '../src/theme';

type LoadState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  sessions: HermesSession[];
  error: ApiError | null;
  loadedAt: number | null;
};

const EMPTY_STATE: LoadState = { status: 'idle', sessions: [], error: null, loadedAt: null };

export default function RosterScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { settings, ready } = useSettings();
  const activeUrl = useActiveUrl();
  const { diagnostic, busy, recheck } = useConnectivity();

  const contacts = useMemo(() => contactsOf(settings), [settings]);
  const [profile, setProfile] = useState('');
  const [state, setState] = useState<LoadState>(EMPTY_STATE);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [page, setPage] = useState(1);
  const [newCounts, setNewCounts] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  const lastSeen = useRef<Record<string, number>>({});
  // The client keeps speaking in terms of ONE origin; which candidate that is was decided by the
  // connectivity layer, and it changes when the network does.
  const api: HermesApi = useMemo(
    () => createApi(settingsForRoute(settings, activeUrl), { transport: xhrTransport }),
    [settings, activeUrl],
  );

  const configured = Boolean(settings.baseUrl.trim()) && Boolean(settings.apiKey);

  useEffect(() => {
    loadLastSeen().then((map) => {
      lastSeen.current = map;
    });
  }, []);

  const load = useCallback(
    async (which: string, options?: { silent?: boolean }) => {
      if (!configured) {
        setState({ status: 'ready', sessions: [], error: null, loadedAt: Date.now() });
        return;
      }
      if (!options?.silent) setState((prev) => ({ ...prev, status: 'loading', error: null }));
      try {
        const response = await api.listSessions(which, 100);
        const sessions = Array.isArray(response.data) ? response.data : [];
        // The count is computed against the PREVIOUS visit, so the badge stays visible for the whole
        // visit instead of vanishing the moment the list is loaded.
        const previous = lastSeen.current[which] ?? 0;
        const fresh = countNew(sessions, previous);
        setNewCounts((prev) => ({ ...prev, [which]: fresh }));
        setState({ status: 'ready', sessions, error: null, loadedAt: Date.now() });
        setPage(1);
        const next = { ...lastSeen.current, [which]: Date.now() };
        lastSeen.current = next;
        void saveLastSeen(next);
      } catch (error) {
        setState({ status: 'error', sessions: [], error: normalizeError(error), loadedAt: Date.now() });
      }
    },
    [api, configured],
  );

  const probeProfiles = useCallback(async () => {
    if (!settings.baseUrl.trim()) return;
    const next: Record<string, Probe> = {};
    for (const contact of contacts) {
      try {
        const health = await api.health(contact.profile);
        next[contact.profile || 'default'] = probeFromHealth(health);
      } catch (error) {
        next[contact.profile || 'default'] = probeFromHealth(null, error);
      }
    }
    setProbes(next);
  }, [api, contacts, settings.baseUrl]);

  useEffect(() => {
    if (!ready) return;
    void load(profile);
  }, [ready, profile, load]);

  useEffect(() => {
    if (!ready) return;
    void probeProfiles();
  }, [ready, probeProfiles]);

  const groups: RowGroup[] = useMemo(
    () => groupByDay(state.sessions.map((session) => toRow(session, lastSeen.current[profile] ?? 0))),
    [state.sessions, profile],
  );
  const flatRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const current = useMemo(() => paginate(flatRows, page), [flatRows, page]);

  // One page of rows, with the day header repeated at the top of every page it covers.
  const sections = useMemo(() => {
    const visible = new Set(current.items.map((row) => row.id));
    return groups
      .map((group) => ({ key: group.key, label: group.label, rows: group.rows.filter((row) => visible.has(row.id)) }))
      .filter((group) => group.rows.length > 0);
  }, [groups, current.items]);

  const onRefresh = useCallback(async () => {
    await Promise.all([load(profile, { silent: true }), probeProfiles()]);
  }, [load, profile, probeProfiles]);

  const openThread = useCallback(
    (session: HermesSession) => {
      router.push({ pathname: '/thread/[id]', params: { id: session.id, profile } });
    },
    [profile, router],
  );

  const createSession = useCallback(
    async (title: string) => {
      setCreatingBusy(true);
      setCreateError(null);
      try {
        const created = await api.createSession(title, profile);
        setNewTitle('');
        setCreating(false);
        await load(profile, { silent: true });
        if (created?.session?.id) openThread(created.session);
      } catch (error) {
        setCreateError(normalizeError(error));
      } finally {
        setCreatingBusy(false);
      }
    },
    [api, load, openThread, profile],
  );

  const confirmCreate = useCallback(
    (contact: Contact) => {
      Alert.alert(
        t.roster.newSession,
        `${contact.label}: ${t.roster.newSessionPlaceholder}`,
        [
          { text: t.roster.cancel, style: 'cancel' },
          { text: t.roster.create, onPress: () => void createSession('') },
        ],
      );
    },
    [createSession],
  );

  const renderContact = (contact: Contact) => {
    const key = contact.profile || 'default';
    const probe = probes[key] ?? { status: 'unknown' as const };
    const selected = contact.profile === profile;
    const count = newCounts[contact.profile] ?? 0;
    return (
      <Pressable
        key={key}
        onPress={() => setProfile(contact.profile)}
        onLongPress={() => confirmCreate(contact)}
        style={[styles.contact, selected && styles.contactSelected]}
      >
        <View style={[styles.dot, { backgroundColor: statusColor(probe.status, colors) }]} />
        <Text style={[styles.contactLabel, selected && styles.contactLabelSelected]} numberOfLines={1}>
          {contact.label}
        </Text>
        {count > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{count}</Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  const renderRow = ({ item }: { item: RowGroup['rows'][number] }) => (
    <Pressable
      onPress={() => router.push({ pathname: '/thread/[id]', params: { id: item.id, profile } })}
      onLongPress={() => confirmCreate(contacts.find((c) => c.profile === profile) as Contact)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{item.initial}</Text>
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {item.isNew ? <View style={styles.newPill}><Text style={styles.newPillText}>{t.roster.newTag}</Text></View> : null}
        </View>
        {item.preview ? (
          <Text style={styles.rowPreview} numberOfLines={2}>
            {item.preview}
          </Text>
        ) : null}
        <Text style={styles.rowMeta} numberOfLines={1}>
          {[item.model, item.count ? t.roster.messages(Number(item.count)) : ''].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <Text style={styles.rowAge} numberOfLines={1}>
        {item.age || item.date}
      </Text>
    </Pressable>
  );

  const listHeader = (
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {t.roster.title}
        </Text>
        <Pressable
          onPress={() => setCreating((value) => !value)}
          style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}
        >
          <Text style={styles.headerButtonText}>{t.roster.newSession}</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}
        >
          <Text style={styles.headerIconText}>⚙</Text>
        </Pressable>
      </View>

      <ConnectivityBanner
        diagnostic={diagnostic}
        busy={busy}
        onRecheck={recheck}
        onOpenSettings={() => router.push('/settings')}
      />

      {creating ? (
        <View style={styles.composerCard}>
          <TextInput
            value={newTitle}
            onChangeText={setNewTitle}
            placeholder={t.roster.newSessionPlaceholder}
            placeholderTextColor={colors.faint}
            style={styles.input}
            autoFocus
            editable={!creatingBusy}
          />
          <View style={styles.composerActions}>
            <Pressable
              disabled={creatingBusy}
              onPress={() => void createSession(newTitle)}
              style={({ pressed }) => [styles.primary, pressed && styles.pressed, creatingBusy && styles.disabled]}
            >
              <Text style={styles.primaryText}>{creatingBusy ? t.loading : t.roster.create}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setCreating(false);
                setNewTitle('');
                setCreateError(null);
              }}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>{t.roster.cancel}</Text>
            </Pressable>
          </View>
          {createError ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{createError.message}</Text>
              {createError.technical ? <Text style={styles.errorDetail}>{createError.technical}</Text> : null}
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.contactsRow}>
        {contacts.map(renderContact)}
        <View style={styles.contactsSpacer} />
      </View>
    </View>
  );

  if (!configured) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        {listHeader}
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

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <FlatList
        data={current.items}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={listHeader}
        renderItem={renderRow}
        refreshControl={<RefreshControl refreshing={state.status === 'loading'} onRefresh={onRefresh} tintColor={colors.muted} />}
        ListEmptyComponent={
          state.status === 'loading' ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.emptyBody}>{t.loading}</Text>
            </View>
          ) : state.status === 'error' && state.error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{state.error.message}</Text>
              {state.error.technical ? <Text style={styles.errorDetail}>{state.error.technical}</Text> : null}
              <Pressable onPress={() => void load(profile)} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
                <Text style={styles.primaryText}>{t.retry}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.centered}>
              <Text style={styles.emptyTitle}>{t.roster.emptyTitle}</Text>
              <Text style={styles.emptyBody}>{t.roster.emptyBody}</Text>
            </View>
          )
        }
        ListFooterComponent={
          <View>
            {pageLabel(current) ? (
              <View style={styles.pager}>
                <Pressable
                  disabled={current.page <= 1}
                  onPress={() => setPage((value) => Math.max(1, value - 1))}
                  style={({ pressed }) => [styles.pagerButton, pressed && styles.pressed, current.page <= 1 && styles.disabled]}
                >
                  <Text style={styles.pagerText}>{t.roster.prev}</Text>
                </Pressable>
                <Text style={styles.pagerLabel}>{pageLabel(current)}</Text>
                <Pressable
                  disabled={current.page >= current.totalPages}
                  onPress={() => setPage((value) => Math.min(current.totalPages, value + 1))}
                  style={({ pressed }) => [styles.pagerButton, pressed && styles.pressed, current.page >= current.totalPages && styles.disabled]}
                >
                  <Text style={styles.pagerText}>{t.roster.next}</Text>
                </Pressable>
              </View>
            ) : null}
            {state.error && state.sessions.length > 0 ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorText}>{state.error.message}</Text>
                <Text style={styles.errorDetail}>{t.retry}</Text>
              </View>
            ) : null}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  headerTitle: { flex: 1, color: colors.text, fontSize: font.large, fontWeight: '700' },
  headerButton: {
    width: 104,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.panelAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButtonText: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
  headerIcon: {
    width: 40,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.panelAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconText: { color: colors.text, fontSize: font.title },
  contactsRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingBottom: space.sm, gap: space.sm },
  contactsSpacer: { width: space.md },
  contact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  contactSelected: { borderColor: colors.accent, backgroundColor: colors.panelAlt },
  contactLabel: { color: colors.muted, fontSize: font.small, fontWeight: '600' },
  contactLabelSelected: { color: colors.text },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.accentText, fontSize: 11, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.panel },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.panelAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  rowBody: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowTitle: { color: colors.text, fontSize: font.body, fontWeight: '600', flexShrink: 1 },
  newPill: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, backgroundColor: colors.accent },
  newPillText: { color: colors.accentText, fontSize: 10, fontWeight: '700' },
  rowPreview: { color: colors.muted, fontSize: font.small },
  rowMeta: { color: colors.faint, fontSize: 11 },
  rowAge: { color: colors.faint, fontSize: 11, width: 92, textAlign: 'right' },
  composerCard: {
    marginHorizontal: space.md,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    gap: space.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  composerActions: { flexDirection: 'row', gap: space.sm },
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
  secondary: {
    height: 40,
    minWidth: 100,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: colors.muted, fontWeight: '600', fontSize: font.body },
  centered: { alignItems: 'center', gap: space.sm, padding: space.xl },
  emptyTitle: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  emptyBody: { color: colors.muted, fontSize: font.body, textAlign: 'center' },
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
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.md, gap: space.sm },
  pagerButton: {
    height: 36,
    minWidth: 92,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pagerText: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  pagerLabel: { color: colors.muted, fontSize: font.small },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
