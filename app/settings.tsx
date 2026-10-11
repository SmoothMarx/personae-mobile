/**
 * Settings — base URL, API key, extra profiles (the multiplex prefix) and a model override.
 *
 * Rules applied (pedro-app-defaults): single-field settings save themselves (no Save button, no
 * redundant controls); the *effective* value is always displayed next to the field; the API key
 * lives in expo-secure-store and is shown only as a redacted form unless the user asks to see it;
 * clearing the key is a destructive action that names what it affects and asks first.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { createApi } from '../src/api/client';
import { parseErrorForDisplay } from '../src/api/display';
import { xhrTransport } from '../src/api/transport';
import { formatTime } from '../src/format';
import { t } from '../src/i18n';
import { contactsOf, probeFromHealth, statusColor, type Probe } from '../src/logic/roster';
import { checkBaseUrl, DEFAULT_SETTINGS, redactKey, splitProfiles, type Settings } from '../src/settings';
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

  const urlCheck = checkBaseUrl(form.baseUrl);
  const contacts = useMemo(() => contactsOf({ ...form, profiles: effectiveProfiles }), [form, effectiveProfiles]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setResults([]);
    const api = createApi({ ...form, profiles: effectiveProfiles }, { transport: xhrTransport, timeoutMs: 8000 });
    const collected: TestResult[] = [];
    for (const contact of contacts) {
      const started = Date.now();
      try {
        const health = await api.health(contact.profile);
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

      <Field
        label={t.settings.baseUrl}
        help={t.settings.baseUrlHelp}
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
          placeholder="API_SERVER_KEY"
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
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
