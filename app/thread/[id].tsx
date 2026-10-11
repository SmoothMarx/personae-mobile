/**
 * Thread — history (GET /api/sessions/{id}/messages), composer, streaming send
 * (POST /api/sessions/{id}/chat/stream) rendered token by token, and a real Stop button.
 *
 * Failure policy (P6): a failed stream keeps its HTTP identity and is shown; the turn then falls
 * back to the non-streaming POST /api/sessions/{id}/chat, which is announced in the UI rather than
 * silently swapped in. A notice or an error stays on screen until the user acts on it.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { createApi, type HermesApi, type HermesMessage } from '../../src/api/client';
import { ApiError, normalizeError } from '../../src/api/errors';
import { xhrTransport, type StreamHandle } from '../../src/api/transport';
import { formatAge, formatTime } from '../../src/format';
import { t } from '../../src/i18n';
import { buildItems, type ThreadItem } from '../../src/logic/thread';
import { useSettings } from '../../src/SettingsContext';
import { colors, font, radius, space } from '../../src/theme';

type Live = { user: string | null; text: string } | null;

export default function ThreadScreen() {
  const params = useLocalSearchParams<{ id: string; profile?: string }>();
  const sessionId = String(params.id || '');
  const profile = String(params.profile || '');
  const { settings, ready } = useSettings();

  const api: HermesApi = useMemo(() => createApi(settings, { transport: xhrTransport }), [settings]);

  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<Live>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);

  const handleRef = useRef<StreamHandle | null>(null);
  const liveTextRef = useRef('');
  const pendingRef = useRef('');
  const errorRef = useRef<ApiError | null>(null);
  const listRef = useRef<FlatList<ThreadItem>>(null);

  const loadMessages = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!sessionId) return;
      if (!options?.silent) setStatus('loading');
      try {
        const response = await api.messages(sessionId, profile);
        setMessages(Array.isArray(response.data) ? response.data : []);
        setLoadError(null);
        setStatus('ready');
      } catch (error) {
        setLoadError(normalizeError(error));
        setStatus('error');
      }
    },
    [api, profile, sessionId],
  );

  useEffect(() => {
    if (!ready) return;
    void loadMessages();
  }, [ready, loadMessages]);

  useEffect(
    () => () => {
      handleRef.current?.close();
    },
    [],
  );

  const finishTurn = useCallback(
    async (aborted: boolean, error: ApiError | null) => {
      const text = liveTextRef.current;
      const asked = pendingRef.current;
      setStreaming(false);
      handleRef.current = null;
      setLive(null);
      liveTextRef.current = '';

      if (aborted) {
        setNotice(t.thread.stopped);
        if (text) {
          setMessages((prev) => [...prev, { id: `local_${Date.now()}`, role: 'assistant', content: text, timestamp: Date.now() / 1000 }]);
        }
        return;
      }
      if (error) {
        setNotice(`${error.message} — ${t.thread.fellBack}`);
        try {
          const fallback = await api.chatOnce(sessionId, asked, profile);
          const content = String(fallback.message?.content ?? '');
          if (content) {
            setMessages((prev) => [...prev, { id: `local_${Date.now()}`, role: 'assistant', content, timestamp: Date.now() / 1000 }]);
          }
        } catch (fallbackError) {
          setLoadError(normalizeError(fallbackError));
          if (text) {
            setMessages((prev) => [...prev, { id: `local_${Date.now()}`, role: 'assistant', content: text, timestamp: Date.now() / 1000 }]);
          }
        }
        return;
      }
      // Success: re-read the canonical rows so what is on screen is what the gateway stored.
      await loadMessages({ silent: true });
    },
    [api, loadMessages, profile, sessionId],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || streaming || !sessionId) return;
    setDraft('');
    setNotice(null);
    setLoadError(null);
    pendingRef.current = text;
    liveTextRef.current = '';
    errorRef.current = null;
    setLive({ user: text, text: '' });
    setStreaming(true);

    handleRef.current = api.chatStream(
      sessionId,
      text,
      {
        onDelta: (delta) => {
          liveTextRef.current += delta;
          setLive((prev) => (prev ? { ...prev, text: liveTextRef.current } : { user: text, text: liveTextRef.current }));
        },
        onFinal: (content) => {
          if (content) {
            liveTextRef.current = content;
            setLive((prev) => (prev ? { ...prev, text: content } : { user: text, text: content }));
          }
        },
        onError: (error) => {
          errorRef.current = error;
        },
        onClose: ({ aborted }) => {
          void finishTurn(aborted, errorRef.current);
        },
      },
      profile,
    );
  }, [api, draft, finishTurn, profile, sessionId, streaming]);

  const stop = useCallback(() => {
    handleRef.current?.close();
  }, []);

  const items = useMemo(() => buildItems(messages), [messages]);

  const renderItem = ({ item }: { item: ThreadItem }) => {
    if (item.kind === 'tools') {
      return (
        <Pressable onPress={() => setShowTools((value) => !value)} style={styles.toolsRow}>
          <Text style={styles.toolsText}>
            {t.thread.tools(item.count)}
            {item.names.length ? ` · ${item.names.join(', ')}` : ''}
          </Text>
          <Text style={styles.toolsToggle}>{showTools ? t.thread.hideTools : t.thread.showTools}</Text>
        </Pressable>
      );
    }
    const mine = item.role === 'user';
    const other = item.role === 'other';
    return (
      <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
        <View style={[styles.bubble, mine ? styles.bubbleMine : other ? styles.bubbleOther : styles.bubbleTheirs]}>
          <Text style={styles.bubbleRole}>{mine ? t.thread.you : other ? t.thread.agent : t.thread.agent}</Text>
          <Text style={styles.bubbleText}>{item.text}</Text>
          {item.at ? <Text style={styles.bubbleMeta}>{formatTime(item.at)}</Text> : null}
        </View>
      </View>
    );
  };

  const footer = (
    <View>
      {live ? (
        <View style={[styles.bubbleRow, styles.bubbleRowMine]}>
          <View style={[styles.bubble, styles.bubbleMine]}>
            <Text style={styles.bubbleRole}>{t.thread.you}</Text>
            <Text style={styles.bubbleText}>{live.user}</Text>
          </View>
        </View>
      ) : null}
      {live ? (
        <View style={[styles.bubbleRow, styles.bubbleRowTheirs]}>
          <View style={[styles.bubble, styles.bubbleTheirs]}>
            <View style={styles.liveHead}>
              <Text style={styles.bubbleRole}>{t.thread.agent}</Text>
              <Text style={styles.liveTag}>{t.thread.streamed}</Text>
            </View>
            <Text style={styles.bubbleText}>
              {live.text || (streaming ? t.thread.thinking : '')}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <Stack.Screen options={{ title: sessionId }} />

      {notice ? (
        <Pressable onPress={() => setNotice(null)} style={styles.noticeCard}>
          <Text style={styles.noticeText}>{notice}</Text>
          <Text style={styles.noticeClose}>{t.common.close}</Text>
        </Pressable>
      ) : null}
      {loadError ? (
        <Pressable onPress={() => setLoadError(null)} style={styles.errorCard}>
          <Text style={styles.errorText}>{loadError.message}</Text>
          {loadError.technical ? <Text style={styles.errorDetail}>{loadError.technical}</Text> : null}
          <Text style={styles.noticeClose}>{t.common.close}</Text>
        </Pressable>
      ) : null}

      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={footer}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          status === 'loading' ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.emptyBody}>{t.loading}</Text>
            </View>
          ) : status === 'error' ? null : (
            <View style={styles.centered}>
              <Text style={styles.emptyBody}>{t.thread.emptyThread}</Text>
            </View>
          )
        }
      />

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t.thread.composerPlaceholder}
          placeholderTextColor={colors.faint}
          style={styles.composerInput}
          multiline
          editable={!streaming}
        />
        <Pressable
          onPress={streaming ? stop : send}
          style={({ pressed }) => [styles.sendButton, streaming && styles.stopButton, pressed && styles.pressed]}
        >
          <Text style={styles.sendText}>{streaming ? t.thread.stop : t.thread.send}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  listContent: { padding: space.md, gap: space.sm },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowTheirs: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '86%', borderRadius: radius.lg, padding: space.md, gap: 4 },
  bubbleMine: { backgroundColor: colors.bubbleUser, borderBottomRightRadius: radius.sm },
  bubbleTheirs: { backgroundColor: colors.bubbleAgent, borderBottomLeftRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  bubbleOther: { backgroundColor: colors.panelAlt, borderWidth: 1, borderColor: colors.border },
  bubbleRole: { color: colors.faint, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  bubbleText: { color: colors.text, fontSize: font.body },
  bubbleMeta: { color: colors.faint, fontSize: 10, alignSelf: 'flex-end' },
  liveHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  liveTag: { color: colors.green, fontSize: 10, fontWeight: '700' },
  toolsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    gap: space.sm,
  },
  toolsText: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  toolsToggle: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.panel,
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  sendButton: {
    width: 96,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: { backgroundColor: colors.red },
  sendText: { color: colors.accentText, fontWeight: '700', fontSize: font.body },
  centered: { alignItems: 'center', gap: space.sm, padding: space.xl },
  emptyBody: { color: colors.muted, fontSize: font.body, textAlign: 'center' },
  noticeCard: {
    margin: space.md,
    marginBottom: 0,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.amber,
    backgroundColor: '#2a2113',
    gap: 4,
  },
  noticeText: { color: '#ffe6b3', fontSize: font.small, fontWeight: '600' },
  noticeClose: { color: colors.faint, fontSize: 11 },
  errorCard: {
    margin: space.md,
    marginBottom: 0,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.red,
    backgroundColor: '#2a1416',
    gap: 4,
  },
  errorText: { color: '#ffd7d3', fontSize: font.body, fontWeight: '600' },
  errorDetail: { color: '#f0a8a2', fontSize: font.small },
  pressed: { opacity: 0.8 },
});
