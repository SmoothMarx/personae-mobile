/**
 * Settings — base URL, API key, extra profiles (the multiplex prefix) and a model override.
 *
 * Rules applied (pedro-app-defaults): single-field settings save themselves (no Save button, no
 * redundant controls); the *effective* value is always displayed next to the field; the API key
 * lives in expo-secure-store and is shown only as a redacted form unless the user asks to see it;
 * clearing the key is a destructive action that names what it affects and asks first.
 */

import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createBackend } from '../src/api/backend';
import { normalizeError } from '../src/api/errors';
import ConnectWizard from '../src/connect/Wizard';
import { peerAddress, peerRoute, peersPort, peersState, type PeerRow, type PeersResult } from '../src/logic/peers';
import { probeTcp } from '../src/native/tailscale';
import { ADVANCED_OPEN_BY_DEFAULT } from '../src/settingsLayout';
import {
  SCOPE_LABEL_KEY,
  pageRowStyleKeys,
  scopeOfRow,
  settingsRows,
  type PreferenceScope,
  type SettingsPageId,
  type SettingsPageRow,
} from '../src/settingsPages';
import { buildLogDocument, log } from '../src/logging';
import { parseErrorForDisplay } from '../src/api/display';
import { xhrTransport } from '../src/api/transport';
import { useConnectivity } from '../src/ConnectivityContext';
import { screenInsets } from '../src/insets';
import { formatTime } from '../src/format';
import { t } from '../src/i18n';
import { revokeSelf } from '../src/pairing';
import { useRouter } from 'expo-router';
import { contactsOf, probeFromHealth, statusColor, type Probe } from '../src/logic/roster';
import {
  checkBaseUrl,
  surfaceLabel,
  DEFAULT_NOTIFY,
  DEFAULT_SESSION_TYPES,
  DEFAULT_SETTINGS,
  redactKey,
  splitProfiles,
  type Settings,
} from '../src/settings';
import { anySessionType, sessionTypeChoices, type SessionType } from '../src/logic/rosterFeed';
import {
  permissionLabel,
  surfaceCapability,
  type CheckpointSession,
  type PermissionState,
  type SurfaceCapability,
} from '../src/logic/checkpoints';
import { askPermission, readPermission } from '../src/notifications';
import {
  checkRoute,
  moveRoute,
  nextRoute,
  normalizeRouteUrl,
  orderRoutes,
  roleLabel,
  transportSecurityNote,
  type RouteCandidate,
  type RouteProblem,
} from '../src/routes';
import { useSettings } from '../src/SettingsContext';
import { colors, font, radius, space } from '../src/theme';

type TestResult = { label: string; probe: Probe; ms: number | null; detail: string };

/** The sub-page title key, kept as a literal map so `t.settings.pages` is read statically typed. */
const SETTINGS_PAGE_TITLE_KEY = {
  agent: 'agentTitle',
  notifications: 'notificationsTitle',
  gateway: 'gatewayTitle',
  advanced: 'advancedTitle',
} as const;

const SETTINGS_PAGE_HELP_KEY = {
  agent: 'agentHelp',
  notifications: 'notificationsHelp',
  gateway: 'gatewayHelp',
  advanced: 'advancedHelp',
} as const;

