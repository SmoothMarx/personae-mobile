/**
 * Runtime connectivity: the piece that actually walks out of the house.
 *
 * Subscribes to the network-change signal and to app foreground/background, and on either one it
 * re-runs the whole connect policy: bring the tunnel up if needed, probe the candidates in priority
 * order, and adopt whichever route answers. That single mechanism is why LAN → Tailscale happens
 * automatically instead of the app dying when the phone leaves the Wi-Fi.
 *
 * The network-change signal is **`expo-network`** (`Network.addNetworkStateListener`). Chosen over
 * `@react-native-community/netinfo` because it is an Expo-maintained module: it is autolinked by
 * `expo prebuild` with no extra native wiring, it is already the same major as this SDK, and it
 * reports the transport *type* (wifi vs cellular), which is exactly the transition that matters
 * here. netinfo would have worked too and would have added a second native dependency to keep
 * aligned with the SDK.
 *
 * Backgrounding discipline: nothing polls in the background. The connect loop is gated on an
 * `AppState` ref that is checked before every probe, and the whole run is cancelled when the app
 * leaves the foreground; on return to the foreground it re-probes.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { errorKindLabel } from './api/failures';
import { connectThrough, createProbeCache, probeRoute, tailscalePolicy, type ConnectResult } from './connectivity';
import { t } from './i18n';
import {
  isPackageInstalled,
  openPackage,
  probeTcp,
  triggerAvailable,
  triggerTailscaleConnect,
  vpnTransportActive,
} from './native/tailscale';
import { effectiveRoutes, hostOf, portOf, type RouteCandidate, type RouteProblem } from './routes';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import { useSettings } from './SettingsContext';

export type ConnectStage = 'idle' | 'connecting' | 'ready' | 'failed';

export type Diagnostic = {
  stage: ConnectStage;
  /** null = not yet known on this run. */
  installed: boolean | null;
  /** Cheap hint from the OS only — a competing VPN makes this true. Never proof of readiness. */
  vpnTransport: boolean | null;
  chosenRoute: RouteCandidate | null;
  /** The gateway's health route answered. NOT proof that a chat turn will work. */
  gatewayAnswering: boolean;
  everReachedGateway: boolean;
  lastErrorKind: string;
  lastTriggerResult: string;
  /** Set when the manual pin had to be ignored because no route of that role answered. */
  pinBypassed: boolean;
  rejected: { route: RouteCandidate; reason: RouteProblem }[];
  /** A ready-to-display sentence, already in the interface language. */
  message: string | null;
  /** True only on Android with the native module present. */
  canTrigger: boolean;
};

const EMPTY_DIAGNOSTIC: Diagnostic = {
  stage: 'idle',
  installed: null,
  vpnTransport: null,
  chosenRoute: null,
  gatewayAnswering: false,
  everReachedGateway: false,
  lastErrorKind: '',
  lastTriggerResult: '',
  pinBypassed: false,
  rejected: [],
  message: null,
  canTrigger: false,
};

export type ConnectivityValue = {
  /** Origin the API client should use right now; '' when no route is reachable. */
  activeUrl: string;
  diagnostic: Diagnostic;
  /** True while a connect pass is in flight. */
  busy: boolean;
  recheck: () => void;
  openTailscale: () => Promise<boolean>;
};

const ConnectivityContext = createContext<ConnectivityValue>({
  activeUrl: '',
  diagnostic: EMPTY_DIAGNOSTIC,
  busy: false,
  recheck: () => undefined,
  openTailscale: async () => false,
});

