/**
 * `useRoster` — the one place the roster's data comes from.
 *
 * The screen renders; this hook decides. Everything that could be got wrong about the 0.5.0 shape
 * is expressed here in terms of the pure modules (`rosterFeed`, `sections`, `lights`,
 * `rosterPrefs`), so the screen has no opinion about cron runs, groups, search or the lights.
 *
 * Load strategy (R9) — 22 profiles, 1771 sessions, and no fan-out on the first paint:
 *   1. ONE call for the profiles (`/api/profiles`);
 *   2. ONE call for the batched slices (`/api/profiles/sessions/sidebar`) — `recents` is the feed,
 *      `cron` is where the job runs live, and neither is a per-profile request;
 *   3. a lazily fetched page per profile, only when the user opens that row.
 * Avatars keep their own background probe (F1) and never block any of it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';

import type { MessageHit, ProfileInfo } from '../api/backend';
import { normalizeError, type ApiError } from '../api/errors';
import { useConnectivity } from '../ConnectivityContext';
import { log } from '../logging';
import { t, useLanguage } from '../i18n';
import { applyShared, sharedFromPrefs, useUiSync } from '../sync/useUiSync';
import { SYNC_KEYS } from '../sync/uiSync';
import { useAvatars } from '../Avatar';
import {
  EMPTY_COLOURS,
  anySessionType,
  attributeBodyHits,
  bodySearchPlan,
  buildRoster,
  mergeBodyHits,
  rosterContacts,
  searchRoster,
  sessionRowModels,
  type ColourModel,
  type FeedSession,
  type RosterProfileRow,
  type SearchResult,
  type SessionRowModel,
} from '../logic/rosterFeed';
import {
  UNASSIGNED,
  addSection,
  assignProfiles,
  deleteSection,
  groupsFor,
  isCollapsed,
  renameSection,
  toggleCollapsed as toggleSectionCollapsed,
  type SectionsModel,
  type SortMode,
} from '../logic/sections';
import {
  addGroup,
  deleteGroup,
  fileSessions,
  isGroupCollapsed,
  moveGroup,
  renameGroup,
  sessionGroupBlocks,
  toggleGroupCollapsed,
} from '../logic/sessionGroups';
import { profileSlug } from './plusMenu';
import { loadLastSeen, saveLastSeen } from '../settingsStore';
import {
  EMPTY_PREFS,
  expandAll,
  expandedNames,
  isExpanded,
  isHidden,
  labelFor,
  loadRosterPrefs,
  saveRosterPrefs,
  setProfileColour,
  setProfileLabel,
  setSessionColour,
  toggleExpanded,
  toggleHidden,
  type RosterPrefs,
} from '../rosterPrefs';
import { useBackend } from '../useBackend';
import { useSettings } from '../SettingsContext';

export type RosterListRow =
  | { kind: 'section'; key: string; id: string; name: string; count: number; collapsed: boolean; implicit: boolean }
  | { kind: 'profile'; key: string; row: RosterProfileRow }
  | { kind: 'session'; key: string; model: SessionRowModel; automatic: boolean }
  /**
   * 0.9.0 C — a user-authored SESSION group heading inside an expanded profile. A different noun
   * from `section` (which holds profiles), and the two are never collapsed into one.
   */
  | { kind: 'session-group'; key: string; profile: string; id: string; name: string; count: number; collapsed: boolean }
  | { kind: 'empty'; key: string; id: string; name: string };

const SEARCH_DEBOUNCE_MS = 320;
const LAZY_PAGE = 25;
const RECENTS_LIMIT = 60;
const RUNS_LIMIT = 20;

