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
import { Alert, BackHandler, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createBackend } from '../src/api/backend';
import { normalizeError } from '../src/api/errors';
import ConnectWizard from '../src/connect/Wizard';
import { connectionLabel, connectionRows } from '../src/gateway/connections';
import { deleteRoute, manualAdd, renameRoute } from '../src/gateway/manage';
import { gatewaySections, pillOptions, statusFields, type GatewaySectionId } from '../src/gateway/plan';
import { readGatewayStatus, statusUrl, type GatewayStatus } from '../src/gateway/status';
import { createDotProbe, dotStateOf, probeDots, type DotRow, type DotState } from '../src/gateway/dots';
import { peerAddress, peerRoute, peersPort, peersState, type PeerRow, type PeersResult } from '../src/logic/peers';
import { probeTcp } from '../src/native/tailscale';
import { ADVANCED_OPEN_BY_DEFAULT } from '../src/settingsLayout';
import {
  SCOPE_LABEL_KEY,
  backFrom,
  pageRowStyleKeys,
  pageTitle,
  settingsRows,
  subPageRows,
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
import { useRouter, Stack } from 'expo-router';
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
  orderRoutes,
  roleLabel,
  transportSecurityNote,
  type RouteCandidate,
  type RouteProblem,
} from '../src/routes';
import { useSettings } from '../src/SettingsContext';
import { colors, font, radius, space } from '../src/theme';

type TestResult = { label: string; probe: Probe; ms: number | null; detail: string };

