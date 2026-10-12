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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';

import type { HermesMessage } from '../../src/api/client';
import type { LiveTool } from '../../src/api/backend';
import { ApiError, normalizeError } from '../../src/api/errors';
import type { StreamHandle } from '../../src/api/transport';
import { formatTime } from '../../src/format';
import { t, useLanguage } from '../../src/i18n';
import {
  ATTACHMENT_MAX_BYTES,
  base64Of,
  fileCardLine,
  humanSize,
  stage,
  unstage,
  type StagedAttachment,
} from '../../src/logic/attachments';
import { useAudioPlayer, useAudioPlayerStatus, useAudioRecorder } from 'expo-audio';
import { AudioModule, RecordingPresets } from 'expo-audio';
import { ActionSheet } from '../../src/roster/components';
import {
  IDLE_RECORDING,
  VOICE_MIME,
  beginRecording,
  elapsedMs,
  formatDuration,
  releaseRecording,
  slideLabel,
  updateSlide,
  voiceAttachment,
  voiceNoteOf,
  type VoiceRecording,
} from '../../src/logic/voice';
import { buildItems, type ThreadItem } from '../../src/logic/thread';
import { horizontalInset } from '../../src/insets';
import { threadTitle } from '../../src/logic/roster';
import { useBackend } from '../../src/useBackend';
import { colors, font, radius, space } from '../../src/theme';

type Live = { user: string | null; text: string } | null;

/**
 * 0.9.0 H — an inbound voice note: a play button, the duration when the wire carries one, and a
 * progress-ish label. Playback goes through `expo-audio` and the media route the desktop already
 * uses as its player source (`GET /api/files/stream`, inline disposition, HTTP Range).
 */