export function useRoster() {
  const router = useRouter();
  const { settings, ready } = useSettings();
  const { backend } = useBackend();
  const { diagnostic, busy, recheck } = useConnectivity();

  const [prefs, setPrefs] = useState<RosterPrefs>(EMPTY_PREFS);
  const [prefsReady, setPrefsReady] = useState(false);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profileError, setProfileError] = useState<unknown | null>(null);
  const [recents, setRecents] = useState<FeedSession[]>([]);
  const [runs, setRuns] = useState<FeedSession[]>([]);
  const [loaded, setLoaded] = useState<Record<string, FeedSession[]>>({});
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [feedError, setFeedError] = useState<ApiError | null>(null);
  const [query, setQuery] = useState('');
  const [sweep, setSweep] = useState<SearchResult | null>(null);
  const [bodyHits, setBodyHits] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The last refusal from POST /api/profiles, so the "+" can explain itself (0.7.0). */
  const [profileRefusal, setProfileRefusal] = useState<{ status: number; message: string } | null>(null);

  const configured = Boolean(settings.baseUrl.trim()) && Boolean(settings.apiKey);
  const loadToken = useRef(0);
  /** 0.8.0 D: the two Session-types checkboxes, and whether BOTH are off (a legal state). */
  const sessionTypes = settings.sessionTypes;
  const typesAllOff = !anySessionType(sessionTypes);

  // ── preferences (persisted behind one module, §4) ───────────────────────────
  useEffect(() => {
    let alive = true;
    void loadRosterPrefs().then((value) => {
      if (!alive) return;
      setPrefs(value);
      setPrefsReady(true);
    });
    void loadLastSeen().then((map) => {
      if (alive) setLastSeen(map);
    });
    return () => {
      alive = false;
    };
  }, []);

  // ── options sync (0.6.0): groups/sort + session colours shared with the desktop pane ──
  const { activeUrl } = useConnectivity();
  const { sync, status: syncStatus } = useUiSync({
    enabled: configured && settings.surface === 'dashboard',
    baseUrl: activeUrl || settings.baseUrl,
    token: settings.apiKey,
    prefsReady,
    prefs,
    onRemote: (key, value) =>
      setPrefs((current) => {
        const next = applyShared(current, key, value);
        void saveRosterPrefs(next);
        return next;
      }),
  });

  /** Every preference write goes through here, so persistence can never be forgotten. */
  const mutate = useCallback((change: (current: RosterPrefs) => RosterPrefs) => {
    setPrefs((current) => {
      const next = change(current);
      void saveRosterPrefs(next);
      const before = sharedFromPrefs(current);
      const after = sharedFromPrefs(next);
      for (const key of SYNC_KEYS) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) sync.current?.noteLocal(key, after[key]);
      }
      return next;
    });
  }, [sync]);

  // ── the two calls that build the roster ─────────────────────────────────────
  const loadAll = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!configured) {
        setLoading(false);
        return;
      }
      const token = loadToken.current + 1;
      loadToken.current = token;
      if (options?.silent) setRefreshing(true);
      else setLoading(true);

      // The profile list and the feed are INDEPENDENT: one failing must not blank the other.
      const profilesPromise = backend
        .profiles()
        .then((rows) => {
          if (loadToken.current !== token) return;
          setProfiles(rows);
          setProfileError(null);
        })
        .catch((error) => {
          if (loadToken.current !== token) return;
          // F7: swallowed in 0.4.0 (it fell back to a single synthetic `Principal`); now it is a
          // visible failure, in the banner AND in the export log.
          log.error('api', `GET /api/profiles → ${normalizeError(error).message}`);
          setProfiles([]);
          setProfileError(error);
        });

      const feedPromise = backend
        .sidebar('all', { recents: RECENTS_LIMIT, cron: RUNS_LIMIT })
        .then((slices) => {
          if (loadToken.current !== token) return;
          setRecents(slices.recents as FeedSession[]);
          setRuns(slices.cron as FeedSession[]);
          setFeedError(null);
          // The "new since my last visit" watermark is advanced only for the profiles we saw, so a
          // profile that was not in the page keeps its own badge.
          const stamp = Date.now();
          setLastSeen((current) => {
            const next = { ...current };
            for (const session of [...slices.recents, ...slices.cron]) {
              const name = String((session as FeedSession).profile ?? 'default');
              next[name] = stamp;
            }
            void saveLastSeen(next);
            return next;
          });
        })
        .catch((error) => {
          if (loadToken.current !== token) return;
          setFeedError(normalizeError(error));
        });

      await Promise.all([profilesPromise, feedPromise]);
      if (loadToken.current !== token) return;
      setLoading(false);
      setRefreshing(false);
    },
    [backend, configured],
  );

  useEffect(() => {
    if (!ready) return;
    void loadAll();
  }, [ready, loadAll]);

  // ── contacts: the server's rows, or the honest failure (F7) ─────────────────
  const contactsResult = useMemo(
    () => rosterContacts({ hasProfiles: backend.hasProfiles, profiles, declared: settings.profiles, error: profileError }),
    [backend.hasProfiles, profileError, profiles, settings.profiles],
  );

  const contacts = useMemo(
    () =>
      contactsResult.contacts.map((contact) => ({
        ...contact,
        label: labelFor(prefs, contact.name, contact.label),
      })),
    [contactsResult.contacts, prefs],
  );

  // ── F1: avatars land after the paint, never block it ────────────────────────
  const avatarUrls = useAvatars(
    contacts.map((contact) => ({ name: contact.name, label: contact.label, hasAvatar: contact.hasAvatar })),
    useCallback((name: string) => backend.avatar(name), [backend]),
  );

  // ── search: one sweep, then ONE batch of body requests per settled query ────
  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setSweep(null);
      setBodyHits(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      const all = [...recents, ...Object.values(loaded).flat()];
      const result = searchRoster({ needle, profiles: contacts, sessions: all, sections: prefs.sections });
      if (cancelled) return;
      setSweep(result);
      // A hit inside a profile opens it, and the row stays open (the plugin's rule).
      if (result.autoExpand.length) mutate((current) => expandAll(current, result.autoExpand));

      if (!backend.hasProfiles) {
        setSearching(false);
        return;
      }
      const plan = bodySearchPlan(contacts.map((contact) => contact.name), needle);
      setBodyHits(null);
      void Promise.all(
        plan.map((profile) =>
          backend
            .searchMessages(needle, profile, 60)
            .catch(() => [] as MessageHit[]),
        ),
      ).then((batches) => {
        if (cancelled) return;
        const flat = batches.flat();
        // The response carries only `session_id`, so each hit is attributed to a profile from the
        // feed already in hand. One that cannot be placed is counted, never guessed at.
        const { perProfile, unplaced } = attributeBodyHits(all, flat);
        setBodyHits(mergeBodyHits(result, perProfile, unplaced));
        setSearching(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, recents, loaded, contacts, prefs.sections, backend, mutate]);

  const search = bodyHits ?? sweep;

  // ── the model: rows, groups, and the sessions under each face ───────────────
  const model = useMemo(
    () =>
      buildRoster({
        contacts,
        sessions: [...recents, ...runs],
        expanded: new Set(expandedNames(prefs)),
        hidden: new Set(prefs.hidden),
        colours: prefs.colours ?? EMPTY_COLOURS,
        sections: prefs.sections,
        sort: prefs.sections.sort,
        search,
        lastSeen,
        loaded,
        perProfile: 10,
        sessionTypes,
      }),
    [contacts, lastSeen, loaded, prefs, recents, runs, search, sessionTypes],
  );

  const allSessions = useMemo(() => [...recents, ...runs, ...Object.values(loaded).flat()], [recents, runs, loaded]);

  /**
   * 0.9.0 D — is this session hidden from the pane's own list? Read off the raw feed rows, which is
   * the only place the flag exists (`SearchHit`, which the roster rows are built from, carries no
   * `hidden`).
   */
  const isSessionHidden = useCallback(
    (profile: string, id: string): boolean =>
      Boolean(
        allSessions.find(
          (session) => session.id === id && (session.profile ?? 'default') === (profile || 'default'),
        )?.hidden,
      ),
    [allSessions],
  );

  // The 'No group' label comes from the string table, so a language switch must recompute it.
  const language = useLanguage();
  const groups = useMemo(
    () => groupsFor(prefs.sections, model.rows, (row) => row.name, t.roster.groups.ungrouped),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model.rows, prefs.sections, language],
  );

  const listRows = useMemo<RosterListRow[]>(() => {
    // 0.8.0 D: both types off is a legal state, and it is NOT a blank list — the screen shows an
    // empty state that says why (see app/index.tsx). An empty list is how that state is signalled.
    if (typesAllOff) return [];
    const out: RosterListRow[] = [];
    const searching = Boolean(query.trim());
    for (const group of groups) {
      const collapsed = isCollapsed(prefs.sections, group.id);
      out.push({
        kind: 'section',
        key: `section:${group.id}`,
        id: group.id,
        name: group.name,
        count: group.rows.length,
        collapsed,
        implicit: group.implicit,
      });
      if (collapsed) continue;
      if (!group.rows.length) {
        // "An empty group explains how to fill it" — the plugin's own rule for an empty section.
        out.push({ kind: 'empty', key: `empty:${group.id}`, id: group.id, name: group.name });
        continue;
      }
      for (const row of group.rows) {
        out.push({ kind: 'profile', key: `profile:${row.name}`, row });
        if (!row.expanded) continue;
        const sessions = sessionRowModels(row.sessions, allSessions, prefs.colours);
        /**
         * 0.9.0 C — the expanded list, GROUPED. With no groups this is ONE anonymous block whose ids
         * are the recency order, i.e. exactly the flat list every earlier release drew, so a profile
         * nobody has filed anything into renders identically.
         */
        const byId = new Map(sessions.map((session) => [session.id, session]));
        const blocks = sessionGroupBlocks(sessions.map((session) => session.id), prefs.sessionGroups, row.name);
        for (const block of blocks) {
          if (block.group) {
            out.push({
              kind: 'session-group',
              key: `sg:${row.name}:${block.id}`,
              profile: row.name,
              id: block.id,
              name: block.name,
              count: block.sessionIds.length,
              collapsed: block.collapsed,
            });
            if (block.collapsed) continue;
          }
          for (const sessionId of block.sessionIds) {
            const session = byId.get(sessionId);
            if (!session) continue;
            out.push({ kind: 'session', key: `session:${session.profile}:${session.id}`, model: session, automatic: false });
          }
        }
        if (!searching && row.automatic.length) {
          for (const run of sessionRowModels(row.automatic, allSessions, prefs.colours)) {
            out.push({ kind: 'session', key: `run:${run.profile}:${run.id}`, model: run, automatic: true });
          }
        }
      }
    }
    return out;
  }, [allSessions, groups, prefs.colours, prefs.sections, prefs.sessionGroups, query, typesAllOff]);

  // ── actions ─────────────────────────────────────────────────────────────────
  const openSession = useCallback(
    (profile: string, id: string, title?: string | null) => {
      router.push({
        pathname: '/thread/[id]',
        params: { id, profile, ...(title && title.trim() ? { title } : {}) },
      });
    },
    [router],
  );

  /** R9's lazy page: the row is opened first, the page lands after. */
  const openProfile = useCallback(
    (name: string) => {
      const opening = !isExpanded(prefs, name);
      mutate((current) => toggleExpanded(current, name));
      if (!opening || loaded[name] || !backend.hasProfiles) return;
      void backend
        .profileSessions(name, LAZY_PAGE)
        .then((rows) => setLoaded((current) => ({ ...current, [name]: rows as FeedSession[] })))
        .catch(() => undefined);
    },
    [backend, loaded, mutate, prefs],
  );

  const toggleProfile = useCallback(
    (name: string) => {
      if (isExpanded(prefs, name)) mutate((current) => toggleExpanded(current, name));
      else openProfile(name);
    },
    [mutate, openProfile, prefs],
  );

  const refresh = useCallback(async () => {
    setLoaded({});
    await loadAll({ silent: true });
  }, [loadAll]);

  const createSession = useCallback(
    async (name: string, title: string) => {
      try {
        const created = await backend.createSession(title, name);
        await loadAll({ silent: true });
        if (created?.id) openSession(name, created.id, created.title ?? undefined);
      } catch (error) {
        setNotice(normalizeError(error).message);
      }
    },
    [backend, loadAll, openSession],
  );

  /**
   * 0.7.0's "New profile": POST /api/profiles, then refresh the roster so the new face appears.
   *
   * A refusal is NOT swallowed: the error is remembered (`profileRefusal`) and the "+" renders the
   * entry disabled with that reason, because a control that does nothing when tapped is the one
   * outcome the brief forbids. Returns false so the caller can keep the prompt open and say so.
   */
  const createProfile = useCallback(
    async (rawName: string) => {
      const name = profileSlug(rawName);
      if (!name) {
        setNotice(t.plus.invalidName);
        return false;
      }
      try {
        const created = await backend.createProfile({ name });
        setProfileRefusal(null);
        await loadAll({ silent: true });
        setNotice(t.plus.created(created?.name || name));
        return true;
      } catch (error) {
        const normalized = normalizeError(error);
        setProfileRefusal({ status: normalized.status ?? 0, message: normalized.message });
        setNotice(t.plus.createRefused(normalized.message));
        return false;
      }
    },
    [backend, loadAll],
  );

  const renameSession = useCallback(
    async (profile: string, id: string, title: string) => {
      try {
        await backend.rename(id, title, profile);
        await loadAll({ silent: true });
        if (loaded[profile]) setLoaded((current) => ({ ...current, [profile]: [] }));
      } catch (error) {
        setNotice(normalizeError(error).message);
      }
    },
    [backend, loadAll, loaded],
  );

  const archiveSession = useCallback(
    async (profile: string, id: string) => {
      try {
        await backend.archiveSession(id, profile);
        setRecents((current) => current.filter((session) => session.id !== id));
        setLoaded((current) => ({
          ...current,
          [profile]: (current[profile] ?? []).filter((session) => session.id !== id),
        }));
      } catch (error) {
        setNotice(normalizeError(error).message);
      }
    },
    [backend],
  );

  const deleteSession = useCallback(
    async (profile: string, id: string) => {
      try {
        await backend.deleteSession(id, profile);
        setRecents((current) => current.filter((session) => session.id !== id));
        setLoaded((current) => ({
          ...current,
          [profile]: (current[profile] ?? []).filter((session) => session.id !== id),
        }));
        setNotice(t.roster.menu.deleted);
      } catch (error) {
        setNotice(normalizeError(error).message);
      }
    },
    [backend],
  );

  /**
   * 0.9.0 D — `Session ▸ Hide from Personae / Unhide`. The pane's own view filter, never a core
   * mutation: the session keeps living, which is what makes this the reversible half of Archive.
   */
  const setHidden = useCallback(
    async (profile: string, id: string, hidden: boolean) => {
      try {
        await backend.setHidden(id, hidden, profile);
        await loadAll({ silent: true });
      } catch (error) {
        setNotice(normalizeError(error).message);
      }
    },
    [backend, loadAll],
  );

  /** 0.9.0 D — `Session ▸ Mark as unread`: the read watermark, so the row's light comes back on. */
  const markUnread = useCallback(
    async (profile: string, id: string) => {
      try {
        await backend.markUnread(id, profile);
        await loadAll({ silent: true });
      } catch (error) {
        setNotice(normalizeError(error).message);
      }
    },
    [backend, loadAll],
  );

  /** 0.9.0 D — `Session ▸ Branch`: a new session continuing this transcript, then open it. */
  const branchSession = useCallback(
    async (profile: string, id: string) => {
      try {
        const created = await backend.branch(id, profile);
        await loadAll({ silent: true });
        if (created?.id) openSession(profile, created.id, created.title ?? undefined);
        else setNotice(t.roster.menu.branchFailed);
      } catch (error) {
        setNotice(normalizeError(error).message);
      }
    },
    [backend, loadAll, openSession],
  );

  /** Archive every conversation of a profile. Archived, never deleted — and it says so. */
  const archiveAll = useCallback(
    async (name: string) => {
      const mine = [...recents, ...(loaded[name] ?? [])].filter((session) => (session.profile ?? 'default') === name);
      const results = await Promise.allSettled(mine.map((session) => backend.archiveSession(session.id, name)));
      const ids = new Set(mine.map((session) => session.id));
      setRecents((current) => current.filter((session) => !ids.has(session.id)));
      setLoaded((current) => ({ ...current, [name]: [] }));
      const failed = results.filter((result) => result.status === 'rejected').length;
      setNotice(failed ? `${failed} ${t.settings.testFail.toLowerCase()}` : t.settings.saved);
    },
    [backend, loaded, recents],
  );

  const notice_ = notice;
  const clearNotice = useCallback(() => setNotice(null), []);
  /** Say something in the roster's own notice line — how a disabled verb explains itself (0.7.0). */
  const say = useCallback((text: string) => setNotice(text), []);

  // ── preferences the menus write ─────────────────────────────────────────────
  const setColour = useCallback(
    (profile: string, colour: string | null, sessionId?: string) => {
      mutate((current) =>
        sessionId ? setSessionColour(current, profile, sessionId, colour) : setProfileColour(current, profile, colour),
      );
    },
    [mutate],
  );

  const hide = useCallback((profile: string) => mutate((current) => toggleHidden(current, profile)), [mutate]);

  const label = useCallback(
    (profile: string, value: string | null) => mutate((current) => setProfileLabel(current, profile, value)),
    [mutate],
  );

  const fileInto = useCallback(
    (profilesToFile: string[], sectionId: string | null) =>
      mutate((current) => ({ ...current, sections: assignProfiles(current.sections, profilesToFile, sectionId) })),
    [mutate],
  );

  const sections = useMemo(
    () => ({
      create: (name: string) => mutate((current) => ({ ...current, sections: addSection(current.sections, name) })),
      rename: (id: string, name: string) =>
        mutate((current) => ({ ...current, sections: renameSection(current.sections, id, name) })),
      remove: (id: string) => mutate((current) => ({ ...current, sections: deleteSection(current.sections, id) })),
      toggle: (id: string) => mutate((current) => ({ ...current, sections: toggleSectionCollapsed(current.sections, id) })),
      setSort: (scope: string, mode: SortMode) =>
        mutate((current) => ({
          ...current,
          sections: { ...current.sections, sort: { ...current.sections.sort, [scope]: mode } },
        })),
    }),
    [mutate],
  );

  const sectionModel: SectionsModel = prefs.sections;

  /**
   * 0.9.0 C — the session-group verbs, all through `mutate` so every one of them is persisted AND
   * pushed to the shared document (see `mutate`'s diff against `sharedFromPrefs`).
   */
  const sessionGroupActions = useMemo(
    () => ({
      create: (profile: string) =>
        mutate((current) => ({ ...current, sessionGroups: addGroup(current.sessionGroups, profile).state })),
      rename: (profile: string, id: string, name: string) =>
        mutate((current) => ({ ...current, sessionGroups: renameGroup(current.sessionGroups, profile, id, name) })),
      remove: (profile: string, id: string) =>
        mutate((current) => ({ ...current, sessionGroups: deleteGroup(current.sessionGroups, profile, id) })),
      toggle: (profile: string, id: string) =>
        mutate((current) => ({ ...current, sessionGroups: toggleGroupCollapsed(current.sessionGroups, profile, id) })),
      move: (profile: string, id: string, delta: number) =>
        mutate((current) => ({ ...current, sessionGroups: moveGroup(current.sessionGroups, profile, id, delta) })),
      /** File one session, or many (a multiselect batch is ONE write, so it cannot half-apply). */
      file: (profile: string, sessionIds: readonly string[], groupId: string | null) =>
        mutate((current) => ({
          ...current,
          sessionGroups: fileSessions(current.sessionGroups, profile, sessionIds, groupId),
        })),
      collapsed: (profile: string, id: string) => isGroupCollapsed(prefs.sessionGroups, profile, id),
    }),
    [mutate, prefs.sessionGroups],
  );

  return {
    ready: ready && prefsReady,
    configured,
    loading,
    refreshing,
    feedError,
    profileError,
    contactError: contactsResult.error,
    fromServer: contactsResult.fromServer,
    model,
    listRows,
    /** 0.8.0 D — the two Session-types checkboxes, and whether both are off. */
    sessionTypes,
    typesAllOff,
    matches: model.matches,
    searching,
    query,
    setQuery,
    sections: sectionModel,
    sectionActions: sections,
    /** 0.9.0 C — the session groups themselves, and the verbs that write them. */
    sessionGroups: prefs.sessionGroups,
    sessionGroupActions,
    prefs,
    /** Every profile from the server, in roster order — the "New session" picker's content. */
    contacts,
    avatarUrls,
    lastSeen,
    notice: notice_,
    clearNotice,
    say,
    openSession,
    openProfile,
    toggleProfile,
    refresh,
    createSession,
    createProfile,
    profileRefusal,
    renameSession,
    archiveSession,
    deleteSession,
    setHidden,
    isSessionHidden,
    markUnread,
    branchSession,
    archiveAll,
    setColour,
    hide,
    label,
    fileInto,
    ungroupedId: UNASSIGNED,
    diagnostic,
    connectivityBusy: busy,
    recheck,
    syncStatus,
  };
}
