/**
 * The connection wizard — ONE implementation, TWO hosts (0.7.0).
 *
 * 0.6.1 had this logic inside `app/connect.tsx`, and Settings reached it through a button that
 * pushed to that route. 0.7.0 wants the same three steps to BE the Connection section of Settings,
 * without a second copy of them anywhere:
 *
 *   app/connect.tsx   the landing route for `personae://connect?base=…&code=…` — a thin wrapper
 *   app/settings.tsx  the Connection section, drawn IN PLACE (`embedded`), never navigating
 *
 *   1 · Service  — probe GET /api/health: name hermes-serve.service, or say what answered instead.
 *                  (:9222 = hermes-gateway.service, nothing listening, TLS wanted)
 *   2 · Sign in  — pair through the dashboard login (expo-web-browser auth session), scan the QR
 *                  (expo-camera), or paste a link. Advanced: a bearer key in Settings.
 *   3 · Check    — GET /api/profiles with the new device token → "22 profiles found".
 *
 * The step HEADINGS come from `src/connect/wizard.ts` (`wizardSteps()`), which is also what the test
 * suite asserts on — so the three steps cannot drift out of the screen that claims to show them.
 *
 * `embedded` changes exactly three things, and nothing about behaviour:
 *   * the container is a plain View (a ScrollView inside Settings' ScrollView fights it for the
 *     gesture), so the fields are laid out by the host;
 *   * the QR scanner opens in a Modal instead of filling the screen (it needs the whole screen);
 *   * the "key in Settings" link is hidden — the user is already in Settings.
 */

import Constants from 'expo-constants';
import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File, Paths } from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { createBackend } from '../api/backend';
import { peerAddress, peerRoute, peersPort, type PeerRow, type PeersResult } from '../logic/peers';
import { isPackageInstalled, probeTcp } from '../native/tailscale';
import { inferRole, normalizeRouteUrl, orderRoutes } from '../routes';
import {
  DEFAULT_PORT,
  ipInput,
  isRemoteTarget,
  lanUrl,
  portInput,
  portOr,
  remoteUrl,
  splitAddress,
} from './address';
import { readStatusBody, stagedConnectionTest, TEST_MESSAGE_KEY, type TestResult } from './connectionTest';
import { runPairLogin } from './pairflow';
import { buildSupportBundle, pushTimeline, supportText, type TimelineEntry } from './support';
import {
  SERVICE_ENTRY_WITH_ADDRESS,
  addressFieldOpen,
  autoProbeTarget,
  branchRows,
  installCheckVisible,
  tunnelRowVisible,
  wizardBranches,
  type WizardBranchId,
} from './wizard';
import { DEFAULT_WIZARD_STATE, dismissPatch, loadWizardState, resumeStep, saveWizardState, stepPatch, type WizardState } from './wizardSession';

import { t, useLanguage } from '../i18n';
import { PEER_LIST_MAX_HEIGHT, PEER_LIST_SCROLLS } from '../settingsLayout';
import {
  candidateAddresses,
  CONNECT_LINK,
  dashboardAddressFor,
  pairPageUrl,
  PairingError,
  parseConnectLink,
  probeService,
  redeemPairing,
  settingsAfterPairing,
  type ConnectLink,
  type ProbeVerdict,
} from '../pairing';
import { checkBaseUrl } from '../settings';
import { useSettings } from '../SettingsContext';
import { colors, font, radius, space } from '../theme';
import { wizardStepIds, wizardSteps } from './wizard';

/** A code is redeemable once; the auth-session result AND the OS deep link may both deliver it. */
const handledCodes = new Set<string>();

const SYSTEMD_LINES = [
  'systemctl --user status hermes-serve.service',
  'systemctl --user enable --now hermes-serve.service',
];

function failureText(error: unknown): string {
  if (!(error instanceof PairingError)) return t.connect.failNetwork;
  switch (error.reason) {
    case 'used':
      return t.connect.failUsed;
    case 'expired':
      return t.connect.failExpired;
    case 'unknown':
      return t.connect.failUnknown;
    case 'rate_limited':
      return t.connect.failRate;
    case 'no_pairing':
      return t.connect.noPairing;
    case 'network':
      return t.connect.failNetwork;
    default:
      return t.connect.failServer(error.status);
  }
}

export type WizardProps = {
  /** Drawn inside another screen (Settings): no route push, no full-screen scanner. */
  embedded?: boolean;
  /** What "Concluído" does. Defaults to the roster, which is right for the standalone route. */
  onDone?: () => void;
  /**
   * 0.10.1 S3 — the probe step 1 runs BY ITSELF, injectable. The suite has no renderer and must
   * never open a socket (0.10.1 §1.12), so it injects its own verdict-maker; production passes
   * nothing and gets `probeService` from `../pairing`. Same injected-deps shape as
   * `stagedConnectionTest`.
   */
  probe?: (url: string) => Promise<ProbeVerdict>;
};