function VoiceBubble(props: { source: string; label: string }) {
  const player = useAudioPlayer({ uri: props.source });
  const status = useAudioPlayerStatus(player);
  const playing = Boolean(status?.playing);
  return (
    <Pressable
      onPress={() => {
        if (playing) player.pause();
        else player.play();
      }}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      style={({ pressed }) => [styles.voiceBubble, pressed && styles.pressed]}
    >
      <Ionicons name={playing ? 'pause' : 'play'} size={18} color={colors.accentText} />
      <View style={styles.voiceTrack}>
        <View style={[styles.voiceProgress, { width: `${Math.min(100, Math.round((status?.currentTime ? status.currentTime / Math.max(1, status.duration || 1) : 0) * 100))}%` }]} />
      </View>
      <Text style={styles.voiceTime}>{props.label}</Text>
    </Pressable>
  );
}

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
  /**
   * 0.9.0 F (landscape) — this screen read NO safe-area insets at all through 0.8.0. In landscape the
   * cutout is on a SIDE, so the bubble list and the composer both need the horizontal inset, or the
   * first characters of every message sit under it.
   */
  const insets = useSafeAreaInsets();
  const sideInset = horizontalInset(insets);
  const sidePad = { paddingLeft: space.md + sideInset, paddingRight: space.md + sideInset };

  /**
   * 0.9.0 G — the staging strip. WhatsApp's shape: pick, see what you picked, remove one, send.
   * Nothing leaves the phone until Send, and the bytes are held as data URLs in memory only.
   */
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<{ takePictureAsync?: (options?: { base64?: boolean; quality?: number }) => Promise<{ base64?: string } | undefined> } | null>(null);
  const stageSeq = useRef(0);
  /**
   * 0.9.0 H — the recorder. Hold the mic; slide left to cancel; release to stage. The recording is
   * STAGED, not sent: it joins the same strip an attachment does, so "send" is still one gesture.
   */
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [voice, setVoice] = useState<VoiceRecording>(IDLE_RECORDING);
  const [voiceNow, setVoiceNow] = useState(0);

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

  /** The recording bar's clock: one tick a second, and only while a recording exists. */
  useEffect(() => {
    if (voice.phase === 'idle') return;
    const timer = setInterval(() => setVoiceNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [voice.phase]);

  const beginVoice = useCallback(async () => {
    if (voice.phase !== 'idle' || streaming) return;
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setAttachNote(t.thread.voice.permissionDenied);
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      setVoiceNow(Date.now());
      setVoice(beginRecording(IDLE_RECORDING, Date.now()));
    } catch (error) {
      setAttachNote(t.thread.voice.recordFailed(String((error as Error)?.message ?? error)));
    }
  }, [recorder, streaming, voice.phase]);

  const endVoice = useCallback(async () => {
    if (voice.phase === 'idle') return;
    const outcome = releaseRecording(voice, Date.now());
    setVoice(IDLE_RECORDING);
    try {
      await recorder.stop();
    } catch {
      /* a recorder that never started has nothing to stop */
    }
    if (outcome.kind === 'cancel') {
      setAttachNote(outcome.reason === 'slid' ? t.thread.voice.cancelled : t.thread.voice.tooShort);
      return;
    }
    // Read the file back as base64 and stage it, so nothing is sent until Send.
    const uri = recorder.uri;
    if (!uri) {
      setAttachNote(t.thread.voice.recordFailed('no file'));
      return;
    }
    try {
      const { File } = await import('expo-file-system');
      const base64 = await new File(uri).base64();
      const stagedVoice = voiceAttachment(outcome.durationMs, base64);
      setStaged((current) => [
        ...current,
        {
          id: `voice-${Date.now()}`,
          name: stagedVoice.name,
          mime: VOICE_MIME,
          sizeBytes: Math.floor((base64.length * 3) / 4),
          kind: 'file',
          dataUrl: stagedVoice.dataUrl,
        },
      ]);
    } catch (error) {
      setAttachNote(t.thread.voice.recordFailed(String((error as Error)?.message ?? error)));
    }
  }, [recorder, voice]);

  /** One staged item in. A refusal is SAID, never silently dropped. */
  const addStaged = useCallback((input: { name: string; dataUrl: string; mime?: string }) => {
    stageSeq.current += 1;
    const result = stage(staged, input, `att-${Date.now()}-${stageSeq.current}`);
    setStaged(result.staged);
    setAttachNote(result.refused ? t.thread.attach.refused(result.refused.name, result.refused.reason) : null);
    return result.refused === null;
  }, [staged]);

  /** WhatsApp's picker, with the two sources this app can actually reach. */
  const readClipboardImage = useCallback(async () => {
    setPickerOpen(false);
    try {
      const image = await Clipboard.getImageAsync({ format: 'png' });
      if (!image?.data) {
        setAttachNote(t.thread.attach.clipboardEmpty);
        return;
      }
      addStaged({ name: `clipboard-${Date.now()}.png`, dataUrl: image.data, mime: 'image/png' });
    } catch (error) {
      setAttachNote(t.thread.attach.clipboardFailed(String((error as Error)?.message ?? error)));
    }
  }, [addStaged]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && !staged.length) || streaming || !sessionId) return;
    setDraft('');
    setAttachNote(null);
    /**
     * 0.9.0 G — the attachment goes to the SERVER first (`image.attach_bytes`), so the agent on the
     * box can reach it; only then is the turn submitted. Attaching is not part of the stream, so a
     * failed attach leaves the strip intact and nothing is lost.
     */
    if (staged.length) {
      try {
        for (const item of staged) {
          // An image rides `image.attach_bytes`; anything else — including a voice note — rides
          // `file.attach`, whose decoder takes any media type.
          if (item.kind === 'image') await backend.attachImage(sessionId, base64Of(item.dataUrl), item.name, profile);
          else await backend.attachFile(sessionId, item.dataUrl, item.name, profile);
        }
        setStaged([]);
      } catch (error) {
        setAttachNote(normalizeError(error).message);
        return;
      }
    }
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
  }, [backend, draft, finishTurn, profile, sessionId, staged, streaming]);

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
          {/* 0.9.0 G — what the message carried: a thumbnail per image, a file card per file, and
              the caption line the bubble already draws. Tap-to-open needs an in-app viewer, which
              this release did not build — so the image is shown at full width instead of pretending
              to open something. */}
          {item.attachments.length ? (
            <View style={styles.bubbleAttachments}>
              {item.attachments.map((attachment, index) =>
                attachment.kind === 'image' && /^data:image\//i.test(attachment.source) ? (
                  <Image
                    key={`att-${index}`}
                    source={{ uri: attachment.source }}
                    style={styles.bubbleImage}
                    resizeMode="cover"
                    accessibilityIgnoresInvertColors
                    accessibilityLabel={t.thread.attach.imageLabel}
                  />
                ) : voiceNoteOf([attachment]) ? (
                  /* 0.9.0 H — "receive" as PLAYBACK: an inbound audio file is a voice note bubble. */
                  <VoiceBubble
                    key={`att-${index}`}
                    source={voiceNoteOf([attachment])!.source}
                    label={t.thread.voice.playback(voiceNoteOf([attachment])!.name)}
                  />
                ) : (
                  <View key={`att-${index}`} style={styles.fileCard}>
                    <Ionicons name="document-outline" size={16} color={colors.muted} />
                    <Text style={styles.fileCardText} numberOfLines={2}>
                      {fileCardLine(attachment)}
                    </Text>
                  </View>
                ),
              )}
            </View>
          ) : null}
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
      /* 0.9.0 F (landscape): Android needs `height`, not nothing — with no behaviour the raised
         keyboard covers the composer in a short viewport, which is the "composer swallowed" case. */
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
        contentContainerStyle={[styles.listContent, sidePad]}
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

      {/* 0.9.0 H — the recording bar. Elapsed time, and the release-to-cancel affordance: the LABEL
          flips when the thumb has slid past the cancel point, because a sent note cannot be undone. */}
      {voice.phase !== 'idle' ? (
        <View style={[styles.voiceBar, sidePad]}>
          <View style={styles.voiceDot} />
          <Text style={styles.voiceElapsed}>{formatDuration(elapsedMs(voice, voiceNow || Date.now()))}</Text>
          <Text style={styles.voiceHint}>
            {slideLabel(voice) === 'cancelling' ? t.thread.voice.releaseToCancel : t.thread.voice.slideToCancel}
          </Text>
        </View>
      ) : null}

      {/* 0.9.0 G — the staging strip: what you picked, with per-item remove. Nothing has left the
          phone yet, and a too-large item is refused WITH ITS REASON above the strip. */}
      {attachNote ? (
        <Pressable onPress={() => setAttachNote(null)} style={styles.noticeCard}>
          <Text style={styles.noticeText}>{attachNote}</Text>
          <Text style={styles.noticeClose}>{t.common.close}</Text>
        </Pressable>
      ) : null}
      {staged.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.stageStrip, sidePad]}>
          {staged.map((item) => (
            <View key={item.id} style={styles.stageItem}>
              {item.kind === 'image' ? (
                <Image source={{ uri: item.dataUrl }} style={styles.stageThumb} accessibilityIgnoresInvertColors />
              ) : (
                <View style={styles.stageFile}>
                  <Ionicons name="document-outline" size={18} color={colors.muted} />
                </View>
              )}
              <Text style={styles.stageName} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.stageMeta}>{humanSize(item.sizeBytes)}</Text>
              <Pressable
                onPress={() => setStaged((current) => unstage(current, item.id))}
                accessibilityRole="button"
                accessibilityLabel={`${t.thread.attach.remove} ${item.name}`}
                hitSlop={8}
                style={styles.stageRemove}
              >
                <Ionicons name="close-circle" size={18} color={colors.red} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.composer, sidePad]}>
        {/* WhatsApp's paperclip, at the composer's LEFT. */}
        <Pressable
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t.thread.attach.add}
          style={({ pressed }) => [styles.paperclip, pressed && styles.pressed]}
        >
          <Ionicons name="attach" size={22} color={colors.muted} />
        </Pressable>
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
        {/* 0.9.0 H — hold to record, slide left to cancel, release to stage. `onPressOut` is what
            ends the recording, so a drag off the button still resolves instead of recording forever. */}
        <Pressable
          onPressIn={() => void beginVoice()}
          onPressOut={() => void endVoice()}
          onPress={() => undefined}
          delayLongPress={0}
          accessibilityRole="button"
          accessibilityLabel={t.thread.voice.hold}
          hitSlop={8}
          style={({ pressed }) => [styles.micButton, pressed && styles.pressed]}
        >
          <Ionicons name="mic-outline" size={22} color={colors.muted} />
        </Pressable>
        <Pressable
          onPress={streaming ? stop : () => void send()}
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
      {/* ── 0.9.0 G: the picker. The two sources this app can reach without a second native
             dependency: the camera (expo-camera, already installed) and the clipboard
             (expo-clipboard, already installed). */ }
      <ActionSheet
        visible={pickerOpen}
        title={t.thread.attach.add}
        entries={[
          { key: 'camera', label: 'camera', icon: 'camera-outline' },
          { key: 'clipboard', label: 'clipboard', icon: 'clipboard-outline' },
          {
            key: 'document',
            label: 'document',
            icon: 'document-outline',
            disabled: true,
            reason: t.thread.attach.documentReason,
          },
        ]}
        labelOf={(key: string) =>
          key === 'camera'
            ? t.thread.attach.camera
            : key === 'clipboard'
              ? t.thread.attach.clipboard
              : t.thread.attach.document
        }
        onClose={() => setPickerOpen(false)}
        onPick={async (key: string) => {
          if (key === 'clipboard') {
            await readClipboardImage();
            return;
          }
          if (key === 'camera') {
            setPickerOpen(false);
            const granted = cameraPermission?.granted || (await requestCameraPermission()).granted;
            if (!granted) {
              setAttachNote(t.thread.attach.cameraDenied);
              return;
            }
            setCameraOpen(true);
            return;
          }
          setPickerOpen(false);
        }}
      />

      {/* The camera, in place: taken picture is staged, never sent on its own. */}
      <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => setCameraOpen(false)}>
        <View style={styles.cameraWrap}>
          <CameraView style={styles.camera} ref={cameraRef as never} facing="back">
            <View style={styles.cameraBar}>
              <Pressable onPress={() => setCameraOpen(false)} style={styles.cameraButton} accessibilityRole="button" accessibilityLabel={t.common.close}>
                <Text style={styles.cameraButtonText}>{t.common.close}</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  const shot = await cameraRef.current?.takePictureAsync?.({ base64: true, quality: 0.7 });
                  if (shot?.base64) {
                    addStaged({ name: `photo-${Date.now()}.jpg`, dataUrl: `data:image/jpeg;base64,${shot.base64}`, mime: 'image/jpeg' });
                    setCameraOpen(false);
                  } else {
                    setAttachNote(t.thread.attach.captureFailed);
                  }
                }}
                style={[styles.cameraButton, styles.cameraShoot]}
                accessibilityRole="button"
                accessibilityLabel={t.thread.attach.capture}
              >
                <Ionicons name="camera" size={20} color={colors.accentText} />
                <Text style={styles.cameraButtonText}>{t.thread.attach.capture}</Text>
              </Pressable>
            </View>
          </CameraView>
        </View>
      </Modal>
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
  // ── 0.9.0 G: attachments ──
  paperclip: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  stageStrip: { gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, alignItems: 'flex-start' },
  stageItem: {
    width: 92,
    padding: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    alignItems: 'center',
    gap: 2,
  },
  stageThumb: { width: 76, height: 76, borderRadius: radius.sm, backgroundColor: colors.bg },
  stageFile: { width: 76, height: 76, borderRadius: radius.sm, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  stageName: { color: colors.text, fontSize: 10, maxWidth: 80 },
  stageMeta: { color: colors.faint, fontSize: 10 },
  stageRemove: { position: 'absolute', top: 2, right: 2 },
  bubbleAttachments: { gap: 4, marginTop: 4 },
  /** A thumbnail at the bubble's own width — the bubble caps at 86%. */
  bubbleImage: { width: 220, height: 160, borderRadius: radius.sm, backgroundColor: colors.bg },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    maxWidth: 240,
  },
  fileCardText: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  cameraWrap: { flex: 1, backgroundColor: colors.bg },
  camera: { flex: 1, justifyContent: 'flex-end' },
  cameraBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.md,
    paddingBottom: space.xl,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  cameraButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md },
  cameraShoot: { backgroundColor: colors.accent },
  cameraButtonText: { color: colors.accentText, fontWeight: '700', fontSize: font.body },
  // ── 0.9.0 H: voice ──
  micButton: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  voiceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: colors.panelAlt,
  },
  voiceDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  voiceElapsed: { color: colors.text, fontSize: font.body, fontVariant: ['tabular-nums'], fontWeight: '700' },
  voiceHint: { color: colors.faint, fontSize: font.small, flex: 1 },
  voiceBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bubbleUser,
    maxWidth: 240,
  },
  voiceTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: 'hidden' },
  voiceProgress: { height: 4, backgroundColor: colors.accentText },
  voiceTime: { color: colors.accentText, fontSize: 11, fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.8 },
});