/** Unauthenticated `GET /v1/health`. The only gateway route with no auth requirement. */
async function healthProbe(url: string, timeoutMs: number): Promise<{ status: number; ok: boolean; retryAfterMs: number | null } | null> {
  const target = `${url.replace(/\/+$/, '')}/v1/health`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    const retryAfter = response.headers?.get?.('retry-after') ?? null;
    const seconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) * 1000 : null;
    return { status: response.status, ok: response.ok, retryAfterMs: seconds };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function ConnectivityProvider({ children }: { children: React.ReactNode }) {
  const { settings, ready, update } = useSettings();
  const [diagnostic, setDiagnostic] = useState<Diagnostic>(EMPTY_DIAGNOSTIC);
  const [activeUrl, setActiveUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [signal, setSignal] = useState(0);

  const settingsRef = useRef<Settings>(settings);
  settingsRef.current = settings;
  const appState = useRef<AppStateStatus>(AppState.currentState ?? 'active');
  const foreground = useRef(true);
  const runToken = useRef(0);
  /** Survives between runs on purpose: a route that is dead stays dead until the network changes. */
  const cache = useRef(createProbeCache());

  const recheck = useCallback(() => setSignal((value) => value + 1), []);

  // ── network change + foreground/background ────────────────────────────────────
  useEffect(() => {
    let subscription: { remove: () => void } | null = null;

    // Chosen signal: expo-network's own listener. Loaded defensively so a runtime without the
    // native module (tests, web) simply does not subscribe instead of throwing.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Network = require('expo-network') as {
        addNetworkStateListener?: (listener: (event: unknown) => void) => { remove: () => void };
      };
      if (typeof Network.addNetworkStateListener === 'function') {
        subscription = Network.addNetworkStateListener(() => {
          // Any transition (wifi -> cellular, tunnel up, tunnel down) invalidates every cached
          // probe: the addresses that answered a moment ago may not be reachable now.
          cache.current.reset();
          setSignal((value) => value + 1);
        });
      }
    } catch {
      subscription = null;
    }

    const appStateSub = AppState.addEventListener('change', (next) => {
      const wasForeground = appState.current === 'active';
      appState.current = next;
      foreground.current = next === 'active';
      // Leaving the foreground cancels in-flight polling; returning re-probes from scratch.
      if (next === 'active' && !wasForeground) {
        cache.current.reset();
        setSignal((value) => value + 1);
      }
    });

    return () => {
      subscription?.remove();
      appStateSub.remove();
    };
  }, []);

  // ── the connect pass ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const token = runToken.current + 1;
    runToken.current = token;
    const current = settingsRef.current;
    const routes = effectiveRoutes(current);
    const configured = Boolean(current.apiKey) && routes.length > 0;

    if (!configured) {
      setActiveUrl('');
      setDiagnostic((prev) => ({ ...prev, stage: 'idle', chosenRoute: null, gatewayAnswering: false, message: null }));
      return;
    }

    let cancelled = false;
    setBusy(true);
    setDiagnostic((prev) => ({
      ...prev,
      stage: 'connecting',
      message: null,
      everReachedGateway: current.everReachedGateway,
      canTrigger: triggerAvailable(),
    }));

    void (async () => {
      const pkg = current.tailscalePackage || DEFAULT_SETTINGS.tailscalePackage;
      const canTrigger = triggerAvailable();

      // 1. Is the client even installed? Detection needs the <queries> entry; the broadcast does not.
      const installed = canTrigger ? await isPackageInstalled(pkg) : null;
      const vpnTransport = canTrigger ? await vpnTransportActive() : null;

      // 2. Raise the tunnel ourselves — but only when the master switch is on. The broadcast is
      //    fire-and-forget, so its result proves nothing; readiness is decided by the probe below.
      const policy = tailscalePolicy(current, { canTrigger, installed });
      let triggerResult = '';
      if (policy.sendTrigger) {
        const trigger = await triggerTailscaleConnect(pkg);
        triggerResult = trigger.sent ? t.connectivity.triggerSent : t.connectivity.triggerNotSent;
      } else if (!current.autoConnect) {
        triggerResult = t.connectivity.triggerAutoOff;
      } else {
        triggerResult = t.connectivity.triggerUnavailable;
      }

      // 3. Prove readiness by probing, in strict priority order, until the deadline.
      const result: ConnectResult = await connectThrough({
        routes,
        insecureAck: current.insecureRouteAck,
        preferredRole: current.preferredRouteRole,
        probeTimeoutMs: current.probeTimeoutMs,
        deadlineMs: current.connectDeadlineMs,
        probe: probeRoute({ tcp: probeTcp, health: healthProbe }),
        cache: cache.current,
        isForeground: () => foreground.current,
      });

      if (cancelled || runToken.current !== token) return;

      const chosen = result.route;
      const reachable = chosen !== null;
      setActiveUrl(reachable ? chosen.url : '');

      const lastKind = result.permanent
        ? `permanent`
        : result.attempts.length
          ? errorKindLabelFromAttempt(result)
          : '';

      let message: string | null = null;
      if (result.reason === 'permanent') message = t.connectivity.permanentKey;
      else if (result.reason === 'backgrounded') message = null;
      else if (result.reason === 'deadline' || (result.reason === 'none-reachable' && !reachable)) {
        message = installed === false ? t.connectivity.notInstalled : t.connectivity.setupIncomplete;
        if (policy.openOnFailure) {
          void openPackage(pkg);
        }
      } else if (result.reason === 'pin-bypassed') {
        message = t.connectivity.diagPinBypassed(current.preferredRouteRole ?? '');
      }

      setDiagnostic((prev) => ({
        ...prev,
        stage: reachable ? 'ready' : 'failed',
        installed,
        vpnTransport,
        chosenRoute: chosen,
        gatewayAnswering: reachable,
        everReachedGateway: current.everReachedGateway || reachable,
        lastErrorKind: lastKind,
        lastTriggerResult: triggerResult,
        pinBypassed: result.reason === 'pin-bypassed',
        rejected: result.decision.rejected,
        message,
        canTrigger,
      }));
      setBusy(false);

      // Persist the diagnostics that are meant to survive a restart. `everReachedGateway` is the
      // only way to tell "never logged in to Tailscale" apart from "wrong port" after the fact.
      const patch: Partial<Settings> = {
        lastTriggerResult: triggerResult,
        lastErrorKind: lastKind,
      };
      if (reachable && !current.everReachedGateway) patch.everReachedGateway = true;
      if (patch.lastTriggerResult !== current.lastTriggerResult || patch.lastErrorKind !== current.lastErrorKind || patch.everReachedGateway) {
        update(patch);
      }
    })().catch(() => {
      if (cancelled || runToken.current !== token) return;
      setBusy(false);
      setDiagnostic((prev) => ({ ...prev, stage: 'failed', message: t.connectivity.setupIncomplete }));
    });

    return () => {
      cancelled = true;
    };
    // `signal` is the deliberate trigger: network change, foreground return, or a manual re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, signal, settings.baseUrl, settings.apiKey, settings.routes, settings.preferredRouteRole, settings.insecureRouteAck, settings.autoConnect, settings.tailscalePackage, settings.connectDeadlineMs, settings.probeTimeoutMs, settings.openTailscaleOnFailure]);

  const openTailscale = useCallback(async () => {
    const pkg = settingsRef.current.tailscalePackage || DEFAULT_SETTINGS.tailscalePackage;
    return openPackage(pkg);
  }, []);

  const value = useMemo<ConnectivityValue>(
    () => ({ activeUrl, diagnostic, busy, recheck, openTailscale }),
    [activeUrl, diagnostic, busy, recheck, openTailscale],
  );

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

/** The last attempt's failure class, as the diagnostics panel shows it. */
function errorKindLabelFromAttempt(result: ConnectResult): string {
  const failed = [...result.attempts].reverse().find((attempt) => !attempt.ok);
  if (!failed || !failed.failure) return '';
  return failed.detail ? `${failed.failure} · ${failed.detail}` : failed.failure;
}

export function useConnectivity(): ConnectivityValue {
  return useContext(ConnectivityContext);
}

/** The origin the API should use: the chosen route, falling back to the plain stored URL. */
export function useActiveUrl(): string {
  const { activeUrl } = useConnectivity();
  const { settings } = useSettings();
  return activeUrl || settings.baseUrl;
}

/** Host/port of a route, used by the Settings panel to describe what is being probed. */
export function routeEndpoint(route: RouteCandidate): string {
  const host = hostOf(route.url);
  const port = portOf(route.url);
  return host ? `${host}:${port ?? ''}` : route.url;
}
