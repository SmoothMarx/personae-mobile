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

import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { t, useLanguage } from '../i18n';
import {
  candidateAddresses,
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
import { wizardSteps } from './wizard';

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
};

export default function ConnectWizard(props: WizardProps = {}) {
  useLanguage();
  const router = useRouter();
  const params = useLocalSearchParams<{ base?: string; code?: string; label?: string; expires?: string }>();
  const { settings, update, ready } = useSettings();

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
      setVerdict(await probeService(checked.value));
    } finally {
      setProbing(false);
    }
  }, [address]);

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

  const body = (
    <>
      <Text style={styles.body}>{t.connect.intro}</Text>

      <Text style={styles.step}>{stepService.title}</Text>
      <Text style={styles.label}>{t.connect.addressLabel}</Text>
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
});
