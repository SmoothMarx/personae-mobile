/**
 * Thread — history, the composer, a live turn, and *real* details (F3), under the session's name
 * (F4).
 *
 * What changed for 0.4.0:
 *
 *  * **F3** — "Ver detalhes" used to toggle a boolean that only changed the label
 *    (`app/thread/[id].tsx:175-184` in 0.3.0): there was no expanded body, `showTools` was ONE
 *    global boolean, and reasoning was dropped before rendering. Now every run of tool/reasoning
 *    rows is its own item with real payloads, the expansion state is a `Set` keyed by item key, a
 *    tool result is joined to its call by `tool_call_id`, hidden scaffolding never renders, and
 *    reasoning gets its own "Pensamento" block. Tool activity *during* a turn arrives on the WS
 *    event channel and is shown as it happens.
 *  * **F4** — the title comes from the route param first (instant paint, no blank bar) and then
 *    from the session row once loaded, which is also how a rename lands while the screen is open.
 *    A raw id is only ever shown when no title exists anywhere.
 *  * **F2** — the composer's buttons are Ionicons with PT-PT accessibility labels.
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { HermesMessage } from '../../src/api/client';
import type { LiveTool } from '../../src/api/backend';
import { ApiError, normalizeError } from '../../src/api/errors';
import type { StreamHandle } from '../../src/api/transport';
import { formatTime } from '../../src/format';
import { t, useLanguage } from '../../src/i18n';
import { buildItems, type ThreadItem } from '../../src/logic/thread';
import { threadTitle } from '../../src/logic/roster';
import { useBackend } from '../../src/useBackend';
import { colors, font, radius, space } from '../../src/theme';

type Live = { user: string | null; text: string } | null;

export default function ThreadScreen() {
  const params = useLocalSearchParams<{ id: string; profile?: string; title?: string }>();
  const sessionId = String(params.id || '');
  const profile = String(params.profile || '');
  const paramTitle = String(params.title || '');
  const { backend, ready } = useBackend();

  const [messages, setMessages] = useState<HermesMessage[]>([]);
  // Re-render (and refresh the list cells) when the interface language changes.
  const language = useLanguage();
  const [loadedTitle, setLoadedTitle] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<Live>(null);
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Per-run expansion: a Set of item keys, never one global boolean (F3, cause 2). */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  const handleRef = useRef<StreamHandle | null>(null);
  const liveTextRef = useRef('');
  const pendingRef = useRef('');
  const errorRef = useRef<ApiError | null>(null);
  const listRef = useRef<FlatList<ThreadItem>>(null);

  const header = threadTitle({ param: paramTitle, loaded: loadedTitle, id: sessionId });

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadThread = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!sessionId) return;
      if (!options?.silent) setStatus('loading');
      try {
        const [rows, title] = await Promise.all([
          backend.messages(sessionId, profile),
          backend.sessionTitle(sessionId, profile).catch(() => null),
        ]);
        setMessages(Array.isArray(rows) ? rows : []);
        if (title) setLoadedTitle(title);
        setLoadError(null);
        setStatus('ready');
      } catch (error) {
        setLoadError(normalizeError(error));
        setStatus('error');
      }
    },
    [backend, profile, sessionId],
  );

  useEffect(() => {
    if (!ready) return;
    void loadThread();
  }, [ready, loadThread]);

  useEffect(
    () => () => {
      handleRef.current?.close();
      backend.dispose();
    },
    [backend],
  );

  const finishTurn = useCallback(
    async (aborted: boolean, error: ApiError | null) => {
      const text = liveTextRef.current;
      const asked = pendingRef.current;
      setStreaming(false);
      handleRef.current = null;
      setLive(null);
      liveTextRef.current = '';
      setLiveTools([]);

      if (error) {
        setNotice(error.message);
        if (text) {
          setMessages((prev) => [...prev, { id: `local_${Date.now()}`, role: 'assistant', content: text, timestamp: Date.now() / 1000 }]);
        }
        return;
      }
      if (aborted) {
        setNotice(t.thread.stopped);
        if (text) {
          setMessages((prev) => [...prev, { id: `local_${Date.now()}`, role: 'assistant', content: text, timestamp: Date.now() / 1000 }]);
        }
        return;
      }
      void asked;
      // Success: re-read the canonical rows so what is on screen is what the server stored.
      await loadThread({ silent: true });
    },
    [loadThread],
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
    setLiveTools([]);
    setLive({ user: text, text: '' });
    setStreaming(true);

    handleRef.current = backend.chatStream(
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
        onTool: (tool) => {
          setLiveTools((prev) => {
            const index = prev.findIndex((entry) => entry.id && entry.id === tool.id);
            if (index >= 0) {
              const next = [...prev];
              next[index] = { ...next[index], ...tool, args: tool.args || next[index].args };
              return next;
            }
            return [...prev, tool];
          });
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
  }, [backend, draft, finishTurn, profile, sessionId, streaming]);

  const stop = useCallback(() => {
    handleRef.current?.close();
  }, []);

  const items = useMemo(() => buildItems(messages), [messages]);

  const renderCall = (call: { id: string; name: string; args: string; result: string | null; ok: boolean }) => (
    <View key={call.id} style={styles.call}>
      <View style={styles.callHead}>
        <Ionicons
          name={call.ok ? 'checkmark-circle-outline' : 'alert-circle-outline'}
          size={14}
          color={call.ok ? colors.green : colors.red}
          accessibilityLabel={call.ok ? undefined : t.a11y.toolFailed}
        />
        <Text style={styles.callName}>{call.name || t.thread.orphanTool}</Text>
      </View>
      {call.args ? (
        <>
          <Text style={styles.callLabel}>{t.thread.toolArgs}</Text>
          <Text style={styles.callBody}>{call.args}</Text>
        </>
      ) : null}
      <Text style={styles.callLabel}>{t.thread.toolResult}</Text>
      <Text style={[styles.callBody, !call.ok && styles.callBodyError]}>
        {call.result ?? t.thread.toolNoResult}
      </Text>
    </View>
  );

  const renderItem = ({ item }: { item: ThreadItem }) => {
    if (item.kind === 'tools') {
      const open = expanded.has(item.key);
      return (
        <View style={styles.runCard}>
          <Pressable
            onPress={() => toggle(item.key)}
            style={styles.runHead}
            accessibilityRole="button"
            accessibilityLabel={open ? t.a11y.collapseDetails : t.a11y.expandDetails}
          >
            <Ionicons name="construct-outline" size={16} color={colors.accent} />
            <Text style={styles.runText} numberOfLines={1}>
              {t.thread.tools(item.count)}
              {item.names.length ? ` · ${item.names.join(', ')}` : ''}
            </Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.accent} />
          </Pressable>
          {open ? <View style={styles.runBody}>{item.calls.map(renderCall)}</View> : null}
        </View>
      );
    }

    if (item.kind === 'reasoning') {
      const open = expanded.has(item.key);
      return (
        <View style={styles.reasoningCard}>
          <Pressable
            onPress={() => toggle(item.key)}
            style={styles.runHead}
            accessibilityRole="button"
            accessibilityLabel={open ? t.a11y.collapseReasoning : t.a11y.expandReasoning}
          >
            <Ionicons name="bulb-outline" size={16} color={colors.amber} />
            <Text style={[styles.runText, styles.reasoningTitle]}>{t.thread.reasoning}</Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.amber} />
          </Pressable>
          {open ? <Text style={styles.reasoningBody}>{item.text}</Text> : null}
        </View>
      );
    }

    const mine = item.role === 'user';
    const other = item.role === 'other';
    return (
      <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
        <View style={[styles.bubble, mine ? styles.bubbleMine : other ? styles.bubbleOther : styles.bubbleTheirs]}>
          <Text style={styles.bubbleRole}>{mine ? t.thread.you : t.thread.agent}</Text>
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
      {liveTools.length ? (
        <View style={styles.runCard}>
          <View style={styles.runHead}>
            <Ionicons name="pulse-outline" size={16} color={colors.green} />
            <Text style={[styles.runText, styles.reasoningTitle]}>{t.thread.liveActivity}</Text>
          </View>
          <View style={styles.runBody}>
            {liveTools.map((tool) => (
              <View key={`live-${tool.id || tool.name}-${tool.phase}`} style={styles.call}>
                <View style={styles.callHead}>
                  <Ionicons
                    name={tool.phase === 'start' ? 'sync-outline' : tool.ok ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                    size={14}
                    color={tool.phase === 'start' ? colors.amber : tool.ok ? colors.green : colors.red}
                  />
                  <Text style={styles.callName}>{tool.name || t.thread.liveActivity}</Text>
                  <Text style={styles.callLabel}>
                    {tool.phase === 'start' ? t.thread.liveToolRunning : t.thread.liveToolDone}
                  </Text>
                </View>
                {tool.args ? <Text style={styles.callBody}>{tool.args}</Text> : null}
                {tool.phase === 'complete' && tool.result ? <Text style={styles.callBody}>{tool.result}</Text> : null}
              </View>
            ))}
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
            <Text style={styles.bubbleText}>{live.text || (streaming ? t.thread.thinking : '')}</Text>
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
      {/* F4: title -> id, never a raw id while a title exists. */}
      <Stack.Screen options={{ title: header.title }} />

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
        extraData={language}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={footer}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadThread({ silent: true }).finally(() => setRefreshing(false));
            }}
            tintColor={colors.accent}
          />
        }
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
        {/* F2: icon-only buttons carry a PT-PT accessibility label. */}
        <Pressable
          onPress={streaming ? stop : send}
          accessibilityRole="button"
          accessibilityLabel={streaming ? t.a11y.stop : t.a11y.send}
          style={({ pressed }) => [styles.sendButton, streaming && styles.stopButton, pressed && styles.pressed]}
        >
          <Ionicons
            name={streaming ? 'stop-circle-outline' : 'send'}
            size={22}
            color={colors.accentText}
          />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

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
  runCard: {
    borderRadius: radius.sm,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  runHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  runText: { color: colors.muted, fontSize: font.small, flex: 1 },
  runBody: { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm },
  call: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.sm,
    gap: 4,
  },
  callHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  callName: { color: colors.text, fontSize: font.small, fontWeight: '700', flexShrink: 1 },
  callLabel: { color: colors.faint, fontSize: 10, textTransform: 'uppercase', marginTop: 4 },
  callBody: {
    color: colors.muted,
    fontSize: font.small,
    fontFamily: mono,
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    padding: 6,
  },
  callBodyError: { color: '#ffb3ad' },
  reasoningCard: {
    borderRadius: radius.sm,
    backgroundColor: colors.panelAlt,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  reasoningTitle: { color: colors.amber, fontWeight: '600' },
  reasoningBody: {
    color: colors.muted,
    fontSize: font.small,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
  },
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
    width: 52,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: { backgroundColor: colors.red },
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