export default function ConnectWizard(props: WizardProps = {}) {
  useLanguage();
  const router = useRouter();
  const params = useLocalSearchParams<{
    base?: string;
    code?: string;
    label?: string;
    expires?: string;
    /** 0.13.0 W4 — the boot machine's login fallback: which step to open on, and WHY it is here. */
    step?: string;
    reason?: string;
  }>();
  const { settings, update, ready } = useSettings();
  /**
   * 0.10.1 S3 — the probe is INJECTABLE (`props.probe`): the suite has no renderer and never opens a
   * socket, so it supplies its own verdict-maker and can pin "step 1 probes once, by itself".
   * Production passes nothing and gets `probeService`.
   */
  const probeRun = props.probe ?? probeService;

  const [address, setAddress] = useState(settings.baseUrl ? dashboardAddressFor(settings.baseUrl) : '');
  const [verdict, setVerdict] = useState<ProbeVerdict | null>(null);
  const [probing, setProbing] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'bad' | 'info' } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState('');
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  // ── 0.10.0 S3 — the branch, and the state it needs ────────────────────────────────────────────
  /**
   * Which step the wizard is on. It STARTS from what was stored (S3, entry (c)): leaving Settings in
   * the middle of setup and coming back resumes where the user was.
   */
  const [step, setStep] = useState<string>('kind');
  const [branch, setBranch] = useState<WizardBranchId | null>(null);
  /** LAN: an IPv4 field and a SEPARATE port field (§2 of the user's spec). `http://` is appended here. */
  const [ip, setIp] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PORT));
  /**
   * Remote: the MagicDNS name, which is the one field that is NOT IPv4-strict.
   */
  const [host, setHost] = useState('');
  /**
   * 0.10.1 S3 — is the editable address field on step 1 showing? Entered with NO address (a resume
   * with nothing stored, the standalone route, a fresh install) it starts OPEN, because there the
   * user genuinely has to type one. The branch card and a picked device close it: they arrive with
   * the address already written, so the field is a correction, one tap away. `addressFieldOpen` is the
   * decision, not a comment — the suite has no renderer to look at.
   */
  const [addressOpen, setAddressOpen] = useState(() => addressFieldOpen('no-address'));
  /** The remote branch's fast path: the host's own tailnet list (a phone cannot enumerate one). */
  const [peers, setPeers] = useState<PeersResult | null>(null);
  const [peersBusy, setPeersBusy] = useState(false);
  /** Is Tailscale installed HERE? Android only — on iOS there is no honest answer to give. */
  const [tailscaleInstalled, setTailscaleInstalled] = useState<boolean | null>(null);
  /** The staged test's result, and the timeline the support bundle carries. */
  const [test, setTest] = useState<TestResult | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  /** The branch the user picked, remembered so a resumed wizard comes back to the same path. */
  const chooseBranch = (id: WizardBranchId) => {
    setBranch(id);
    setStep('service');
    void saveWizardState({ ...storedState, ...stepPatch('service', id) });
  };

  /** What "done" does, available to the handlers below before the body defines it. */
  const finish = () => (props.onDone ?? (() => router.replace('/'))());

  /**
   * 0.13.0 W4 — the login screen's reason line, composed once and rendered in the body. `null` on
   * every entry that is not the boot machine's 401 fallback (a fresh setup, a skip, a deep link).
   */
  const refusal =
    typeof params.reason === 'string' && params.reason.trim()
      ? t.connect.loginRequired(params.reason.trim())
      : null;

  /** The stored wizard state (S3 entry (b) and (c)): the dismissed flag and the step to resume on. */
  const [storedState, setStoredState] = useState<WizardState>({ ...DEFAULT_WIZARD_STATE });
  useEffect(() => {
    let live = true;
    void loadWizardState().then((state) => {
      if (!live) return;
      setStoredState(state);
      setBranch(state.branch);
      /**
       * 0.13.0 W4 — a route param WINS over the stored step: the boot machine just refused the stored
       * credential, which is the more recent fact about where the user needs to be. Anything that is
       * not a real step id is ignored (the stored step is the fallback), so a hand-made link cannot put
       * the wizard on a screen that does not exist.
       */
      const requested =
        typeof params.step === 'string' && (wizardStepIds() as readonly string[]).includes(params.step)
          ? params.step
          : null;
      setStep(requested ?? resumeStep(state));
    });
    return () => {
      live = false;
    };
  }, [params.step]);

  /** Skip sticks (S3, entry (b)): the flag is written once and never auto-opens the wizard again. */
  const skip = useCallback(() => {
    const next = { ...storedState, ...dismissPatch(Date.now()) };
    setStoredState(next);
    void saveWizardState(next);
    finish();
  }, [storedState]);

  /** One line in the timeline: what was tried, what answered, how long it took (S3.4). */
  const note = useCallback((what: string, status: number, ms: number) => {
    setTimeline((prev) => pushTimeline(prev, { at: new Date().toISOString(), what, status, ms }));
  }, []);

  /**
   * 0.10.1 S3 — arriving at step 1 WITH the address the branch just built. The editable field closes
   * (`addressFieldOpen(SERVICE_ENTRY_WITH_ADDRESS)`): the step's job now is to REPORT on this address,
   * and the field is there for a correction. All three writers — the LAN card, the Remote card and a
   * picked device — come through here, so the disclosure's initial state cannot differ per path.
   */
  const openServiceWithAddress = useCallback((url: string) => {
    setAddress(url);
    setVerdict(null);
    setAddressOpen(addressFieldOpen(SERVICE_ENTRY_WITH_ADDRESS));
    setStep('service');
  }, []);

  /**
   * The LAN manual entry: two fields in, ONE route out — `http://<ipv4>:<port>`, the scheme appended
   * by the app (§2). The address is written as a route so the rest of the app (and the engine) sees
   * it exactly like any other connection.
   */
  const useLanAddress = useCallback(() => {
    const url = lanUrl(ip, portOr(port));
    if (!url) return;
    openServiceWithAddress(url);
    const routes = orderRoutes(settings.routes).filter((route) => normalizeRouteUrl(route.url) !== url);
    update({
      baseUrl: url,
      routes: [...routes, { role: inferRole(url), priority: routes.length, url, insecure: true, label: '' }],
      insecureRouteAck: true,
    });
    note(`LAN ${url}`, 0, 0);
  }, [ip, port, note, openServiceWithAddress, settings.routes, update]);

  /** A pasted `1.2.3.4:9119` splits into the two fields instead of filling one with junk. */
  const pasteAddress = useCallback((raw: string) => {
    const parts = splitAddress(raw);
    setIp(ipInput(parts.host));
    if (parts.port) setPort(parts.port);
  }, []);

  /** The remote branch's manual entry: a hostname and the same port field. */
  const useRemoteAddress = useCallback(() => {
    const url = remoteUrl(host, portOr(port));
    if (!url) return;
    openServiceWithAddress(url);
    note(`Remote ${url}`, 0, 0);
  }, [host, port, note, openServiceWithAddress]);

  /** Read the host's tailnet list through the one route that can answer it (never the phone). */
  const readPeers = useCallback(async () => {
    setPeersBusy(true);
    const backend = createBackend({ ...settings, profiles: settings.profiles });
    try {
      const result = await backend.tailscalePeers();
      setPeers(result);
      note(`peers ${result.available ? result.peers.length : result.reason ?? 'unavailable'}`, 0, 0);
    } catch (error) {
      setPeers({ available: false, peers: [], reason: 'unavailable' });
      note('peers unavailable', 0, 0);
    } finally {
      backend.dispose();
      setPeersBusy(false);
    }
  }, [settings, note]);

  /** Pick a device: `peerRoute()` writes the route and REFUSES a duplicate (S3.2 / S5). */
  const pickPeer = useCallback(
    (peer: PeerRow) => {
      const chosen = peersPort(settings);
      const route = peerRoute(peer, { port: chosen, routes: settings.routes, insecureAck: settings.insecureRouteAck });
      if (!route) {
        note(`peer ${peerAddress(peer, chosen)} already a route`, 0, 0);
        return;
      }
      const url = route.url;
      openServiceWithAddress(url);
      update({ baseUrl: url, routes: [...orderRoutes(settings.routes), route], insecureRouteAck: true });
      note(`peer ${peerAddress(peer, chosen)}`, 0, 0);
    },
    [settings, note, openServiceWithAddress, update],
  );

  // The Android-only install check (S3.2). On iOS it is NOT run: `isPackageInstalled` has no iOS half.
  useEffect(() => {
    if (branch !== 'remote' || !installCheckVisible(Platform.OS)) return;
    let live = true;
    void isPackageInstalled(settings.tailscalePackage).then((installed) => {
      if (live) setTailscaleInstalled(installed);
    });
    return () => {
      live = false;
    };
  }, [branch, settings.tailscalePackage]);

  /** S3.3 — the staged test: reachable, is-this-Hermes, authenticated. */
  const runTest = useCallback(async () => {
    const checked = checkBaseUrl(address);
    if (!checked.ok) {
      setTest({ verdict: 'bad-address', stages: [], server: null });
      return;
    }
    setTest(null);
    const started = Date.now();
    const result = await stagedConnectionTest(checked.value, {
      tcp: probeTcp,
      status: readStatusBody,
      authed: async (url) => {
        try {
          const response = await fetch(`${url}/api/profiles`, {
            headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
          });
          return { status: response.status };
        } catch {
          return null;
        }
      },
      timeoutMs: settings.probeTimeoutMs,
    });
    setTest(result);
    note(
      `test ${result.verdict}${isRemoteTarget(checked.value) ? ' (remote target)' : ''}`,
      result.stages.length ? result.stages[result.stages.length - 1].status : 0,
      Date.now() - started,
    );
  }, [address, settings.apiKey, settings.probeTimeoutMs, note]);

  /**
   * S3.4 — the support log, SHARED and nothing else (decision §3.7): a redacted file handed to the OS
   * share sheet. No route, no upload, no server call.
   */
  const shareSupport = useCallback(async () => {
    const bundle = buildSupportBundle({
      app: { name: 'Personae', version: String(Constants.expoConfig?.version ?? ''), versionCode: Constants.expoConfig?.android?.versionCode ?? null },
      platform: { os: Platform.OS, osVersion: String(Platform.Version ?? '') },
      device: { model: Constants.deviceName ?? '' },
      server: test?.server ?? null,
      plugins: [],
      timeline,
      addresses: [address],
    });
    try {
      const file = new File(Paths.cache, 'personae-support.txt');
      file.write(supportText(bundle));
      await Sharing.shareAsync(file.uri);
      note('support log shared', 200, 0);
    } catch {
      note('support log could not be shared', 0, 0);
    }
  }, [test, timeline, address, note]);

  const [stepService, stepSignIn, stepCheck] = wizardSteps();
  const done = props.onDone ?? (() => router.replace('/'));

  useEffect(() => {
    if (ready && !address && settings.baseUrl) setAddress(dashboardAddressFor(settings.baseUrl));
  }, [ready, settings.baseUrl, address]);

  const suggestions = candidateAddresses([settings.baseUrl, ...settings.routes.map((r) => r.url)]);

  const probe = useCallback(async (target?: string) => {
    const checked = checkBaseUrl(target ?? address);
    if (!checked.ok) {
      setVerdict({ kind: 'other', status: 0 });
      return;
    }
    setAddress(checked.value);
    setProbing(true);
    setMessage(null);
    try {
      setVerdict(await probeRun(checked.value));
    } finally {
      setProbing(false);
    }
  }, [address, probeRun]);

  /**
   * 0.10.1 S3 — "the step opens as a RESULT". Entering step 1 with an address in hand probes it ONCE,
   * by itself, so the verdict is already there instead of waiting behind a button. The ref holds the
   * last probed address, which is what makes a re-render probe not at all and a CHANGED address probe
   * again — the same `scannedRef` shape this file already uses. The rule itself lives in
   * `autoProbeTarget` (the plan module) so the suite can prove it: there is no renderer here.
   */
  const probedRef = useRef('');
  useEffect(() => {
    if (!ready) return;
    const target = autoProbeTarget(step, address, probedRef.current);
    if (!target) return;
    probedRef.current = target;
    void probe(target);
  }, [ready, step, address, probe]);

  /** Redeem → store the device token → verify with /api/profiles. Zero typing. */
  const complete = useCallback(async (link: ConnectLink) => {
    if (handledCodes.has(link.code)) return;
    handledCodes.add(link.code);
    setBusy(true);
    setMessage({ text: t.connect.verifying, tone: 'info' });
    try {
      const result = await redeemPairing(link);
      update(settingsAfterPairing(settings, result));
      setAddress(result.baseUrl);
      try {
        const r = await fetch(`${result.baseUrl}/api/profiles`, {
          headers: { Authorization: `Bearer ${result.token}`, Accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} · /api/profiles`);
        const body = (await r.json()) as { profiles?: unknown[] };
        setMessage({ text: `${t.connect.found((body.profiles ?? []).length)} · ${t.connect.deviceLabel(result.label)}`, tone: 'ok' });
      } catch (error) {
        setMessage({ text: t.connect.verifyFailed(String((error as Error)?.message ?? error)), tone: 'bad' });
      }
    } catch (error) {
      setMessage({ text: failureText(error), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }, [settings, update]);

  // Deep link (cold start or foreground): expo-router hands us the query as params. On the Settings
  // host there are no such params, so this effect is inert there.
  useEffect(() => {
    if (!params.code || !params.base) return;
    const qs = Object.entries(params)
      .filter(([, v]) => typeof v === 'string' && v)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    const link = parseConnectLink(`personae://connect?${qs}`);
    if (link) void complete(link);
    else setMessage({ text: t.connect.badLink, tone: 'bad' });
  }, [params.code, params.base]); // eslint-disable-line react-hooks/exhaustive-deps

  const pairInBrowser = useCallback(async () => {
    const checked = checkBaseUrl(address);
    if (!checked.ok) return;
    const result = await WebBrowser.openAuthSessionAsync(pairPageUrl(checked.value, settings.deviceLabel), 'personae://connect');
    if (result.type === 'success') {
      const link = parseConnectLink(result.url);
      if (link) await complete(link);
      else setMessage({ text: t.connect.badLink, tone: 'bad' });
    } else {
      // On Android the redirect can also arrive as a deep link; complete() de-duplicates it.
      setMessage((m) => m ?? { text: t.connect.cancelled, tone: 'info' });
    }
  }, [address, complete, settings.deviceLabel]);

  const onScanned = useCallback(({ data }: { data: string }) => {
    if (scannedRef.current) return;
    const link = parseConnectLink(data);
    if (!link) return; // keep scanning: not our QR
    scannedRef.current = true;
    setScanning(false);
    void complete(link);
  }, [complete]);

  const copy = (line: string) => {
    void Clipboard.setStringAsync(line);
    setCopied(line);
  };

  const dashboardOk = verdict?.kind === 'dashboard';
  const pairingAvailable = verdict?.kind === 'dashboard' && verdict.pairing;

  /**
   * ── 0.10.0 S3.1 — the LAN "Log in" button ───────────────────────────────────────────────────────
   *
   * It opens the dashboard's own login page in the IN-APP browser (`.../login?next=/pair`), and when
   * the browser returns it polls `pair/status?id=` and redeems through `POST /pair/redeem` — the order
   * lives in `src/connect/pairflow.ts`, this is the I/O it is given. That is what lets the
   * same-device case finish itself instead of asking the user to scan a QR code that is on the very
   * screen they are looking at.
   */
  const loginForPairing = useCallback(
    async (target: string) => {
      const checked = checkBaseUrl(target);
      if (!checked.ok) return;
      setBusy(true);
      setMessage({ text: t.connect.verifying, tone: 'info' });
      const started = Date.now();
      try {
        const outcome = await runPairLogin({
          base: checked.value,
          openBrowser: async (loginUrl) => {
            const result = await WebBrowser.openAuthSessionAsync(loginUrl, CONNECT_LINK);
            return { url: result.type === 'success' ? result.url : null, cancelled: result.type !== 'success' };
          },
          pollStatus: async (statusUrl) => {
            try {
              const response = await fetch(statusUrl, { headers: { Accept: 'application/json' } });
              note(`pair/status ${response.status}`, response.status, Date.now() - started);
              return response.ok ? await response.json() : {};
            } catch {
              note('pair/status did not answer', 0, Date.now() - started);
              return {};
            }
          },
          redeem: redeemPairing,
        });
        if (outcome.outcome === 'redeemed') {
          update(settingsAfterPairing(settings, outcome.result));
          setAddress(outcome.result.baseUrl);
          setMessage({ text: `${t.connect.deviceLabel(outcome.result.label)} · ${t.settings.wizSaved}`, tone: 'ok' });
          setStep('check');
        } else {
          // Honest fallback: the QR / pasted link path below stays for this case.
          setMessage({ text: t.connect.noPairing, tone: 'info' });
        }
      } catch (error) {
        setMessage({ text: failureText(error), tone: 'bad' });
      } finally {
        setBusy(false);
      }
    },
    [settings, update, note],
  );

  const scanner = (
    <View style={styles.scanWrap}>
      {permission?.granted ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} />
      ) : (
        <View style={styles.center}>
          <Text style={styles.body}>{t.connect.cameraDenied}</Text>
          <Btn label={t.connect.grantCamera} onPress={() => void requestPermission()} />
        </View>
      )}
      <View style={styles.scanBar}>
        <Text style={styles.scanText}>{t.connect.scanTitle}</Text>
        <Btn label={t.common.close} secondary onPress={() => setScanning(false)} />
      </View>
    </View>
  );

  if (scanning) {
    // The camera needs the whole screen; inside Settings a Modal is how it gets it.
    return props.embedded ? (
      <Modal visible animationType="slide" onRequestClose={() => setScanning(false)}>
        {scanner}
      </Modal>
    ) : (
      scanner
    );
  }

  /**
   * ── 0.10.0 S3 — STEP 1: LAN or Remote ───────────────────────────────────────────────────────────
   * Two cards (his §1.1), drawn from `wizardBranches()` so the suite and the screen read one list. The
   * branch is WHICH SETUP PATH, not a new route model: both branches end in the same three steps.
   */
  const branchPicker = (
    <View style={styles.branchWrap}>
      <Text style={styles.body}>{t.settings.wizBranchLanIntro}</Text>
      {wizardBranches().map((option) => (
        <Pressable
          key={option.id}
          onPress={() => chooseBranch(option.id)}
          accessibilityRole="button"
          accessibilityLabel={`${option.title} — ${option.help}`}
          style={({ pressed }) => [styles.branchCard, pressed && styles.pressed]}
        >
          <Text style={styles.step}>{option.title}</Text>
          <Text style={styles.help}>{option.help}</Text>
        </Pressable>
      ))}
      <Btn label={t.settings.wizSkip} secondary onPress={skip} />
    </View>
  );

  // The branch step is only shown when it is genuinely the first thing: a deep link that already
  // carries a code is a pairing, not a setup, and the resume state may say the user is past it.
  if (step === 'kind' && !branch && !params.code) {
    return props.embedded ? (
      <View style={styles.embedded}>{branchPicker}</View>
    ) : (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {branchPicker}
      </ScrollView>
    );
  }

  const body = (
    <>
      <Text style={styles.body}>{t.connect.intro}</Text>

      {/* 0.13.0 W4 — WHY this screen opened. The boot machine refused nothing itself: `GET /api/profiles`
          refused the STORED credential (401), and the reason travels here as a route param so the login
          step says it out loud instead of showing a bare form. Absent on every other entry. */}
      {refusal ? (
        <View style={[styles.card, styles.cardBad]}>
          <Text style={styles.body}>{refusal}</Text>
        </View>
      ) : null}

      {/* ── S3.1 — LAN: an IPv4 field and a SEPARATE port field (§2 of his spec). The field keeps
          digits and periods (`ipInput`), the value is judged by `octets()` — the same rule the route
          model uses — and `http://` is appended by the app, never typed. The `personae://` link and the
          QR flow below are unchanged, and both are offered here. ── */}
      {branch === 'lan' ? (
        <View style={styles.card}>
          <Text style={styles.label}>{t.settings.wizIpLabel}</Text>
          {/* 0.10.1 S2 — ONE compound field: the row carries the border and the background, a static
              `http://` sits at its left, and the input has NO border of its own. Two nested borders is
              the classic regression of this change. The prefix is SCHEME-ONLY — four characters of
              literal text, no host, no port, no example address: 0.10.0's first artifact was rejected by
              the verifier's own host-literal check for using a real address as an example, and this
              change must not reintroduce that class. The sentence that had to explain the scheme is
              deleted with it, because the screen now shows it. ── */}
          <View style={styles.inputRow}>
            <Text style={styles.inputPrefix}>http://</Text>
            <TextInput
              style={styles.inputBare}
              value={ip}
              onChangeText={(value) => pasteAddress(value)}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              placeholder="192.168.1.50"
              placeholderTextColor={colors.faint}
            />
          </View>
          <Text style={styles.label}>{t.settings.wizPortLabel}</Text>
          <TextInput
            style={styles.input}
            value={port}
            onChangeText={(value) => setPort(portInput(value))}
            keyboardType="number-pad"
            placeholder={String(DEFAULT_PORT)}
            placeholderTextColor={colors.faint}
          />
          <Text style={styles.help}>{t.settings.wizPortHelp}</Text>
          <Btn
            label={t.settings.wizLogin}
            disabled={!lanUrl(ip, portOr(port)) || busy}
            onPress={() => {
              const url = lanUrl(ip, portOr(port));
              if (url) void loginForPairing(url);
            }}
          />
          <Text style={styles.help}>{t.settings.wizLoginHelp}</Text>
          <Btn
            label={t.settings.wizAddConnection}
            secondary
            disabled={!lanUrl(ip, portOr(port))}
            onPress={useLanAddress}
          />
        </View>
      ) : null}

      {/* ── S3.2 — REMOTE: the peer picker FIRST (the host enumerates the tailnet; a phone cannot),
          then the manual MagicDNS entry, then the Android-only tunnel row. The install check is
          Android-only for the same reason the broadcast is: there is no iOS half of it. ── */}
      {branch === 'remote' ? (
        <View style={styles.card}>
          {installCheckVisible(Platform.OS) && tailscaleInstalled === false ? (
            <Text style={styles.help}>{t.connectivity.setupIncomplete}</Text>
          ) : null}
          <Text style={styles.label}>{t.settings.wizPeersTitle}</Text>
          <Text style={styles.help}>{t.settings.wizPeersHelp}</Text>
          <Btn label={t.settings.wizPeersTitle} secondary disabled={peersBusy} onPress={() => void readPeers()} />
          {/* An unavailable host SAYS WHY (peers.ts's own vocabulary) and falls through to manual
              entry — never an empty picker with no explanation. */}
          {/* 0.10.1 S1 — the list is a BOUNDED inner scroller, not a second full-height one. The
              embedded host is deliberately a plain View (`:20-25`: "a ScrollView inside Settings'
              ScrollView fights it for the gesture"), so the fix is a cap plus
              `nestedScrollEnabled` — the peers stay reachable without burying the manual-entry
              field below the fold. The numbers come from the plan, never from a literal here. */}
          {peers && peers.available
            ? (
              <ScrollView
                style={{ maxHeight: PEER_LIST_MAX_HEIGHT }}
                contentContainerStyle={styles.chipList}
                nestedScrollEnabled={PEER_LIST_SCROLLS}
              >
                {peers.peers.map((peer) => (
                  <Pressable key={peer.ip} onPress={() => pickPeer(peer)} style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
                    <Text style={styles.chipText}>{`${peer.name} · ${peerAddress(peer, portOr(port))}`}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )
            : peers
              ? <Text style={styles.help}>{`${t.settings.wizPeersUnavailable} (${peers.reason ?? 'unavailable'})`}</Text>
              : null}

          <Text style={styles.label}>{t.settings.wizManualTitle}</Text>
          {/* 0.10.1 S2 — the same compound field as the LAN one: `remoteUrl()` also always builds
              `http://` (`src/connect/address.ts`), so the prefix is true here too. The stored value
              stays the bare hostname; the scheme stays the app's. `wizHostHelp` is about the NAME, so
              it stays — nothing was dropped along with the sentence that went. ── */}
          <View style={styles.inputRow}>
            <Text style={styles.inputPrefix}>http://</Text>
            <TextInput
              style={styles.inputBare}
              value={host}
              onChangeText={setHost}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="my-desktop.tailnet.ts.net"
              placeholderTextColor={colors.faint}
            />
          </View>
          <Text style={styles.help}>{t.settings.wizHostHelp}</Text>
          <Text style={styles.label}>{t.settings.wizPortLabel}</Text>
          <TextInput
            style={styles.input}
            value={port}
            onChangeText={(value) => setPort(portInput(value))}
            keyboardType="number-pad"
            placeholder={String(DEFAULT_PORT)}
            placeholderTextColor={colors.faint}
          />
          <Btn
            label={t.settings.wizAddConnection}
            disabled={!remoteUrl(host, portOr(port))}
            onPress={useRemoteAddress}
          />

          {/* THE TUNNEL ROW IS ANDROID-ONLY, and the plan decides: on iOS `branchRows` does not
              contain it at all, so nothing is rendered — no disabled switch, no dead row, no help
              sentence apologising for a platform limit (decision §3.6). ── */}
          {branchRows('remote', Platform.OS).includes('tunnel') ? (
            <>
              <View style={styles.tunnelRow}>
                <Text style={styles.label}>{t.settings.wizTunnelRow}</Text>
                <Switch value={settings.autoConnect} onValueChange={(value) => update({ autoConnect: value })} />
              </View>
              <Text style={styles.help}>{t.settings.wizTunnelRowHelp}</Text>
            </>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.step}>{stepService.title}</Text>
      {/* 0.10.1 S3 — the step opens as a RESULT. The address the branch card (or a picked device)
          already wrote is shown as a plain line, the probe runs by itself, and the editable field is a
          CORRECTION behind a disclosure: closed when the wizard ARRIVED with an address, open when it
          entered with none. the user's words: "Result, not input — auto-probe the address the branch
          already set, keep the field read-only-ish for correction, keep the wrong-service diagnosis
          (smallest change — wizard stays 3 steps)". ── */}
      <Text style={styles.label}>{t.connect.addressLabel}</Text>
      <Pressable
        onPress={() => setAddressOpen((open) => !open)}
        accessibilityRole="button"
        accessibilityLabel={t.connect.addressLabel}
        style={styles.addressRow}
      >
        <Text style={styles.addressValue} numberOfLines={1}>
          {address || '—'}
        </Text>
        <Text style={styles.addressToggle}>{addressOpen ? '▾' : '▸'}</Text>
      </Pressable>
      {addressOpen ? (
        <TextInput
          style={styles.input}
          value={address}
          onChangeText={(v) => {
            setAddress(v);
            setVerdict(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://host:9119"
          placeholderTextColor={colors.faint}
        />
      ) : null}
      {suggestions.length > 0 && (
        <View style={styles.chips}>
          <Text style={styles.help}>{t.connect.suggestions}</Text>
          {suggestions.map((s) => (
            <Pressable key={s} onPress={() => void probe(s)} style={styles.chip}>
              <Text style={styles.chipText}>{s}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Btn label={probing ? t.connect.probing : t.connect.probe} onPress={() => void probe()} disabled={probing} />

      {verdict && (
        <View style={[styles.card, dashboardOk ? styles.cardOk : styles.cardBad]}>
          {verdict.kind === 'dashboard' && <Text style={styles.body}>{t.connect.isDashboard(verdict.version, verdict.authRequired)}</Text>}
          {verdict.kind === 'gateway' && (
            <>
              <Text style={styles.body}>{t.connect.isGateway}</Text>
              <Btn label={t.connect.useDashboardPort(dashboardAddressFor(address))} onPress={() => void probe(dashboardAddressFor(address))} />
            </>
          )}
          {verdict.kind === 'tls' && <Text style={styles.body}>{t.connect.tls}</Text>}
          {verdict.kind === 'other' && <Text style={styles.body}>{t.connect.other(verdict.status)}</Text>}
          {verdict.kind === 'refused' && (
            <>
              <Text style={styles.body}>{t.connect.refused}</Text>
              <Text style={styles.help}>{t.connect.systemdHelp}</Text>
              {SYSTEMD_LINES.map((line) => (
                <Pressable key={line} onPress={() => copy(line)} style={styles.code}>
                  <Text style={styles.codeText}>{line}</Text>
                  <Text style={styles.copy}>{copied === line ? t.connect.copied : t.connect.copy}</Text>
                </Pressable>
              ))}
            </>
          )}
        </View>
      )}

      {dashboardOk && (
        <>
          <Text style={styles.step}>{stepSignIn.title}</Text>
          {pairingAvailable ? (
            <>
              <Text style={styles.help}>{t.connect.pairHelp}</Text>
              <Btn label={t.connect.pairBrowser} onPress={() => void pairInBrowser()} disabled={busy} />
              <Btn
                label={t.connect.pairQr}
                secondary
                disabled={busy}
                onPress={() => {
                  scannedRef.current = false;
                  setScanning(true);
                  if (!permission?.granted) void requestPermission();
                }}
              />
            </>
          ) : (
            <Text style={styles.help}>{t.connect.noPairing}</Text>
          )}
        </>
      )}

      {/* ── S3.3 — TEST CONNECTION, both branches, on the last step. Three staged calls, so a failure
          names itself instead of saying "it did not work": reachable, is-this-Hermes, authenticated. ── */}
      <Text style={styles.step}>{t.settings.wizTest}</Text>
      <Btn label={t.settings.wizTest} onPress={() => void runTest()} />
      {test ? (
        <View style={[styles.card, test.verdict === 'ok' ? styles.cardOk : styles.cardBad]}>
          <Text style={styles.body}>{String(t.settings[TEST_MESSAGE_KEY[test.verdict]])}</Text>
          {test.server ? <Text style={styles.help}>{`${test.server.version} · ${test.server.gatewayState}`}</Text> : null}
          {test.stages.map((stage) => (
            <Text key={stage.stage} style={styles.help}>
              {`${stage.stage}: ${stage.ok ? 'ok' : 'failed'} · HTTP ${stage.status} · ${stage.ms} ms`}
            </Text>
          ))}
          {/* ── S3.4 — the support log, SHARED and nothing else (decision §3.7): a redacted file to
              the OS share sheet. Addresses masked, credentials never included. ── */}
          <Btn label={t.settings.wizShare} secondary onPress={() => void shareSupport()} />
          <Text style={styles.help}>{t.settings.wizShareHelp}</Text>
        </View>
      ) : null}

      <Text style={styles.label}>{t.connect.pasteLink}</Text>
      <TextInput
        style={styles.input}
        value={paste}
        onChangeText={setPaste}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="personae://connect?…"
        placeholderTextColor={colors.faint}
      />
      <Btn
        label={t.connect.pasteGo}
        secondary
        disabled={!paste.trim() || busy}
        onPress={() => {
          const link = parseConnectLink(paste);
          if (link) void complete(link);
          else setMessage({ text: t.connect.badLink, tone: 'bad' });
        }}
      />

      {message && (
        <>
          <Text style={styles.step}>{stepCheck.title}</Text>
          <View style={[styles.card, message.tone === 'ok' ? styles.cardOk : message.tone === 'bad' ? styles.cardBad : null]}>
            <Text style={styles.body}>{message.text}</Text>
          </View>
          {message.tone === 'ok' && <Btn label={t.connect.done} onPress={done} />}
        </>
      )}

      {props.embedded ? null : (
        <Pressable onPress={() => router.push('/settings')} style={styles.linkRow}>
          <Text style={styles.link}>{t.connect.advancedKey}</Text>
        </Pressable>
      )}
    </>
  );

  if (props.embedded) {
    return <View style={styles.embedded}>{body}</View>;
  }
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {body}
    </ScrollView>
  );
}

function Btn({ label, onPress, secondary, disabled }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.btn, secondary && styles.btnSecondary, (pressed || disabled) && styles.pressed]}
    >
      <Text style={[styles.btnText, secondary && styles.btnTextSecondary]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.sm, paddingBottom: space.xl * 2 },
  /** Inside Settings: the host supplies the padding and the scroll. */
  embedded: { gap: space.sm },
  step: { color: colors.text, fontSize: font.title, fontWeight: '700', marginTop: space.lg },
  label: { color: colors.muted, fontSize: font.small, marginTop: space.sm },
  body: { color: colors.text, fontSize: font.body, lineHeight: 21 },
  help: { color: colors.muted, fontSize: font.small, lineHeight: 18 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.body,
  },
  chips: { gap: space.xs },
  /** 0.10.1 S1 — the bounded peer list's own vertical rhythm, inside its ScrollView. */
  chipList: { gap: space.xs },
  /* 0.10.1 S3 — the address line: what the step REPORTS, with the disclosure toggle at its right. */
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  addressValue: { color: colors.text, fontSize: font.body, flexShrink: 1 },
  addressToggle: { color: colors.accent, fontSize: font.body },
  /* 0.10.1 S2 — the compound address field: the ROW carries the border and the background, the
     prefix is plain text, and the input draws nothing of its own. One border, one field. */
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
  },
  inputPrefix: { color: colors.muted, fontSize: font.body },
  inputBare: {
    flex: 1,
    color: colors.text,
    paddingVertical: space.sm,
    fontSize: font.body,
  },
  chip: { backgroundColor: colors.panelAlt, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs, alignSelf: 'flex-start' },
  chipText: { color: colors.accent, fontSize: font.small },
  card: { backgroundColor: colors.panel, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space.md, gap: space.sm },
  cardOk: { borderColor: colors.green },
  cardBad: { borderColor: colors.amber },
  code: { backgroundColor: colors.bg, borderRadius: radius.sm, padding: space.sm, flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  codeText: { color: colors.text, fontFamily: 'monospace', fontSize: font.small, flex: 1 },
  copy: { color: colors.accent, fontSize: font.small },
  btn: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.xs },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.accent },
  btnText: { color: colors.accentText, fontSize: font.body, fontWeight: '600' },
  btnTextSecondary: { color: colors.accent },
  pressed: { opacity: 0.6 },
  linkRow: { marginTop: space.lg },
  link: { color: colors.muted, fontSize: font.small, textDecorationLine: 'underline' },
  scanWrap: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  scanBar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, backgroundColor: 'rgba(0,0,0,0.7)', gap: space.sm },
  scanText: { color: '#fff', fontSize: font.body, textAlign: 'center' },
  // ── 0.10.0 S3 — the branch step, the two address cards and the tunnel row ──
  branchWrap: { gap: space.md },
  branchCard: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
  },
  tunnelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
});
