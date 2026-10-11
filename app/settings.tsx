/**
 * Settings — base URL, API key, extra profiles (the multiplex prefix) and a model override.
 *
 * Rules applied (pedro-app-defaults): single-field settings save themselves (no Save button, no
 * redundant controls); the *effective* value is always displayed next to the field; the API key
 * lives in expo-secure-store and is shown only as a redacted form unless the user asks to see it;
 * clearing the key is a destructive action that names what it affects and asks first.
 */

import { File, Paths } from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { createBackend } from '../src/api/backend';
import { buildLogDocument, log } from '../src/logging';
import { parseErrorForDisplay } from '../src/api/display';
import { xhrTransport } from '../src/api/transport';
import { useConnectivity } from '../src/ConnectivityContext';
import { formatTime } from '../src/format';
import { t } from '../src/i18n';
import { contactsOf, probeFromHealth, statusColor, type Probe } from '../src/logic/roster';
import {
  checkBaseUrl,
  surfaceLabel,
  DEFAULT_SETTINGS,
  redactKey,
  splitProfiles,
  type Settings,
} from '../src/settings';
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

export default function SettingsScreen() {
  const { settings, ready, savedAt, update } = useSettings();
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS);
  const [profilesText, setProfilesText] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<TestResult[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydrated = useRef(false);

  const { diagnostic, busy, recheck, openTailscale } = useConnectivity();
  const [newRoute, setNewRoute] = useState('');
  const [routeProblem, setRouteProblem] = useState<string | null>(null);
  const routeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const routes = useMemo(() => orderRoutes(form.routes), [form.routes]);

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

  /**
   * Export log (PLAN-UI.md §9): one .txt in the cache dir, handed to the OS share sheet. Nothing is
   * uploaded. The description the user types lands at the top of the file, so a single file is
   * "log + what went wrong".
   */
  const exportLog = useCallback(async () => {
    const doc = buildLogDocument(
      {
        appVersion: '0.4.0',
        versionCode: '4',
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
      const file = new File(Paths.cache, 'personae-registo.txt');
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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>{t.settings.autoSave}</Text>
      {savedAt ? (
        <Text style={styles.savedLine}>
          {t.settings.saved} · {formatTime(savedAt)}
        </Text>
      ) : null}

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
          placeholder={form.surface === 'dashboard' ? 'Bearer do dashboard' : 'API_SERVER_KEY'}
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
          <Text style={styles.invalid}>{`Ignorado: ${droppedLines.join(', ')}`}</Text>
        ) : null}
      </View>

      <Field
        label={t.settings.model}
        help={t.settings.modelHelp}
        value={form.model}
        onChangeText={(value) => stage({ model: value.trim() })}
        autoCapitalize="none"
        autoCorrect={false}
        effective={form.model.trim() || 'modelo por omissão do gateway'}
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

      {/* ── Ligação: the tunnel trigger ───────────────────────────────────── */}
      <View style={styles.field}>
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
          <Text style={styles.effectiveValue}>{log.entries.length} linhas</Text>
        </View>
      </View>
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
  diagRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  diagLabel: { color: colors.faint, fontSize: font.small, width: 160 },
  diagValue: { color: colors.text, fontSize: font.small, flex: 1 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