/**
 * The sub-page title/help keys now live in the PLAN (`src/settingsPages.ts`, on each row), so the
 * header and the rows read one source. 0.9.1 S2 deleted the two duplicate maps that used to sit here:
 * a second copy of the key names is exactly how the header and the row labels drift apart.
 */

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

  // ── 0.10.0 S1 — Gateway Settings is a PAGE PLAN: connections, status, pills, wizard, Advanced ──
  /**
   * The rows the connections dropdown draws: this phone's ROUTES, in priority order (S0's reader —
   * `orderRoutes(effectiveRoutes(settings))`, nothing else).
   */
  const rows = useMemo(() => connectionRows(form), [form]);
  /** Which row the user picked. Index 0 — the highest-priority route — until they pick another. */
  const [selectedIndex, setSelectedIndex] = useState(0);
  /**
   * The row the status panel is about. It is the SELECTED row, which is deliberately not the same
   * question as "the route the engine chose": the user taps a row to ask about THAT connection, and the
   * panel answers the question he asked. Clamped, so deleting a row cannot leave the selection
   * pointing past the end of the list.
   */
  const selectedRow = rows.length ? rows[Math.min(selectedIndex, rows.length - 1)] : null;
  const selectedRoute = selectedRow ? selectedRow.route : null;
  /** The wizard, opened IN PLACE by the button (never a navigation away). */
  const [wizardOpen, setWizardOpen] = useState(false);
  /** `/api/status` for the selected row: its version and gateway_state, or null. */
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  /** When THIS phone last got an answer from each address. Screen-local; nothing is stored. */
  const [routeSeen, setRouteSeen] = useState<Record<string, number>>({});
  /** The section headings/help, resolved live from the plan's own keys. */
  const sectionText = (id: GatewaySectionId, part: 'titleKey' | 'helpKey'): string => {
    const section = gatewaySections().find((candidate) => candidate.id === id);
    const key = section ? section[part] : null;
    return key ? t.settings[key] : '';
  };

  /**
   * The two reads the status panel needs, and no timer: ONE `/api/status` per selected row, with the
   * user's own `probeTimeoutMs` budget. It runs when the page opens and when the selection changes —
   * never on an interval (S2's rule, and the dots below follow it too).
   */
  useEffect(() => {
    if (page !== 'gateway' || !selectedRoute) {
      setGatewayStatus(null);
      return undefined;
    }
    let live = true;
    void readGatewayStatus(selectedRoute.url, { timeoutMs: form.probeTimeoutMs }).then((status) => {
      if (!live) return;
      setGatewayStatus(status);
      // "last seen" is what THIS panel observed: we only claim a sighting when one happened.
      if (status) setRouteSeen((prev) => ({ ...prev, [selectedRoute.url]: Date.now() }));
    });
    return () => {
      live = false;
    };
  }, [page, selectedRoute?.url, form.probeTimeoutMs]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 0.10.0 S2 — the per-row status dot. The answers live HERE, for the life of the screen:
   * `checking` until a row's own probe answers, then `up` or `down` (`src/gateway/dots.ts` owns the
   * three states, the parallel fan-out and the rule that a row with no answer yet is CHECKING).
   */
  const [dots, setDots] = useState<DotRow[]>([]);
  const dotState = (url: string): DotState => dotStateOf(dots, url);
  /** The dot's colour by state: green up, red down, grey while the answer is still coming. */
  const dotStyle = (state: DotState) => ({
    backgroundColor: state === 'up' ? colors.green : state === 'down' ? colors.red : colors.faint,
  });
  /**
   * ONE probe per row, in parallel, with the user's own `probeTimeoutMs` — run when the gateway page
   * is OPENED and when the rows themselves change, never on an interval: the answers are cached for
   * the life of the visit and a re-open re-probes (S2).
   */
  const dotKey = rows.map((row) => row.url).join('|');
  useEffect(() => {
    if (page !== 'gateway' || !rows.length) return undefined;
    let live = true;
    void probeDots(
      rows.map((row) => row.route),
      { timeoutMs: form.probeTimeoutMs, probe: createDotProbe() },
    ).then((answers) => {
      if (live) setDots(answers);
    });
    return () => {
      live = false;
    };
  }, [page, dotKey, form.probeTimeoutMs]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /**
   * 0.10.0 S5 — add a connection by hand. It goes through `src/gateway/manage.ts::manualAdd`, which
   * refuses a duplicate with the SAME rule the peer picker uses (`routes.ts::routeExists`), so the two
   * paths cannot disagree about what "already there" means.
   */
  const addRoute = useCallback(() => {
    const result = manualAdd(form.routes, newRoute, {
      port: peersPort(form),
      insecureAck: form.insecureRouteAck,
    });
    if (!result.ok) {
      setRouteProblem(result.reason === 'duplicate' ? t.settings.gwDuplicateRoute : t.routes.problemBadUrl);
      return;
    }
    setRouteProblem(null);
    saveRoutes(result.routes);
    setNewRoute('');
  }, [form, newRoute, saveRoutes]);

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

  /**
   * 0.9.1 S4.2 — one label and one help sentence per display-session-type checkbox, in the user's order
   * (sessions, cron, webhooks, one-shots). Built per render so `t` stays live, and keyed by the
   * classifier's own ids, so a bucket the classifier can produce but this map cannot name is a compile
   * error rather than a blank row.
   */
  const TYPE_LABELS: Record<SessionType, { label: string; help: string }> = {
    sessions: { label: t.settings.typeSessions, help: t.settings.typeSessionsHelp },
    cron: { label: t.settings.typeCron, help: t.settings.typeCronHelp },
    webhook: { label: t.settings.typeWebhook, help: t.settings.typeWebhookHelp },
    oneshot: { label: t.settings.typeOneshot, help: t.settings.typeOneshotHelp },
  };

  /**
   * 0.9.1 S2 — THE back control. `backFrom` is the plan, so the header arrow, Android's hardware back
   * and the suite all read one fact and cannot disagree about where "back" goes.
   *
   *  * a sub-page → its PARENT (advanced → gateway, everything else → the index), as a state change
   *    inside this same route, so the wizard's in-progress state is never thrown away;
   *  * the index → out of Settings, back to the roster, exactly as the header arrow always did. A
   *    deep link that opened Settings with nothing behind it falls back to the roster instead of
   *    leaving an empty stack.
   */
  const goBack = useCallback(() => {
    const outcome = backFrom(page);
    if (outcome.kind === 'leave') {
      if (router.canGoBack()) router.back();
      else router.replace('/');
      return;
    }
    setPage(outcome.page);
  }, [page, router]);

  /**
   * Android's hardware back must pop the SAME one level. It is deliberately not a second policy: it
   * calls `goBack`, and on the index it returns `false` so the router's own handling (leave for the
   * roster) stays in charge. Registered while a sub-page is on screen, and removed with it.
   */
  useEffect(() => {
    if (page === 'index') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [page, goBack]);

  /** The one back affordance in this screen: the header's. Its title says where you are. */
  const header = (
    <Stack.Screen
      options={{
        title: pageTitle(page),
        headerLeft: () => (
          <Pressable
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
            hitSlop={12}
            style={({ pressed }) => [styles.headerBack, pressed && styles.pressed]}
          >
            <Ionicons name="chevron-back" size={22} color={colors.accent} />
          </Pressable>
        ),
      }}
    />
  );

  if (page === 'index') {
    return (
      <>
        {header}
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
              accessibilityLabel={`${t.settings.pages[row.title]} — ${t.settings.pages[row.help]}`}
              // 0.9.1 S1 — every row gets the SAME style array. The modifiers come from the plan
              // (`pageRowStyleKeys`, empty for all rows), so no row can be indented again: 0.9.0 applied
              // `styles.pageRowSibling` to the one sibling row, and that indent was the user's "offset".
              style={({ pressed }) => [styles.pageRow, ...rowModifiers(row), pressed && styles.pressed]}
            >
              <View style={styles.pageRowText}>
                <Text style={styles.label}>{t.settings.pages[row.title]}</Text>
                <Text style={styles.help}>{t.settings.pages[row.help]}</Text>
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
      </>
    );
  }

  return (
    <>
      {header}
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[styles.content, { paddingLeft: space.md + insets.paddingLeft, paddingRight: space.md + insets.paddingRight }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* 0.9.1 S2 — NO back control in the body. The ONE back affordance is the header's, above; the
            body starts with the page's own content. It used to open with `backRow`, a second back arrow
            wired to `setPage('index')`, which is why the user saw two. The page's name is no longer
            repeated here either: the header title says where you are. */}
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
      {/* ── 0.10.0 S1.1: the CONNECTIONS dropdown — one row per route, with its status dot (S2) ──
          the user, 2026-10-13: *"A dropdown that lists all created connections (both local and remote)
          along with a status dot indicating their connectivity status."* Each row IS a route (S0):
          the kind noun, the address, and the dot. Tapping a row selects it — which is what the
          status panel below is about. */}
      <View style={styles.field}>
        <Text style={styles.label}>{sectionText('connections', 'titleKey')}</Text>
        <Text style={styles.help}>{sectionText('connections', 'helpKey')}</Text>
        {rows.length ? (
          rows.map((row) => (
            <Pressable
              key={row.url}
              onPress={() => setSelectedIndex(row.index)}
              accessibilityRole="button"
              accessibilityLabel={`${connectionLabel(row.route)} — ${row.url}`}
              style={({ pressed }) => [
                styles.connRow,
                row.index === selectedIndex && styles.connRowActive,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.dot, dotStyle(dotState(row.url))]} />
              <View style={styles.connText}>
                <Text style={styles.connTitle} numberOfLines={1}>
                  {connectionLabel(row.route)}
                </Text>
                <Text style={styles.help} numberOfLines={1}>
                  {row.url}
                </Text>
              </View>
              <Text style={styles.help}>{row.kind}</Text>
            </Pressable>
          ))
        ) : (
          <Text style={styles.help}>{t.routes.empty}</Text>
        )}
      </View>

      {/* ── 0.10.0 S1.2: CONNECTION STATUS — kept (his §3: it stays) and moved to the TOP of what
          matters, populated from the SELECTED row (his §4) rather than from the route the engine is
          using. The paired-device line and the one destructive verb that acts on the SERVER live
          here, because that is the panel that describes this phone's identity. ── */}
      <View style={styles.field}>
        <Text style={styles.label}>{sectionText('status', 'titleKey')}</Text>
        <Text style={styles.help}>{sectionText('status', 'helpKey')}</Text>
        {selectedRoute ? (
          statusFields({
            route: selectedRoute,
            surface: form.surface,
            server: gatewayStatus,
            device: {
              label: settings.deviceLabel || settings.deviceId,
              lastSeenMs: routeSeen[selectedRoute.url] ?? null,
            },
          }).map((field) => <DiagRow key={field.id} label={field.label} value={field.value} />)
        ) : (
          <Text style={styles.help}>{t.settings.gwPickOne}</Text>
        )}
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

      {/* ── 0.10.0 S1.3: the pills — which KIND of connection to prefer. This IS
          `preferredRouteRole`, relabelled Local / Remote (decision §3.3): the pin already works
          (`selectRoute`) and a bypass is already reported out loud. A list with ONE kind draws no
          pills at all, because there is nothing to choose. ── */}
      {pillOptions(routes).length ? (
        <View style={styles.field}>
          <Text style={styles.label}>{sectionText('pills', 'titleKey')}</Text>
          <View style={styles.pillRow}>
            {pillOptions(routes).map((pill) => {
              const active = (form.preferredRouteRole ?? null) === pill.role;
              return (
                <Pressable
                  key={pill.role ?? 'auto'}
                  onPress={() => {
                    setForm((prev) => ({ ...prev, preferredRouteRole: pill.role }));
                    update({ preferredRouteRole: pill.role });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={pill.label}
                  style={({ pressed }) => [styles.pill, active && styles.pillActive, pressed && styles.pressed]}
                >
                  <Text style={[styles.pillText, active && styles.pillTextActive]}>{pill.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.help}>{sectionText('pills', 'helpKey')}</Text>
        </View>
      ) : null}

      {/* ── 0.10.0 S1.4: the CONNECTION WIZARD button — the first action below the pills. It opens
          the wizard IN PLACE (the same `src/connect/Wizard.tsx` the `personae://connect` route
          hosts): `setWizardOpen(true)`, never a navigation away, so a half-finished setup is never
          thrown away by a screen swap and the button always reaches it (S3, entry (d)). ── */}
      <View style={styles.field}>
        {wizardOpen ? (
          <>
            <Pressable
              onPress={() => setWizardOpen(false)}
              accessibilityRole="button"
              accessibilityLabel={t.common.close}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>{t.common.close}</Text>
            </Pressable>
            <ConnectWizard embedded onDone={() => router.push('/')} />
          </>
        ) : (
          <>
            <Pressable
              onPress={() => setWizardOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t.settings.gwWizardButton}
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>{t.settings.gwWizardButton}</Text>
            </Pressable>
            <Text style={styles.help}>{sectionText('wizard', 'helpKey')}</Text>
          </>
        )}
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

        {/* ── 0.10.0 S3.2 / decision §3.6 — the tunnel row is ANDROID-ONLY, and on iOS it is not
            rendered at all: no disabled switch, no dead row, no help sentence apologising for a
            platform limit (the `iosNote` line that used to sit here is gone). iOS keeps only
            `openTailscaleOnFailure` under Advanced, which starts nothing. The row maps onto the
            existing `autoConnect` and says "asks", never "connects": the broadcast is
            fire-and-forget and readiness is proven by probing. ── */}
        {Platform.OS === 'android' ? (
          <>
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
          </>
        ) : null}
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

      {/* 0.9.1 S3 — Advanced, drawn HERE now: one row in the same `pageRow` shape the index uses, so
          the move changed where it lives and nothing about how it looks. It opens the same page
          (`setPage('advanced')`), the advanced contents are untouched, and S2's parent map sends the
          single header arrow back to THIS page rather than to the index. */}
      {subPageRows('gateway').map((row) => (
        <Pressable
          key={row.id}
          onPress={() => setPage(row.id)}
          accessibilityRole="button"
          accessibilityLabel={`${t.settings.pages[row.title]} — ${t.settings.pages[row.help]}`}
          style={({ pressed }) => [styles.pageRow, ...rowModifiers(row), pressed && styles.pressed]}
        >
          <View style={styles.pageRowText}>
            <Text style={styles.label}>{t.settings.pages[row.title]}</Text>
            <Text style={styles.help}>{t.settings.pages[row.help]}</Text>
          </View>
          <View style={styles.scopeChip}>
            <Text style={styles.scopeChipText}>{scopeLabel(row.scope)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.muted} />
        </Pressable>
      ))}

        </>
      ) : null}

      {/* ── 0.9.0 B: AGENT PREFERENCES — which session types the list shows ── */}
      {page === 'agent' ? (
        <>
      {/* 0.9.1 S4.1: the "Language / Língua" segment control stood here (two options, `settings.language`,
          saving on tap). the user, 2026-10-13: *"remove language and English is default."* Deleted — the
          field, the control and its two labels — and English is what this app speaks, always. The
          `language` field is gone from `Settings`, from the device-local list and from the field plan,
          so there is no longer anything a stored `{language: 'pt'}` could move. */}

      {/* ── Display session types (0.8.0 D; renamed and widened in 0.9.1 S4.2) ─────
          CHECKBOXES, deliberately: that is the operator's own word ("check/uncheck the type of
          sessions they want to see"), and an unchecked box makes "nothing selected" visibly different
          from "one on". Tapping anywhere on the row toggles it and saves at once — no Save button
          (pedro-app-defaults: single-field settings save themselves).
          THE LABEL SAYS WHAT IT IS: what the list SHOWS. Four kinds, one box each, and the help text
          under the title says plainly that nothing is switched off by any of this. */}
      <View style={styles.field}>
        <Text style={styles.label}>{t.settings.sessionTypes}</Text>
        {sessionTypeChoices(form.sessionTypes).map((choice) => {
          const { label, help } = TYPE_LABELS[choice.id];
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
                              // 0.10.0 S5 — deleting a connection touches the ROUTE LIST and
                              // nothing else. The credential is per SERVER (one device token in
                              // secure storage), so there is nothing to revoke here; forgetting the
                              // device on the server is its own explicit action above. `deleteRoute`
                              // returns `{routes, baseUrl}` and lands the app on the next route that
                              // is not known to be down, or on the empty state that offers the
                              // wizard — never on an address that no longer exists.
                              // A route is known-down only from the dots (S2): `checking` is not
                              // "down", so an unprobed route is still eligible.
                              const patch = deleteRoute(form, index, (candidate) => dotStateOf(dots, candidate.url) !== 'down');
                              saveRoutes(patch.routes);
                              update({ baseUrl: patch.baseUrl });
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

                {/* 0.10.0 S5 — rename: the LABEL only. The address stays on its own field below,
                    and the role stays inferred from the address, so a name can never smuggle a
                    route past the security policy. */}
                <TextInput
                  value={route.label ?? ''}
                  onChangeText={(value) => saveRoutes(renameRoute(form.routes, index, value), 700)}
                  placeholder={t.settings.gwLabelPlaceholder}
                  placeholderTextColor={colors.faint}
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                />

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

        {/* 0.10.0 S1.3 — the preferred-kind pills MOVED to the top of Gateway Settings (they are
            the first thing after the status panel there). They are not drawn twice: one
            `preferredRouteRole`, one control. The rule they encode is unchanged. */}
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
    </>
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
  // 0.9.1 S2: the body's back row is gone. `pageBack` / `pageBackText` — the styles that drew the
  // SECOND back affordance (a chevron, the word "Settings" and a chip, wired to `setPage('index')`) —
  // are deleted, not shadowed. The header's arrow replaced them; one glyph, one place, in every page.
  headerBack: { paddingVertical: space.xs, paddingRight: space.sm },
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

  // ── 0.10.0 S1 — the connections dropdown's rows ─────────────────────────
  connRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    marginTop: space.xs,
  },
  /** The SELECTED row — the one the status panel below is about. */
  connRowActive: { borderColor: colors.accent },
  connText: { flex: 1, gap: 2 },
  connTitle: { color: colors.text, fontSize: font.body, fontWeight: '600' },
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