export default function SettingsScreen() {
  const { settings, ready, savedAt, update } = useSettings();
  const router = useRouter();
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS);
  const [profilesText, setProfilesText] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);

  const { diagnostic, busy, recheck, openTailscale } = useConnectivity();
  /**
   * 0.9.0 Phase B — Settings is a PAGE OF ROWS. `index` is the main page; every other value is the
   * sub-page a row opens, drawn inside this same route so a back tap is one state change and the
   * wizard's in-progress state is never thrown away by a navigation.
   */
  const [page, setPage] = useState<SettingsPageId>('index');
  /**
   * 0.9.0 F (landscape) — this screen read no insets at all. The horizontal half matters here more
   * than on the roster (fields run the full width), so it is applied to the scroll content.
   */
  const insets = screenInsets(useSafeAreaInsets());
  const [newRoute, setNewRoute] = useState('');
  const [routeProblem, setRouteProblem] = useState<string | null>(null);
  const routeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const routes = useMemo(() => orderRoutes(form.routes), [form.routes]);

  // ── 0.7.0 — Advanced is CLOSED by default; the Connection section is the wizard ──
  const [advancedOpen, setAdvancedOpen] = useState(ADVANCED_OPEN_BY_DEFAULT);

  // ── 0.7.0 — the tailnet device picker (host endpoint, never the phone) ────────
  const [peers, setPeers] = useState<PeersResult | null>(null);
  const [peersOpen, setPeersOpen] = useState(false);
  const [peersBusy, setPeersBusy] = useState(false);
  const [peersNote, setPeersNote] = useState<string | null>(null);

  /**
   * Structural edits (add / remove / move) are discrete, so they persist immediately. Typing a URL
   * is debounced: every keystroke would otherwise restart the connect pass.
   */
  const saveRoutes = useCallback(
    (next: RouteCandidate[], delay = 0) => {
      setForm((prev) => ({ ...prev, routes: next }));
      if (routeTimer.current) clearTimeout(routeTimer.current);
      if (delay <= 0) {
        update({ routes: next });
        return;
      }
      routeTimer.current = setTimeout(() => update({ routes: next }), delay);
    },
    [update],
  );

  const addRoute = useCallback(() => {
    const url = normalizeRouteUrl(newRoute);
    if (!url) return;
    if (!checkBaseUrl(url).ok) {
      setRouteProblem(t.routes.problemBadUrl);
      return;
    }
    setRouteProblem(null);
    saveRoutes([...form.routes, nextRoute(form.routes, url)]);
    setNewRoute('');
  }, [form.routes, newRoute, saveRoutes]);

  const problemText = useCallback((problem: RouteProblem): string => {
    if (problem === 'public-http') return t.routes.problemPublicHttp;
    if (problem === 'needs-ack') return t.routes.problemNeedsAck;
    return t.routes.problemBadUrl;
  }, []);

  /**
   * 0.8.0 D — one checkbox tap. Written to the store IMMEDIATELY (single-field setting, no Save
   * button), and computed from `form` so two fast taps cannot lose one: each tap reads the value it
   * is replacing.
   */
  const setSessionType = useCallback(
    (id: SessionType, enabled: boolean) => {
      const current = form.sessionTypes ?? DEFAULT_SESSION_TYPES;
      const next = { ...current, [id]: enabled };
      setForm((prev) => ({ ...prev, sessionTypes: next }));
      update({ sessionTypes: next });
    },
    [form.sessionTypes, update],
  );

  const tri = useCallback(
    (value: boolean | null): string => (value === null ? t.connectivity.unknown : value ? t.connectivity.yes : t.connectivity.no),
    [],
  );

  useEffect(() => {
    if (!ready || hydrated.current) return;
    hydrated.current = true;
    setForm(settings);
    setProfilesText(settings.profiles.join('\n'));
  }, [ready, settings]);

  const stage = useCallback(
    (patch: Partial<Settings>, delay = 600) => {
      setForm((prev) => ({ ...prev, ...patch }));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => update(patch), delay);
    },
    [update],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (routeTimer.current) clearTimeout(routeTimer.current);
    },
    [],
  );

  const effectiveProfiles = useMemo(() => splitProfiles(profilesText), [profilesText]);
  const droppedLines = useMemo(() => {
    const typed = profilesText
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter(Boolean);
    return typed.filter((line) => !effectiveProfiles.includes(line.replace(/^\/+|\/+$/g, '')));
  }, [profilesText, effectiveProfiles]);

  const [logNote, setLogNote] = useState('');
  const [logStatus, setLogStatus] = useState<string | null>(null);

  // ── 0.8.0 H: checkpoint notifications ──────────────────────────────────────
  /**
   * The permission is READ on open and only ever REQUESTED from the master switch — a cold start
   * never prompts. The capability is measured from one probe of the connection, because "this
   * connection does not report whether a session is waiting" has to be a fact about the server, not
   * a guess (the live dashboard serves `is_active` but no `waiting` field).
   */
  const [permission, setPermission] = useState<PermissionState>('not-asked');
  const [asking, setAsking] = useState(false);
  const [capability, setCapability] = useState<SurfaceCapability>({
    waiting: false,
    finished: false,
    basis: 'is_active',
  });

  useEffect(() => {
    let alive = true;
    void readPermission().then((value) => {
      if (alive) setPermission(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  const probeCapability = useCallback(async () => {
    if (!form.baseUrl.trim() || !form.apiKey) return;
    const backend = createBackend({ ...form, profiles: effectiveProfiles });
    try {
      const slices = await backend.sidebar('all', { recents: 40, cron: 0 });
      setCapability(surfaceCapability([...(slices.recents ?? []), ...(slices.cron ?? [])] as CheckpointSession[]));
    } catch {
      /* an unreachable host leaves the switches where they are; the banner says why */
    } finally {
      backend.dispose();
    }
  }, [effectiveProfiles, form]);

  useEffect(() => {
    void probeCapability();
    // Deliberately keyed on the address and the credential: those are what change what the server
    // can answer. Re-probing on every keystroke would be a request per keystroke for decoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.baseUrl, form.apiKey, form.surface]);

  /** The master switch. Turning it ON is the one and only moment the permission is requested. */
  const toggleNotifications = useCallback(
    async (enabled: boolean) => {
      const next = { ...(form.notifications ?? DEFAULT_NOTIFY), enabled };
      setForm((prev) => ({ ...prev, notifications: next }));
      update({ notifications: next });
      if (!enabled) {
        setAsking(false);
        return;
      }
      setAsking(true);
      const state = await askPermission();
      setPermission(state);
      setAsking(false);
      void probeCapability();
    },
    [form.notifications, probeCapability, update],
  );

  const setNotifyKind = useCallback(
    (kind: 'waiting' | 'finished', enabled: boolean) => {
      const next = { ...(form.notifications ?? DEFAULT_NOTIFY), [kind]: enabled };
      setForm((prev) => ({ ...prev, notifications: next }));
      update({ notifications: next });
    },
    [form.notifications, update],
  );

  /**
   * Export log (PLAN-UI.md §9): one .txt in the cache dir, handed to the OS share sheet. Nothing is
   * uploaded. The description the user types lands at the top of the file, so a single file is
   * "log + what went wrong".
   */
  const exportLog = useCallback(async () => {
    const doc = buildLogDocument(
      {
        // Read from the embedded config instead of a literal: the log said 0.5.0 for two releases
        // while the app was 0.6.x, which is exactly the kind of thing a support log must not do.
        appVersion: String(Constants.expoConfig?.version ?? 'unknown'),
        versionCode: String(Constants.expoConfig?.android?.versionCode ?? 'unknown'),
        surface: surfaceLabel(form.surface),
        baseUrl: form.baseUrl,
        routes: form.routes.map((route, index) => ({ url: route.url, role: route.role, priority: index })),
        deviceOs: `${Platform.OS} ${String(Platform.Version)}`,
        failures: log.entries.filter((entry) => entry.level !== 'info').slice(-3).map((entry) => entry.message),
      },
      logNote,
      log.entries,
    );
    try {
      const file = new File(Paths.cache, t.settings.logFileName);
      if (file.exists) file.delete();
      file.create();
      file.write(doc);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: t.settings.logTitle });
      } else {
        await Share.share({ message: doc });
      }
      setLogStatus(t.settings.logShared);
    } catch {
      // A device without a share sheet still gets the text itself.
      try {
        await Share.share({ message: doc });
        setLogStatus(t.settings.logShared);
      } catch {
        setLogStatus(t.settings.logFailed);
      }
    }
  }, [form.baseUrl, form.routes, form.surface, logNote]);

  const urlCheck = checkBaseUrl(form.baseUrl);
  const contacts = useMemo(() => contactsOf({ ...form, profiles: effectiveProfiles }), [form, effectiveProfiles]);

  /**
   * F7: the pair the user must get right, and whether it is right — shown in one line.
   * `Dashboard (:9119)` + a bearer is the requirement; a valid URL and a stored key are what make it
   * satisfiable, and the last "Testar ligação" result is what says whether it actually worked.
   */
  const surfaceOk = form.surface === 'dashboard' && Boolean(form.apiKey) && urlCheck.ok;
  const checkResult = results.length ? results[0] : null;

  const testConnection = useCallback(async () => {
    setTesting(true);
    setResults([]);
    // Through the Backend, so the test follows the selected surface: the dashboard answers for every
    // profile in one call (the honest test is "can I read the roster with this credential"), while
    // the api_server is probed per declared contact.
    const backend = createBackend({ ...form, profiles: effectiveProfiles });
    const collected: TestResult[] = [];
    if (backend.hasProfiles) {
      const started = Date.now();
      try {
        const rows = await backend.profiles();
        collected.push({
          label: `${rows.length} ${t.settings.profilesFound}`,
          probe: { status: 'ok' },
          ms: Date.now() - started,
          detail: rows.slice(0, 3).map((row) => row.name).join(', '),
        });
      } catch (error) {
        collected.push({
          label: t.settings.testFail,
          probe: probeFromHealth(null, error),
          ms: Date.now() - started,
          detail: parseErrorForDisplay(error),
        });
      }
      backend.dispose();
      setResults(collected);
      setTesting(false);
      return;
    }
    for (const contact of contacts) {
      const started = Date.now();
      try {
        const health = await backend.health(contact.profile);
        collected.push({
          label: contact.label,
          probe: probeFromHealth(health),
          ms: Date.now() - started,
          detail: health.version ? `${health.platform ?? 'hermes-agent'} · v${health.version}` : '',
        });
      } catch (error) {
        collected.push({
          label: contact.label,
          probe: probeFromHealth(null, error),
          ms: Date.now() - started,
          detail: parseErrorForDisplay(error),
        });
      }
    }
    backend.dispose();
    setResults(collected);
    setTesting(false);
  }, [contacts, effectiveProfiles, form]);

  const clearKey = useCallback(() => {
    Alert.alert(t.settings.apiKey, t.settings.clearKeyConfirm, [
      { text: t.roster.cancel, style: 'cancel' },
      {
        text: t.settings.clearKey,
        style: 'destructive',
        onPress: () => {
          setForm((prev) => ({ ...prev, apiKey: '' }));
          update({ apiKey: '' });
        },
      },
    ]);
  }, [update]);

  /**
   * Read the host's tailnet peers. The PHONE cannot enumerate a tailnet — this is the one route
   * that can (see server/personae-mobile-auth). A refusal is normalised, never thrown: the picker
   * says what happened and the manual entry under Advanced stays the way through.
   */
  const readPeers = useCallback(async () => {
    setPeersBusy(true);
    setPeersNote(null);
    const backend = createBackend({ ...form, profiles: effectiveProfiles });
    try {
      setPeers(await backend.tailscalePeers());
    } catch (error) {
      setPeers({ available: false, peers: [], reason: normalizeError(error).status === 401 ? 'unauthorized' : 'error' });
    } finally {
      backend.dispose();
      setPeersBusy(false);
      setPeersOpen(true);
    }
  }, [effectiveProfiles, form]);

  /**
   * Pick a device: derive the route through `src/routes.ts`, PROVE it answers, and only then write
   * it. A device that does not answer adds nothing and says so — the roster never depends on a
   * route that was never checked.
   */
  const pickPeer = useCallback(
    async (peer: PeerRow) => {
      const port = peersPort(form);
      const address = peerAddress(peer, port);
      const route = peerRoute(peer, { port, routes: form.routes, insecureAck: form.insecureRouteAck });
      if (!route) {
        setPeersNote(t.connectivity.peerAlreadyRoute(address));
        return;
      }
      setPeersBusy(true);
      const answers = await probeTcp(peer.ip, port, form.probeTimeoutMs);
      setPeersBusy(false);
      if (!answers) {
        setPeersNote(t.connectivity.peerNotAnswering(peer.name, address));
        return;
      }
      // Plain http on a private overlay needs the explicit ack. Picking a device on your OWN
      // tailnet is that consent, given deliberately — so it is recorded with the route, not assumed.
      setForm((prev) => ({ ...prev, insecureRouteAck: true }));
      update({ insecureRouteAck: true, routes: [...form.routes, route] });
      setPeersNote(t.connectivity.peerAdded(peer.name, address));
      setPeersOpen(false);
    },
    [form, update],
  );

  /**
   * 0.9.0 Phase B — the main page. Section rows, each opening its sub-page, and every row carrying the
   * scope chip that makes the portable/device-local split visible (goal §5). Notifications sits UNDER
   * Agent Preferences as a sibling row — it is not a top-bar destination and not a sixth icon.
   */
  const scopeLabel = (scope: PreferenceScope): string =>
    scope === 'portable' ? t.settings.scopePortable : scope === 'mixed' ? t.settings.scopeMixed : t.settings.scopeDeviceLocal;

  /**
   * 0.9.1 S1 — the style modifiers a row may add, looked up from the plan's own keys. Today the plan
   * returns NONE for every row, and that is the point of routing it through here: if a row ever
   * legitimately needs a modifier it must be declared in `src/settingsPages.ts`, where a test can see
   * it, instead of being re-derived in this file from the row's shape. The indent that made
   * Notifications look offset to the user lived in exactly that gap.
   */
  const rowModifiers = (row: SettingsPageRow): StyleProp<ViewStyle>[] =>
    pageRowStyleKeys(row).map((key) => (styles as unknown as Record<string, StyleProp<ViewStyle>>)[key]);

  if (page === 'index') {
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingLeft: space.md + insets.paddingLeft, paddingRight: space.md + insets.paddingRight }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.pageTitle}>{t.settings.pagesTitle}</Text>
        <Text style={styles.help}>{t.settings.pagesHelp}</Text>
        {settingsRows().map((row) => (
          <Pressable
            key={row.id}
            onPress={() => setPage(row.id)}
            accessibilityRole="button"
            accessibilityLabel={`${t.settings.pages[SETTINGS_PAGE_TITLE_KEY[row.id]]} — ${t.settings.pages[SETTINGS_PAGE_HELP_KEY[row.id]]}`}
            // 0.9.1 S1 — every row gets the SAME style array. The modifiers come from the plan
            // (`pageRowStyleKeys`, empty for all rows), so no row can be indented again: 0.9.0 applied
            // `styles.pageRowSibling` to the one sibling row, and that indent was the user's "offset".
            style={({ pressed }) => [styles.pageRow, ...rowModifiers(row), pressed && styles.pressed]}
          >
            <View style={styles.pageRowText}>
              <Text style={styles.label}>{t.settings.pages[SETTINGS_PAGE_TITLE_KEY[row.id]]}</Text>
              <Text style={styles.help}>{t.settings.pages[SETTINGS_PAGE_HELP_KEY[row.id]]}</Text>
            </View>
            <View style={styles.scopeChip}>
              <Text style={styles.scopeChipText}>{scopeLabel(row.scope)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>
        ))}
        {/* The split, said out loud once, on the page where it matters. */}
        <Text style={styles.help}>{t.settings.scopeHelp}</Text>
      </ScrollView>
    );
  }

  const backRow = (
    <Pressable
      onPress={() => setPage('index')}
      accessibilityRole="button"
      accessibilityLabel={t.settings.pagesTitle}
      style={({ pressed }) => [styles.pageBack, pressed && styles.pressed]}
    >
      <Ionicons name="chevron-back" size={16} color={colors.accent} />
      <Text style={styles.pageBackText}>{t.settings.pagesTitle}</Text>
      <View style={styles.scopeChip}>
        <Text style={styles.scopeChipText}>{scopeLabel(scopeOfRow(page as Exclude<SettingsPageId, 'index'>))}</Text>
      </View>
    </Pressable>
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingLeft: space.md + insets.paddingLeft, paddingRight: space.md + insets.paddingRight }]}
      keyboardShouldPersistTaps="handled"
    >
      {backRow}
      <Text style={styles.pageTitle}>{t.settings.pages[SETTINGS_PAGE_TITLE_KEY[page]]}</Text>
      <Text style={styles.hint}>{t.settings.autoSave}</Text>
      {savedAt ? (
        <Text style={styles.savedLine}>
          {t.settings.saved} · {formatTime(savedAt)}
        </Text>
      ) : null}

      {/* ── 0.9.0 B: GATEWAY SETTINGS — everything about reaching the gateway ── */}
      {page === 'gateway' ? (
        <>
      {/* 0.6.0 — Connection first: the heal note (once), the wizard, and this phone's paired identity. */}
      {settings.healNote ? (
        <View style={[styles.field, { borderColor: colors.amber, borderWidth: 1, borderRadius: radius.md, padding: space.md }]}>
          <Text style={styles.help}>{settings.healNote}</Text>
          <Pressable onPress={() => update({ healNote: '' })} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>{t.connect.dismiss}</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.field}>
        <Text style={styles.label}>{t.connect.title}</Text>
        {/* 0.7.0 — the wizard IS the Connection section: the same three steps, drawn in place.
            `personae://connect` still lands on the same components (src/connect/Wizard.tsx). */}
        <ConnectWizard embedded onDone={() => router.push('/')} />
        {settings.deviceId ? (
          <>
            <Text style={styles.help}>{t.connect.deviceLabel(settings.deviceLabel || settings.deviceId)}</Text>
            <Pressable
              onPress={() => {
                void revokeSelf(settings.baseUrl, settings.apiKey, settings.deviceId).then((ok) => {
                  if (ok) {
                    update({ apiKey: '', deviceId: '', deviceLabel: '' });
                    Alert.alert(t.connect.revoked);
                  }
                });
              }}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>{t.connect.revoke}</Text>
            </Pressable>
          </>
        ) : null}
      </View>

      {/* ── Ligação (0.7.0): THREE affordances and no knobs ──────────────────
          Log in (opens the Tailscale app — no app can sign in for you), Choose device (the host's
          tailnet peer list, which a phone cannot enumerate), and the auto-connect switch. The
          package name and both timeouts are under Advanced, intact. */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.connectivity.title}</Text>

        <Pressable
          onPress={() => void openTailscale()}
          accessibilityRole="button"
          accessibilityLabel={t.connectivity.logIn}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
        >
          <Text style={styles.primaryText}>{t.connectivity.logIn}</Text>
        </Pressable>
        <Text style={styles.help}>{t.connectivity.logInHelp}</Text>

        <Pressable
          onPress={() => void readPeers()}
          disabled={peersBusy}
          accessibilityRole="button"
          accessibilityLabel={t.connectivity.chooseDevice}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed, peersBusy && styles.disabled]}
        >
          <Text style={styles.secondaryText}>{peersBusy ? t.connectivity.devicesLoading : t.connectivity.chooseDevice}</Text>
        </Pressable>
        <Text style={styles.help}>{t.connectivity.chooseDeviceHelp}</Text>
        {peersNote ? <Text style={styles.help}>{peersNote}</Text> : null}

        <View style={styles.rowBetween}>
          <Text style={styles.label}>{t.connectivity.autoConnect}</Text>
          <Switch
            value={form.autoConnect}
            onValueChange={(value) => {
              setForm((prev) => ({ ...prev, autoConnect: value }));
              update({ autoConnect: value });
            }}
          />
        </View>
        <Text style={styles.help}>{t.connectivity.autoConnectHelp}</Text>
        {Platform.OS !== 'android' ? <Text style={styles.help}>{t.connectivity.iosNote}</Text> : null}
      </View>

      {/* The picker itself. Only what can be known is shown: installed, tunnel, and the host's list. */}
      <Modal visible={peersOpen} transparent animationType="fade" onRequestClose={() => setPeersOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setPeersOpen(false)} accessibilityRole="button" accessibilityLabel={t.common.close}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>{t.connectivity.devicesTitle}</Text>
            {peersState(peers ?? { available: false, peers: [] }) === 'unavailable' ? (
              <Text style={styles.help}>{t.connectivity.devicesUnavailable(peers?.reason ?? 'unavailable')}</Text>
            ) : peersState(peers ?? { available: false, peers: [] }) === 'empty' ? (
              <Text style={styles.help}>{t.connectivity.devicesEmpty}</Text>
            ) : (
              (peers?.peers ?? []).map((peer) => (
                <Pressable
                  key={peer.ip}
                  onPress={() => void pickPeer(peer)}
                  disabled={peersBusy}
                  accessibilityRole="button"
                  accessibilityLabel={`${peer.name} — ${peerAddress(peer, peersPort(form))}`}
                  style={({ pressed }) => [styles.peerRow, pressed && styles.pressed]}
                >
                  <Ionicons name="desktop-outline" size={18} color={colors.text} />
                  <View style={styles.peerText}>
                    <Text style={styles.peerName} numberOfLines={1}>
                      {peer.ip === peers?.self?.ip ? `${peer.name} · ${t.connectivity.peerSelf}` : peer.name}
                    </Text>
                    <Text style={styles.help} numberOfLines={1}>
                      {`${peerAddress(peer, peersPort(form))} · ${peer.os || '—'} · ${peer.online ? t.connectivity.peerOnline : t.connectivity.peerOffline}`}
                    </Text>
                  </View>
                </Pressable>
              ))
            )}
            <View style={styles.rowButtons}>
              <Pressable onPress={() => void readPeers()} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
                <Text style={styles.secondaryText}>{t.connectivity.devicesRetry}</Text>
              </Pressable>
              <Pressable onPress={() => setPeersOpen(false)} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
                <Text style={styles.secondaryText}>{t.common.close}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

        </>
      ) : null}

      {/* ── 0.9.0 B: AGENT PREFERENCES — language + which session types the list shows ── */}
      {page === 'agent' ? (
        <>
      {/* Interface language: one tap, applied and saved at once (no Save button). */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.settings.language}</Text>
        <View style={styles.segment}>
          {(['en', 'pt'] as const).map((option) => {
            const active = settings.language === option;
            const label = option === 'en' ? t.settings.languageEnglish : t.settings.languagePortuguese;
            return (
              <Pressable
                key={option}
                onPress={() => {
                  setForm((prev) => ({ ...prev, language: option }));
                  update({ language: option });
                }}
                style={[styles.segmentButton, active && styles.segmentButtonActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={label}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.help}>{t.settings.languageHelp}</Text>
      </View>

      {/* ── Session types (0.8.0 D) ─────────────────────────────────────────
          CHECKBOXES, deliberately: that is the operator's own word ("check/uncheck the type of
          sessions they want to see"), and a checkbox makes "both unchecked" visibly different from
          "one on". Tapping anywhere on the row toggles it and saves at once — no Save button
          (pedro-app-defaults: single-field settings save themselves). */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.settings.sessionTypes}</Text>
        {sessionTypeChoices(form.sessionTypes).map((choice) => {
          const label = choice.id === 'sessions' ? t.settings.typeSessions : t.settings.typeAutomatic;
          const help = choice.id === 'sessions' ? t.settings.typeSessionsHelp : t.settings.typeAutomaticHelp;
          return (
            <Pressable
              key={choice.id}
              onPress={() => setSessionType(choice.id, !choice.enabled)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: choice.enabled }}
              accessibilityLabel={`${label} — ${help}`}
              style={({ pressed }) => [styles.typeRow, pressed && styles.pressed]}
            >
              <View style={[styles.typeBox, choice.enabled && styles.typeBoxOn]}>
                {choice.enabled ? <Ionicons name="checkmark" size={16} color={colors.accentText} /> : null}
              </View>
              <View style={styles.typeText}>
                <Text style={styles.typeLabel}>{label}</Text>
                <Text style={styles.help}>{help}</Text>
              </View>
            </Pressable>
          );
        })}
        <Text style={styles.help}>{t.settings.sessionTypesHelp}</Text>
        {anySessionType(form.sessionTypes) ? null : <Text style={styles.warning}>{t.settings.typeNoneWarning}</Text>}
      </View>

        </>
      ) : null}

      {/* ── 0.9.0 B: NOTIFICATIONS — a SIBLING row of Agent Preferences, not a sixth top-bar icon ── */}
      {page === 'notifications' ? (
        <>
      {/* ── Notifications (0.8.0 H) ─────────────────────────────────────────
          DEVICE-SIDE local notifications, never called "push": they can only fire while the app is
          running, because the phone's own poll is the only thing that knows a checkpoint happened.
          The master switch is off by default and the Android permission is requested from THIS
          switch — once, on the way on. The permission state is shown as it really is. */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.notify.title}</Text>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>{t.notify.master}</Text>
          <Switch
            value={Boolean(form.notifications?.enabled)}
            onValueChange={(value) => void toggleNotifications(value)}
            accessibilityLabel={t.notify.master}
          />
        </View>
        <Text style={styles.help}>{t.notify.masterHelp}</Text>

        {form.notifications?.enabled ? (
          <>
            <View style={styles.rowBetween}>
              <Text style={styles.label}>{t.notify.waiting}</Text>
              <Switch
                value={Boolean(form.notifications?.waiting)}
                onValueChange={(value) => setNotifyKind('waiting', value)}
                disabled={!capability.waiting}
                accessibilityLabel={t.notify.waiting}
                accessibilityState={{ disabled: !capability.waiting }}
              />
            </View>
            <Text style={styles.help}>{capability.waiting ? t.notify.waitingHelp : t.notify.waitingUnavailable}</Text>

            <View style={styles.rowBetween}>
              <Text style={styles.label}>{t.notify.finished}</Text>
              <Switch
                value={Boolean(form.notifications?.finished)}
                onValueChange={(value) => setNotifyKind('finished', value)}
                accessibilityLabel={t.notify.finished}
              />
            </View>
            <Text style={styles.help}>{t.notify.finishedHelp}</Text>
            {capability.basis === 'activity' ? <Text style={styles.warning}>{t.notify.waitingUnavailable}</Text> : null}
          </>
        ) : null}

        <View style={styles.rowBetween}>
          <Text style={styles.label}>{t.notify.permission}</Text>
          <Text style={styles.help}>{permissionLabel(permission)}</Text>
        </View>
        {permission === 'denied' ? (
          <Text style={styles.warning}>{t.notify.permissionDenied}</Text>
        ) : permission === 'not-asked' && form.notifications?.enabled ? (
          <Pressable
            onPress={() => void toggleNotifications(true)}
            disabled={asking}
            accessibilityRole="button"
            accessibilityLabel={t.notify.permissionAsk}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed, asking && styles.disabled]}
          >
            <Text style={styles.secondaryText}>{asking ? t.notify.permissionAsking : t.notify.permissionAsk}</Text>
          </Pressable>
        ) : null}
        <Text style={styles.help}>{t.notify.help}</Text>
      </View>

        </>
      ) : null}

      {/* ── 0.9.0 B: ADVANCED — 0.7.0's disclosure, unchanged, now its own sub-page ── */}
      {page === 'advanced' ? (
        <>
      {/* ── Advanced (0.7.0): CLOSED by default ──────────────────────────────
          Nothing was deleted. Connection type, address, bearer, routes, the tailnet internals,
          status and the log all live here, one tap away. */}
      <Pressable
        onPress={() => setAdvancedOpen((open) => !open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: advancedOpen }}
        accessibilityLabel={advancedOpen ? t.settings.advancedHide : t.settings.advancedShow}
        style={({ pressed }) => [styles.field, styles.advancedHeader, pressed && styles.pressed]}
      >
        <Text style={styles.label}>{t.settings.advanced}</Text>
        <Ionicons name={advancedOpen ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.muted} />
      </Pressable>
      {advancedOpen ? <Text style={styles.help}>{t.settings.advancedHelp}</Text> : null}

      {advancedOpen ? (
        <>
      {/* Which surface the address speaks. One choice, applied at once (single-field settings save
          themselves), because everything else on this screen means something slightly different
          per surface: the bearer is a dashboard app credential, or the :9222 API key. */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.settings.surface}</Text>
        <View style={styles.segment}>
          {(['dashboard', 'gateway'] as const).map((option) => {
            const active = form.surface === option;
            return (
              <Pressable
                key={option}
                onPress={() => {
                  setForm((prev) => ({ ...prev, surface: option }));
                  update({ surface: option });
                }}
                style={[styles.segmentButton, active && styles.segmentButtonActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={t.a11y.surface(surfaceLabel(option))}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {surfaceLabel(option)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.help}>{t.settings.surfaceHelp}</Text>
        <View style={styles.effectiveRow}>
          <Text style={styles.effectiveLabel}>{t.settings.effective}</Text>
          <Text style={styles.effectiveValue}>{surfaceLabel(form.surface)}</Text>
        </View>

        {/* F7's second half: name the ONE thing a user must set, and put its check result right
            next to it. `Tipo de ligação = Dashboard (:9119)` plus the bearer is the whole
            requirement; everything else on this screen has a working default. */}
        <View style={styles.requiredRow}>
          <Ionicons
            name={surfaceOk ? 'checkmark-circle' : 'alert-circle-outline'}
            size={16}
            color={surfaceOk ? colors.green : colors.amber}
          />
          <Text style={styles.requiredText}>
            {surfaceOk ? t.settings.surfaceCheckOk : t.settings.surfaceCheckPending}
          </Text>
        </View>
        {checkResult ? (
          <View style={styles.checkRow}>
            <View style={[styles.dot, { backgroundColor: statusColor(checkResult.probe.status, colors) }]} />
            <Text style={styles.checkText} numberOfLines={2}>
              {checkResult.probe.status === 'ok'
                ? t.settings.testOk(checkResult.probe.version ?? '')
                : checkResult.detail || checkResult.probe.status}
              {checkResult.ms !== null ? ` · ${checkResult.ms} ms` : ''}
            </Text>
          </View>
        ) : null}

        {/* The api_server has NO profile route. A 0.4.0 upgrade lands here with the old :9222 key,
            so say it in the UI instead of letting the roster look empty for no stated reason. */}
        {form.surface === 'gateway' ? <Text style={styles.invalid}>{t.settings.gatewayNoProfiles}</Text> : null}
      </View>

      <Field
        label={t.settings.baseUrl}
        help={form.surface === 'dashboard' ? t.settings.baseUrlHelp : t.settings.baseUrlHelpGateway}
        value={form.baseUrl}
        onChangeText={(value) => stage({ baseUrl: value.trim() }, 400)}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        effective={
          urlCheck.ok
            ? urlCheck.value
            : form.baseUrl.trim()
              ? t.errors.badBaseUrl(form.baseUrl)
              : t.settings.valueUnset
        }
        invalid={Boolean(form.baseUrl.trim()) && !urlCheck.ok}
      />

      <View style={styles.field}>
        <View style={styles.labelRow}>
          <Text style={styles.label}>{t.settings.apiKey}</Text>
          <Pressable onPress={() => setRevealKey((value) => !value)} style={styles.inlineButton}>
            <Text style={styles.inlineButtonText}>{revealKey ? t.settings.hideKey : t.settings.showKey}</Text>
          </Pressable>
        </View>
        <TextInput
          value={form.apiKey}
          onChangeText={(value) => stage({ apiKey: value.trim() }, 400)}
          placeholder={form.surface === 'dashboard' ? t.settings.keyPlaceholderDashboard : t.settings.keyPlaceholderGateway}
          placeholderTextColor={colors.faint}
          style={styles.input}
          secureTextEntry={!revealKey}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.help}>{t.settings.apiKeyHelp}</Text>
        <View style={styles.effectiveRow}>
          <Text style={styles.effectiveLabel}>{t.settings.effective}</Text>
          <Text style={styles.effectiveValue}>
            {form.apiKey ? `${t.settings.apiKeySet} · ${redactKey(form.apiKey)}` : t.settings.valueUnset}
          </Text>
        </View>
        {form.apiKey ? (
          <Pressable onPress={clearKey} style={({ pressed }) => [styles.danger, pressed && styles.pressed]}>
            <Text style={styles.dangerText}>{t.settings.clearKey}</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{t.settings.profiles}</Text>
        <TextInput
          value={profilesText}
          onChangeText={(value) => {
            setProfilesText(value);
            stage({ profiles: splitProfiles(value) }, 700);
          }}
          placeholder={'cody\nvintage'}
          placeholderTextColor={colors.faint}
          style={[styles.input, styles.multiline]}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.help}>{t.settings.profilesHelp}</Text>
        <View style={styles.effectiveRow}>
          <Text style={styles.effectiveLabel}>{t.settings.effective}</Text>
          <Text style={styles.effectiveValue}>
            {effectiveProfiles.length
              ? effectiveProfiles.map((name) => `/p/${name}/`).join('  ')
              : t.settings.valueUnset}
          </Text>
        </View>
        {droppedLines.length ? (
          <Text style={styles.invalid}>{t.settings.ignored(droppedLines.join(', '))}</Text>
        ) : null}
      </View>

      <Field
        label={t.settings.model}
        help={t.settings.modelHelp}
        value={form.model}
        onChangeText={(value) => stage({ model: value.trim() })}
        autoCapitalize="none"
        autoCorrect={false}
        effective={form.model.trim() || t.settings.modelDefault}
      />

      {/* ── Rotas: one server, several routes ─────────────────────────────── */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.routes.title}</Text>
        <Text style={styles.help}>{t.routes.help}</Text>

        {routes.length ? (
          orderRoutes(form.routes).map((route, index) => {
            const check = checkRoute(route, { insecureAck: form.insecureRouteAck });
            return (
              <View key={`route-${index}`} style={styles.routeRow}>
                <View style={styles.rowBetween}>
                  <View style={styles.roleChip}>
                    <Text style={styles.roleChipText}>{roleLabel(route.role)}</Text>
                  </View>
                  <Text style={styles.routePriority}>{t.routes.priorityLabel(index)}</Text>
                  <View style={styles.rowButtons}>
                    <Pressable
                      disabled={index === 0}
                      onPress={() => saveRoutes(moveRoute(form.routes, index, -1))}
                      style={({ pressed }) => [styles.smallButton, pressed && styles.pressed, index === 0 && styles.disabled]}
                    >
                      <Text style={styles.smallButtonText}>↑ {t.routes.moveUp}</Text>
                    </Pressable>
                    <Pressable
                      disabled={index === routes.length - 1}
                      onPress={() => saveRoutes(moveRoute(form.routes, index, 1))}
                      style={({ pressed }) => [styles.smallButton, pressed && styles.pressed, index === routes.length - 1 && styles.disabled]}
                    >
                      <Text style={styles.smallButtonText}>↓ {t.routes.moveDown}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        Alert.alert(t.routes.title, t.routes.removeConfirm(route.url), [
                          { text: t.roster.cancel, style: 'cancel' },
                          {
                            text: t.routes.remove,
                            style: 'destructive',
                            onPress: () => {
                              // Remove by object identity, not by URL: two routes can legitimately
                              // share a URL (different role/priority), and removing by URL would
                              // silently delete both.
                              const ordered = orderRoutes(form.routes);
                              saveRoutes(form.routes.filter((item) => item !== ordered[index]));
                            },
                          },
                        ])
                      }
                      style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
                    >
                      <Text style={[styles.smallButtonText, styles.dangerTextSmall]}>{t.routes.remove}</Text>
                    </Pressable>
                  </View>
                </View>

                <TextInput
                  value={route.url}
                  onChangeText={(value) => {
                    const next = orderRoutes(form.routes).map((item, position) =>
                      position === index ? { ...item, url: value.trim(), role: item.role } : item,
                    );
                    saveRoutes(next, 700);
                  }}
                  placeholder={t.routes.placeholder}
                  placeholderTextColor={colors.faint}
                  style={[styles.input, !check.ok && styles.inputInvalid]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />

                {/* The role is inferred from the address, and the label says so. */}
                <Text style={styles.help}>
                  {`${t.routes.inferred}: ${roleLabel(route.role)}`}
                </Text>
                <Text style={styles.help}>{transportSecurityNote(route)}</Text>
                {!check.ok ? <Text style={styles.invalid}>{problemText(check.reason)}</Text> : null}
              </View>
            );
          })
        ) : (
          <Text style={styles.help}>{t.routes.empty}</Text>
        )}

        <TextInput
          value={newRoute}
          onChangeText={setNewRoute}
          onSubmitEditing={addRoute}
          placeholder={t.routes.placeholder}
          placeholderTextColor={colors.faint}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
        />
        <Pressable onPress={addRoute} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
          <Text style={styles.secondaryText}>{t.routes.add}</Text>
        </Pressable>
        {routeProblem ? <Text style={styles.invalid}>{routeProblem}</Text> : null}

        <View style={styles.rowBetween}>
          <Text style={styles.label}>{t.routes.ackTitle}</Text>
          <Switch
            value={form.insecureRouteAck}
            onValueChange={(value) => {
              setForm((prev) => ({ ...prev, insecureRouteAck: value }));
              update({ insecureRouteAck: value });
            }}
          />
        </View>
        <Text style={styles.help}>{t.routes.ackHelp}</Text>

        <Text style={styles.label}>{t.routes.preferredTitle}</Text>
        <View style={styles.pillRow}>
          {[null, ...Array.from(new Set(routes.map((route) => route.role)))].map((role) => {
            const active = (form.preferredRouteRole ?? null) === role;
            return (
              <Pressable
                key={role ?? 'auto'}
                onPress={() => {
                  setForm((prev) => ({ ...prev, preferredRouteRole: role }));
                  update({ preferredRouteRole: role });
                }}
                style={({ pressed }) => [styles.pill, active && styles.pillActive, pressed && styles.pressed]}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>
                  {role === null ? t.routes.preferredAuto : roleLabel(role)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.help}>{t.routes.preferredHelp}</Text>
      </View>

      {/* ── Ligação internals (Advanced): the knobs a user never reasons about ─ */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.connectivity.title}</Text>
        <Text style={styles.help}>{t.connectivity.tailscalePackageHelp}</Text>

        <Field
          label={t.connectivity.tailscalePackage}
          help={t.connectivity.tailscalePackageHelp}
          value={form.tailscalePackage}
          onChangeText={(value) => stage({ tailscalePackage: value.trim() || 'com.tailscale.ipn' })}
          effective={form.tailscalePackage || DEFAULT_SETTINGS.tailscalePackage}
        />

        <Field
          label={t.connectivity.connectDeadline}
          help=""
          value={String(Math.round(form.connectDeadlineMs / 1000))}
          onChangeText={(value) => {
            const seconds = Number(value.replace(/[^0-9]/g, ''));
            if (!Number.isFinite(seconds) || seconds <= 0) return;
            stage({ connectDeadlineMs: Math.min(120_000, Math.max(1_000, seconds * 1000)) });
          }}
          effective={`${Math.round(form.connectDeadlineMs / 1000)} s`}
          keyboardType="default"
        />

        <Field
          label={t.connectivity.probeTimeout}
          help=""
          value={String(Math.round(form.probeTimeoutMs / 1000))}
          onChangeText={(value) => {
            const seconds = Number(value.replace(/[^0-9.]/g, '').replace(',', '.'));
            if (!Number.isFinite(seconds) || seconds <= 0) return;
            stage({ probeTimeoutMs: Math.min(10_000, Math.max(100, Math.round(seconds * 1000))) });
          }}
          effective={`${(form.probeTimeoutMs / 1000).toFixed(1).replace('.', ',')} s`}
        />

        <View style={styles.rowBetween}>
          <Text style={styles.label}>{t.connectivity.openOnFailure}</Text>
          <Switch
            value={form.openTailscaleOnFailure}
            onValueChange={(value) => {
              setForm((prev) => ({ ...prev, openTailscaleOnFailure: value }));
              update({ openTailscaleOnFailure: value });
            }}
          />
        </View>
      </View>

      {/* ── Estado da ligação: the panel that tells the four failures apart ── */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.connectivity.diagnosticsTitle}</Text>

        <DiagRow label={t.connectivity.diagInstalled} value={diagnostic.canTrigger ? tri(diagnostic.installed) : t.connectivity.diagNotAvailable} />
        <DiagRow
          label={t.connectivity.diagTunnel}
          value={
            diagnostic.stage === 'connecting' || busy
              ? t.connectivity.tunnelProbing
              : diagnostic.gatewayAnswering
                ? t.connectivity.tunnelUp
                : t.connectivity.tunnelDown
          }
        />
        <DiagRow
          label={t.connectivity.diagRoute}
          value={
            diagnostic.chosenRoute
              ? `${roleLabel(diagnostic.chosenRoute.role)} · ${diagnostic.chosenRoute.url}`
              : t.connectivity.noneChosen
          }
        />
        <DiagRow label={t.connectivity.diagGateway} value={tri(diagnostic.gatewayAnswering)} />
        <DiagRow label={t.connectivity.diagEverWorked} value={tri(settings.everReachedGateway)} />
        <DiagRow label={t.connectivity.diagLastError} value={settings.lastErrorKind || '—'} />
        <DiagRow label={t.connectivity.diagTrigger} value={settings.lastTriggerResult || '—'} />

        {diagnostic.vpnTransport ? <Text style={styles.help}>{t.connectivity.diagVpnHint}</Text> : null}
        {diagnostic.message ? <Text style={styles.invalid}>{diagnostic.message}</Text> : null}
        {diagnostic.rejected.length
          ? diagnostic.rejected.map((entry, index) => (
              <Text key={`rejected-${index}`} style={styles.invalid}>
                {`${entry.route.url} — ${problemText(entry.reason)}`}
              </Text>
            ))
          : null}
        <Text style={styles.help}>{t.connectivity.diagHealthCaveat}</Text>

        <View style={styles.rowButtons}>
          <Pressable onPress={recheck} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>{t.connectivity.recheck}</Text>
          </Pressable>
          {diagnostic.canTrigger ? (
            <Pressable onPress={() => void openTailscale()} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>{t.connectivity.openTailscale}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.field}>
        <Pressable
          onPress={() => void testConnection()}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed, testing && styles.disabled]}
          disabled={testing}
        >
          <Text style={styles.primaryText}>{testing ? t.settings.testing : t.settings.testConnection}</Text>
        </Pressable>
        {results.map((result) => (
          <View key={result.label} style={styles.testRow}>
            <View style={[styles.dot, { backgroundColor: statusColor(result.probe.status, colors) }]} />
            <Text style={styles.testLabel}>{result.label}</Text>
            <Text style={styles.testDetail} numberOfLines={2}>
              {result.probe.status === 'ok' ? t.settings.testOk(result.probe.version ?? '') : result.detail || result.probe.status}
              {result.ms !== null ? ` · ${result.ms} ms` : ''}
            </Text>
          </View>
        ))}
        {!results.length && !testing ? <Text style={styles.help}>{t.settings.testFail} → {t.retry}</Text> : null}
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>{t.settings.logTitle}</Text>
        <Text style={styles.help}>{t.settings.logHelp}</Text>
        <TextInput
          value={logNote}
          onChangeText={setLogNote}
          placeholder={t.settings.logPlaceholder}
          placeholderTextColor={colors.faint}
          style={[styles.input, styles.logInput]}
          multiline
        />
        <View style={styles.composerActions}>
          <Pressable
            onPress={() => void exportLog()}
            accessibilityRole="button"
            accessibilityLabel={t.a11y.exportLog}
            style={({ pressed }) => [styles.primary, styles.logButton, pressed && styles.pressed]}
          >
            <Ionicons name="share-outline" size={16} color={colors.accentText} />
            <Text style={styles.primaryText}>{t.settings.logExport}</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              log.clear();
              setLogStatus(t.settings.logCleared);
            }}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>{t.settings.logClear}</Text>
          </Pressable>
        </View>
        {logStatus ? <Text style={styles.help}>{logStatus}</Text> : null}
        <View style={styles.effectiveRow}>
          <Text style={styles.effectiveLabel}>{t.settings.effective}</Text>
          <Text style={styles.effectiveValue}>{t.settings.logLines(log.entries.length)}</Text>
        </View>
      </View>
        </>
      ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function Field(props: {
  label: string;
  help: string;
  value: string;
  onChangeText: (value: string) => void;
  effective: string;
  invalid?: boolean;
  autoCapitalize?: 'none' | 'sentences';
  autoCorrect?: boolean;
  keyboardType?: 'default' | 'url';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.label}
        placeholderTextColor={colors.faint}
        style={[styles.input, props.invalid && styles.inputInvalid]}
        autoCapitalize={props.autoCapitalize ?? 'none'}
        autoCorrect={props.autoCorrect ?? false}
        keyboardType={props.keyboardType ?? 'default'}
      />
      <Text style={styles.help}>{props.help}</Text>
      <View style={styles.effectiveRow}>
        <Text style={styles.effectiveLabel}>{t.settings.effective}</Text>
        <Text style={[styles.effectiveValue, props.invalid && styles.invalid]}>{props.effective}</Text>
      </View>
    </View>
  );
}

/**
 * One read-only diagnostics row. These are the rows that make "wrong port" and "never logged in"
 * distinguishable at a glance instead of both looking like "it didn't work".
 */
function DiagRow(props: { label: string; value: string }) {
  return (
    <View style={styles.diagRow}>
      <Text style={styles.diagLabel}>{props.label}</Text>
      <Text style={styles.diagValue}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── 0.9.0 B: Settings as a page of rows ────────────────────────────────
  pageTitle: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  pageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
  },
  // 0.9.1 S1: `pageRowSibling: { marginLeft: space.lg, marginTop: -space.sm + 2 }` lived here. It was
  // applied to the one sibling row and was the user's "Notifications is offset". Deleted, not shadowed:
  // every index row now gets `pageRow` and nothing else. Do not bring it back — the plan no longer
  // offers a modifier to apply (`pageRowStyleKeys` returns none) and a test names the absence.
  pageRowText: { flex: 1, gap: 2 },
  scopeChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  scopeChipText: { color: colors.muted, fontSize: 10, fontWeight: '600' },
  pageBack: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: space.xs },
  pageBackText: { color: colors.accent, fontSize: font.body, fontWeight: '600', flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.md, paddingBottom: space.xl * 2, gap: space.md },
  hint: { color: colors.faint, fontSize: font.small },
  savedLine: { color: colors.green, fontSize: font.small },
  field: {
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.sm,
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  // ── 0.8.0 D: the session-type checkboxes (named `type*` — `checkRow`/`checkText` already exist) ──
  typeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.xs },
  typeBox: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeBoxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  typeText: { flex: 1, gap: 2 },
  typeLabel: { color: colors.text, fontSize: font.body },
  warning: { color: colors.amber, fontSize: font.small },
  composerActions: { flexDirection: 'row', gap: space.sm },
  logInput: { minHeight: 72, textAlignVertical: 'top' },
  logButton: { flexDirection: 'row', gap: 6 },
  segment: { flexDirection: 'row', gap: space.sm },
  segmentButton: {
    flex: 1,
    height: 38,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentButtonActive: { borderColor: colors.accent, backgroundColor: colors.panelAlt },
  segmentText: { color: colors.muted, fontSize: font.small, fontWeight: '600' },
  segmentTextActive: { color: colors.text },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  inputInvalid: { borderColor: colors.red },
  multiline: { minHeight: 84, textAlignVertical: 'top' },
  help: { color: colors.faint, fontSize: font.small },
  inlineButton: { paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: colors.panelAlt },
  inlineButtonText: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
  effectiveRow: { flexDirection: 'row', gap: space.sm, alignItems: 'baseline' },
  effectiveLabel: { color: colors.faint, fontSize: 11, textTransform: 'uppercase', fontWeight: '700' },
  effectiveValue: { color: colors.text, fontSize: font.small, flexShrink: 1 },
  invalid: { color: colors.red, fontSize: font.small },
  danger: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.red,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  dangerText: { color: colors.red, fontWeight: '700', fontSize: font.small },
  primary: {
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.accentText, fontWeight: '700', fontSize: font.body },
  testRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  testLabel: { color: colors.text, fontSize: font.small, width: 90, fontWeight: '600' },
  testDetail: { color: colors.muted, fontSize: font.small, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  secondary: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  secondaryText: { color: colors.accent, fontWeight: '600', fontSize: font.small },
  routeRow: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    padding: space.sm,
    gap: space.xs,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  rowButtons: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  roleChip: {
    backgroundColor: colors.panelAlt,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  roleChipText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  routePriority: { color: colors.faint, fontSize: 11, flex: 1 },
  smallButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  smallButtonText: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  dangerTextSmall: { color: colors.red },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  pill: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: space.md,
    paddingVertical: 4,
  },
  pillActive: { borderColor: colors.accent, backgroundColor: colors.panelAlt },
  pillText: { color: colors.muted, fontSize: font.small },
  pillTextActive: { color: colors.accent, fontWeight: '700' },
  requiredRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.xs },
  requiredText: { color: colors.text, fontSize: font.small, flexShrink: 1 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  checkText: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  diagRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  diagLabel: { color: colors.faint, fontSize: font.small, width: 160 },
  diagValue: { color: colors.text, fontSize: font.small, flex: 1 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  advancedHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.md },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.sm,
    maxHeight: '80%',
  },
  sheetTitle: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  peerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  peerText: { flex: 1, gap: 1 },
  peerName: { color: colors.text, fontSize: font.body, fontWeight: '600' },
});
