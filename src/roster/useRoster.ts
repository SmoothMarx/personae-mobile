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

  const configured = Boolean(settings.baseUrl.trim()) && Boolean(settings.apiKey);
  const loadToken = useRef(0);

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
      }),
    [contacts, lastSeen, loaded, prefs, recents, runs, search],
  );

  const allSessions = useMemo(() => [...recents, ...runs, ...Object.values(loaded).flat()], [recents, runs, loaded]);

  // The 'No group' label comes from the string table, so a language switch must recompute it.
  const language = useLanguage();
  const groups = useMemo(
    () => groupsFor(prefs.sections, model.rows, (row) => row.name, t.roster.groups.ungrouped),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model.rows, prefs.sections, language],
  );

  const listRows = useMemo<RosterListRow[]>(() => {
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
        for (const session of sessions) {
          out.push({ kind: 'session', key: `session:${session.profile}:${session.id}`, model: session, automatic: false });
        }
        if (!searching && row.automatic.length) {
          for (const run of sessionRowModels(row.automatic, allSessions, prefs.colours)) {
            out.push({ kind: 'session', key: `run:${run.profile}:${run.id}`, model: run, automatic: true });
          }
        }
      }
    }
    return out;
  }, [allSessions, groups, prefs.colours, prefs.sections, query]);

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
    matches: model.matches,
    searching,
    query,
    setQuery,
    sections: sectionModel,
    sectionActions: sections,
    prefs,
    avatarUrls,
    lastSeen,
    notice: notice_,
    clearNotice,
    openSession,
    openProfile,
    toggleProfile,
    refresh,
    createSession,
    renameSession,
    archiveSession,
    deleteSession,
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
