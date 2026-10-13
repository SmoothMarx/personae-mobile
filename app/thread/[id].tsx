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
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
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
// 0.13.0 W3 — the draft registry: the screen CONSULTS it on a 404 and CLEARS it on the first
// successful read or submit. The mark is written by the mint, in `src/api/backend.ts`.
import { clearDraftSession, isDraftSession, type LiveTool } from '../../src/api/backend';
import { ApiError, normalizeError } from '../../src/api/errors';
import type { StreamHandle } from '../../src/api/transport';
import { formatTime } from '../../src/format';
import { t, useLanguage } from '../../src/i18n';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACH_ROWS,
  attachLabelKey,
  base64Of,
  fileCardLine,
  humanSize,
  liveLabelFor,
  stage,
  unstage,
  wireTextFor,
  type StagedAttachment,
} from '../../src/logic/attachments';
import { isStaleAnswer, slashQueryOf, spliceCompletion, type SlashItem } from '../../src/logic/slash';
// 0.12.0 — the message-body renderer. Imported here rather than beside the roster components because
// it is the thread's own body painter, and it renders the FOUR text sites below and nothing else.
import { MessageBody } from '../../src/MessageBody';
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
import { useSettings } from '../../src/SettingsContext';
import { colors, font, radius, space } from '../../src/theme';

type Live = { user: string | null; text: string } | null;

/**
 * 0.13.0 W1 — the outcome of ONE `submitTurn`, as data.
 *
 * `reason` is exactly the sentence the failure produced (`normalizeError(error).message`), or `null`
 * when nothing failed. The caller renders it; the generic turn-not-started sentence survives ONLY as
 * the fallback for an EMPTY reason — it is never passed in place of a reason the function knows.
 */
type TurnResult = { ok: boolean; reason: string | null };

/**
 * 0.11.0 R5 — how long typing pauses before the completer is asked. The menu must never hold, block or
 * slow typing, so a request is never fired per keystroke.
 */
const SLASH_DEBOUNCE_MS = 140;

/** One row of the `/` menu, as the screen holds it: what to show, and the group it belongs to. */
type SlashRow = { item: SlashItem; group: string };

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
  /**
   * 0.11.0 R3 — the mic's mode is READ FROM SETTINGS here, so this screen re-renders when the choice
   * changes. A setting that needs an app restart is not a setting.
   */
  const { settings } = useSettings();
  const micMode = settings.micMode;
  /** The latest draft, readable from a selection event (which fires with the NEW text's selection). */
  const draftRef = useRef('');
  /** 0.11.0 R7 — `true` while a turn this screen started is still running. Used to tell a truncated
   *  turn (socket gone) from a socket that closed after the work was already done. */
  const inFlight = useRef(false);

  const [messages, setMessages] = useState<HermesMessage[]>([]);
  // Re-render (and refresh the list cells) when the interface language changes.
  const language = useLanguage();

  /**
   * 0.11.0 R2 — a paperclip row's LABEL, resolved from the row.
   *
   * `app/thread/[id].tsx` used to resolve a label through a ternary chain whose final `else` was
   * `document`, so every row added without extending that chain would be labelled "Send a file" — the
   * trap this map removes by construction. An unknown key shows the key itself rather than the WRONG
   * words. Rebuilt on the language: `t` is a live view, and a cached string would freeze one language.
   */
  const attachLabels = useMemo<Record<string, string>>(
    () => ({
      camera: t.thread.attach.camera,
      photo: t.thread.attach.photo,
      document: t.thread.attach.document,
      clipboard: t.thread.attach.clipboard,
    }),
    [language],
  );
  const attachLabelOf = useCallback(
    (key: string) => {
      const labelKey = attachLabelKey(key);
      return (labelKey && attachLabels[labelKey]) || key;
    },
    [attachLabels],
  );
  const [loadedTitle, setLoadedTitle] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<Live>(null);
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /** 0.11.0 R7.b — the model's live reasoning, as it streams (`reasoning.delta`). */
  const [liveReasoning, setLiveReasoning] = useState('');
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
  /**
   * 0.11.0 R5 — the `/` menu: the query it answered, the rows, the splice index, and whether an answer
   * is still in flight. `null` = no menu. The sequence ref is the last-write-wins guard.
   */
  const [slash, setSlash] = useState<{ query: string; rows: SlashRow[]; replaceFrom: number; loading: boolean } | null>(null);
  const slashSeq = useRef(0);
  const slashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Is the caret at the END of the draft? `replace_from` is computed from the string's end, so the
   *  menu is only honest while the caret is there (§R5). */
  const caretAtEnd = useRef(true);
  /** 0.11.0 R7 — the live subscription, dropped on blur. */
  const watchRef = useRef<{ close(): void } | null>(null);

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
        // 0.13.0 W3 — the FIRST successful read retires this id's draft mark: from here on a 404 for
        // it is the error card again (a session genuinely gone, or one under another profile).
        clearDraftSession(sessionId);
      } catch (error) {
        const normalized = normalizeError(error);
        /**
         * 0.13.0 W3 — a 404 on an id THIS APP minted is a DRAFT, not an error.
         *
         * The gateway answers the same `404` + `Session not found` for a fresh id and for the
         * different-profile case, so the BODY cannot discriminate; the app can, because it knows
         * whether it minted the id. That is the only discriminator used — nothing is filtered out of
         * the banner, and the error card below is untouched for every other id.
         */
        if (normalized.status === 404 && isDraftSession(sessionId)) {
          setMessages([]);
          setLoadError(null);
          setStatus('ready');
          return;
        }
        setLoadError(normalized);
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
      watchRef.current?.close();
      watchRef.current = null;
      backend.dispose();
    },
    [backend],
  );


  const finishTurn = useCallback(
    async (aborted: boolean, error: ApiError | null) => {
      const text = liveTextRef.current;
      const asked = pendingRef.current;
      setStreaming(false);
      inFlight.current = false;
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

  /**
   * 0.11.0 R7 — THE SUBSCRIPTION. This is the item the user reported: *"your responses and reasoning
   * should show up on the conversation in real-time, it should not need a refresh from the user (exist
   * session and come back in)"*. The thread screen never attached to its own session before, so a turn
   * started anywhere else had no listener here, and the only path to its content was a fresh mount
   * re-reading the database.
   *
   * FOCUS-SCOPED (§R7, §10.12): attach on focus, detach on blur. While the phone is attached its
   * transport counts as a live peer, so a hidden thread must not keep a session pinned in the gateway —
   * and a session whose last client leaves is parked and then torn down by the server's own orphan
   * policy (§R7.d). Returning re-attaches, which is what makes the catch-up below pay off.
   *
   * The handlers are the SAME ones the composer used to pass to `chatStream`, which is what makes a
   * foreign turn paint into the bubble and the tool rows this screen already renders.
   */
  useFocusEffect(
    useCallback(() => {
      if (!ready || !sessionId) return undefined;
      let dropped = false;
      void backend
        .watchSession(
          sessionId,
          {
            onDelta: (delta) => {
              liveTextRef.current += delta;
              setLive((prev) =>
                prev ? { ...prev, text: liveTextRef.current } : { user: '', text: liveTextRef.current },
              );
            },
            onFinal: (content) => {
              if (content) {
                liveTextRef.current = content;
                setLive((prev) => (prev ? { ...prev, text: content } : { user: '', text: content }));
              }
              // `message.complete` ends the turn — for a turn started HERE and for one started on
              // another machine. It is reported by the subscription because the folded socket no longer
              // closes when a turn ends.
              void finishTurn(false, errorRef.current);
            },
            onReasoning: (text) => {
              // R7.b — the model's live reasoning, painted as it arrives. No client-side gate: the
              // server emits `reasoning.delta` only when the session displays reasoning.
              setLiveReasoning((prev) => prev + text);
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
            // A holey replay is never stitched: the thread is re-read instead (see `watchSession`).
            onRefetch: () => {
              void loadThread({ silent: true });
            },
            // A watcher that cannot attach must not look broken: the thread stays readable, on the
            // history the REST read already gave us.
            onUnavailable: () => {
              void loadThread({ silent: true });
            },
          },
          profile,
        )
        .then((handle) => {
          if (dropped) {
            handle.close();
            return;
          }
          watchRef.current = handle;
        })
        .catch(() => undefined);
      return () => {
        dropped = true;
        watchRef.current?.close();
        watchRef.current = null;
      };
    }, [backend, finishTurn, loadThread, profile, ready, sessionId]),
  );

  /**
   * 0.11.0 R8 — Android's keyboard lift, taken from the KEYBOARD's own report.
   *
   * The app is RN 0.86 / Expo 57 — the edge-to-edge era, where the Android window no longer resizes
   * under the keyboard, so `KeyboardAvoidingView`'s `behavior="height"` had nothing solid left to
   * subtract against. This is dependency-free: a listener and a padding. `react-native-keyboard-controller`
   * is the usual answer and is deliberately NOT added (§15 — the two Expo SDK pickers are this batch's
   * whole dependency budget).
   *
   * NOTHING HERE IS VERIFIED WITHOUT A DEVICE, and it is reported that way (§14): the build carries it
   * as `MANUAL: R8 keyboard lift — awaiting device confirmation`, never as PASS.
   */
  const [keyboardLift, setKeyboardLift] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      const reported = Number(event?.endCoordinates?.height ?? 0) || Number(Keyboard.metrics?.()?.height ?? 0);
      setKeyboardLift(Math.max(0, Math.round(reported)));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardLift(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  /**
   * The lift APPLIED to the composer row, floored at the safe-area inset so the composer can never be
   * left floating or below the gesture bar. On hide it resets to the inset. The Android keyboard's
   * reported height already INCLUDES the navigation bar, so the inset is not added on top of it — that
   * is the classic double-gap. iOS is untouched: its `KeyboardAvoidingView` still does the padding.
   */
  const composerLift =
    Platform.OS === 'android' ? (keyboardLift > 0 ? Math.max(keyboardLift, insets.bottom) : insets.bottom) : 0;

  /** The recording bar's clock: one tick a second, and only while a recording exists. */
  useEffect(() => {
    if (voice.phase === 'idle') return;
    const timer = setInterval(() => setVoiceNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [voice.phase]);

  /**
   * 0.11.0 R2/R4 — ONE read implementation for phone-side bytes, shared by the voice note and by both
   * pickers: `expo-file-system`'s `File(uri)`. `expo-file-system` used to resolve only because `expo`
   * depends on it (a transitive dependency doing load-bearing work under a dynamic import), so R4
   * DECLARES it — the next SDK bump cannot take the voice path with it.
   */
  const dataUrlFromUri = useCallback(async (uri: string, mime: string): Promise<string> => {
    const { File } = await import('expo-file-system');
    const base64 = await new File(uri).base64();
    return `data:${mime || 'application/octet-stream'};base64,${base64}`;
  }, []);

  /**
   * 0.11.0 R1 + R7.e — the ONE place a turn is submitted, and the order inside it is load-bearing:
   *
   *   1. every staged item is ATTACHED first, and a non-image's `refText` is COLLECTED. This is the bug
   *      behind "the voice message … is not being sent through" and, once a picker existed, "sending a
   *      file does not work" — one bug, not two: `file.attach` stages the bytes and queues NOTHING, so
   *      the reply's `@file:` ref has to ride the message text, and 0.10.0 threw that reply away;
   *   2. the WIRE text is caption + refs (`wireTextFor`), and that is what travels to the agent;
   *   3. the DISPLAY text is the caption alone, with a label when there is none, so no user ever reads
   *      `@file:/home/…` in their own bubble — and the bubble is never blank;
   *   4. only then is the turn submitted, on the socket the subscription is already riding (§R7).
   *
   * `captionFor` is untouched: it answers "what did the user type", this answers "what does the model
   * read".
   *
   * 0.13.0 W1 — it returns the OUTCOME as data (`TurnResult`), never a bare boolean, and it does NOT
   * write to the attach-note slot. Before this, a failure wrote the REAL reason into that slot here
   * and the caller overwrote it one frame later with a generic sentence: two writers, one slot, and
   * the truth destroyed by the second write. The slot now has exactly one writer — the caller — and
   * it is handed the reason so it can render it.
   */
  const submitTurn = useCallback(
    async (input: { text: string; attachments: StagedAttachment[] }): Promise<TurnResult> => {
      const refs: string[] = [];
      if (input.attachments.length) {
        try {
          for (const item of input.attachments) {
            // An image rides `image.attach_bytes` (queued server-side, consumed by the next submit);
            // anything else — including a voice note — rides `file.attach`, whose decoder takes any
            // media type, and whose ref must be carried by the text.
            if (item.kind === 'image') await backend.attachImage(sessionId, base64Of(item.dataUrl), item.name, profile);
            else {
              const attached = await backend.attachFile(sessionId, item.dataUrl, item.name, profile);
              if (attached.refText) refs.push(attached.refText);
            }
          }
        } catch (error) {
          // 0.13.0 W1 — the reason travels OUT as data, and this function stops writing the note:
          // the caller owns that slot (one writer per outcome).
          return { ok: false, reason: normalizeError(error).message };
        }
      }
      setNotice(null);
      setLoadError(null);
      pendingRef.current = input.text;
      liveTextRef.current = '';
      errorRef.current = null;
      setLiveTools([]);
      setLive({ user: liveLabelFor(input.text, input.attachments), text: '' });
      inFlight.current = true;
      setStreaming(true);

      handleRef.current = backend.chatStream(
        sessionId,
        wireTextFor(input.text, refs),
        {
          /**
           * 0.11.0 R7 — this screen's delta/tool handlers now live on the SUBSCRIPTION (below), which
           * is what makes a turn started on another machine paint into the same bubble. `onClose` is
           * therefore the ONLY thing this handle still reports, and it reports the cases the
           * subscription cannot: an interrupt, an error, or a socket that died mid-turn.
           */
          onError: (error) => {
            errorRef.current = error;
          },
          onClose: ({ aborted }) => {
            if (aborted || errorRef.current) void finishTurn(aborted, errorRef.current);
          },
        },
        profile,
      );
      // 0.13.0 W3 — a turn that STARTED is a successful use of the id, so the draft mark retires here
      // too (the other half of "cleared on the first successful read OR submit").
      clearDraftSession(sessionId);
      return { ok: true, reason: null };
    },
    [backend, finishTurn, profile, sessionId],
  );

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

  /** Stop the recorder without deciding what happens to the audio. Shared by send and cancel. */
  const stopRecorder = useCallback(async () => {
    setVoice(IDLE_RECORDING);
    try {
      await recorder.stop();
    } catch {
      /* a recorder that never started has nothing to stop */
    }
  }, [recorder]);

  /**
   * 0.11.0 R3.a — the HOLD mode's slide, WIRED.
   *
   * `updateSlide` was imported here and called NOWHERE: there was no move handler on the mic, so
   * `slideLabel` never returned 'cancelling', `CANCEL_DX` was unreachable, and the bar's "Slide left to
   * cancel, release to keep" promised a gesture that did nothing. `releaseRecording` already reads
   * `slideDx` and treats a slide past `CANCEL_DX` as a cancel — the logic was finished; only the input
   * was missing. `onMoveShouldSetPanResponder` only claims the touch once the thumb has actually
   * travelled, so a plain hold is still a hold.
   */
  const slidePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > 4,
        onPanResponderMove: (_event, gesture) => {
          setVoice((current) => updateSlide(current, gesture.dx));
        },
        onPanResponderRelease: () => undefined,
      }),
    [],
  );

  /**
   * 0.11.0 R3.b — STOPPING SENDS, in both modes.
   *
   * Not staged into the strip: the user's report is that a recorded note does not go through, and a second
   * gesture between "I recorded it" and "it was sent" is exactly what he is complaining about. The strip
   * keeps its job for images and files, where choosing and sending are genuinely two acts.
   */
  const endVoice = useCallback(
    async (options?: { cancel?: boolean }) => {
      if (voice.phase === 'idle') return;
      const outcome = releaseRecording(voice, Date.now());
      await stopRecorder();
      if (options?.cancel === true || outcome.kind === 'cancel') {
        setAttachNote(
          options?.cancel === true
            ? t.thread.voice.cancelled
            : outcome.kind === 'cancel' && outcome.reason === 'slid'
              ? t.thread.voice.cancelled
              : t.thread.voice.tooShort,
        );
        return;
      }
      const uri = recorder.uri;
      if (!uri) {
        setAttachNote(t.thread.voice.recordFailed('no file'));
        return;
      }
      try {
        const base64 = (await dataUrlFromUri(uri, VOICE_MIME)).split(',')[1] ?? '';
        const stagedVoice = voiceAttachment(outcome.durationMs, base64);
        // The caption typed before recording rides along, and is cleared like any other send.
        const caption = draft.trim();
        if (caption) setDraft('');
        const turn = await submitTurn({
          text: caption,
          attachments: [
            {
              id: `voice-${Date.now()}`,
              name: stagedVoice.name,
              mime: VOICE_MIME,
              sizeBytes: Math.floor((base64.length * 3) / 4),
              kind: 'file',
              dataUrl: stagedVoice.dataUrl,
            },
          ],
        });
        if (turn.ok) {
          // 0.13.0 W1 — CLEAR ON SUCCESS (new code, not a move): the note is reset after a turn that
          // started, so a previous failure can never be read as the outcome of this one.
          setAttachNote(null);
        } else {
          // 0.13.0 W1 — the REAL reason, rendered as data. The generic sentence below is the FALLBACK
          // and only fires when the reason is empty — never in place of a reason that IS known.
          const reason = (turn.reason ?? '').trim();
          setAttachNote(reason ? t.thread.voice.recordFailed(reason) : t.thread.voice.recordFailed('the turn did not start'));
        }
      } catch (error) {
        setAttachNote(t.thread.voice.recordFailed(String((error as Error)?.message ?? error)));
      }
    },
    [dataUrlFromUri, draft, recorder, stopRecorder, submitTurn, voice],
  );

  /** 0.11.0 R3 — tap mode's cancel: the recording is DISCARDED and nothing is sent. */
  const cancelVoice = useCallback(() => {
    void endVoice({ cancel: true });
  }, [endVoice]);

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

  /**
   * 0.11.0 R2 — the FILE picker. the user chose it ("Any file"), and it needs `expo-document-picker`, an
   * Expo SDK package at the version `expo@57.x` pins — no floating version, no third-party picker.
   *
   * THE SIZE IS CHECKED BEFORE THE BYTES ARE READ. A picker can hand over a multi-gigabyte URI, and
   * reading it to find out would be an out-of-memory on a phone; `stage()` would also refuse it, but
   * only after the whole file had been turned into a base64 string in memory.
   */
  const pickDocument = useCallback(async () => {
    setPickerOpen(false);
    try {
      const DocumentPicker = await import('expo-document-picker');
      const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      if (typeof asset.size === 'number' && asset.size > ATTACHMENT_MAX_BYTES) {
        setAttachNote(t.thread.attach.refused(asset.name ?? 'file', t.thread.attach.tooLarge));
        return;
      }
      const mime = asset.mimeType ?? '';
      const dataUrl = await dataUrlFromUri(asset.uri, mime);
      addStaged({ name: asset.name || 'file', dataUrl, mime });
    } catch (error) {
      setAttachNote(t.thread.attach.fileFailed(String((error as Error)?.message ?? error)));
    }
  }, [addStaged, dataUrlFromUri]);

  /**
   * 0.11.0 R2 — the PHOTO LIBRARY. Same shape as the camera's result (a URI + a name + a mime) and the
   * same ONE staging door: `stage()`, which enforces the 25 MB cap and returns the reason the screen
   * already displays. A refused permission is a SENTENCE, never a crash — in the same note slot the
   * camera uses.
   */
  const pickPhoto = useCallback(async () => {
    setPickerOpen(false);
    try {
      const ImagePicker = await import('expo-image-picker');
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setAttachNote(t.thread.attach.photoDenied);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      if (typeof asset.fileSize === 'number' && asset.fileSize > ATTACHMENT_MAX_BYTES) {
        setAttachNote(t.thread.attach.refused(asset.fileName ?? 'photo', t.thread.attach.tooLarge));
        return;
      }
      const name = asset.fileName ?? `photo-${Date.now()}.jpg`;
      const mime = asset.mimeType ?? 'image/jpeg';
      const dataUrl = await dataUrlFromUri(asset.uri, mime);
      addStaged({ name, dataUrl, mime });
    } catch (error) {
      setAttachNote(t.thread.attach.photoFailed(String((error as Error)?.message ?? error)));
    }
  }, [addStaged, dataUrlFromUri]);

  /** The menu closes the moment the draft stops being a `/` query — including on backspacing past it. */
  const dismissSlash = useCallback(() => {
    if (slashTimer.current) clearTimeout(slashTimer.current);
    slashSeq.current += 1;
    setSlash(null);
  }, []);

  /**
   * 0.11.0 R5 — ask the SERVER's own completer, debounced, with last-write-wins.
   *
   * Nothing here decides what a command IS: `complete.slash` answers only for a leading `/`, decides
   * `kind` (`command` / `skill`) and computes the splice index. The two rails that ARE ours:
   *
   *   * **debounce** — typing `/he` must not fire three requests;
   *   * **drop a stale answer** — a slower earlier reply must never overwrite a later one.
   *
   * A backend that cannot answer CLOSES the menu, silently and non-blockingly: a completion request
   * must never hold, block or slow typing, and must never surface an error the user did not ask for.
   */
  const querySlash = useCallback(
    (text: string) => {
      if (slashTimer.current) clearTimeout(slashTimer.current);
      const query = slashQueryOf(text, caretAtEnd.current);
      if (!query) {
        dismissSlash();
        return;
      }
      const seq = (slashSeq.current += 1);
      setSlash((prev) => ({
        query,
        rows: prev && prev.query === query ? prev.rows : [],
        replaceFrom: prev ? prev.replaceFrom : 1,
        loading: true,
      }));
      slashTimer.current = setTimeout(() => {
        void backend
          .completeSlash(sessionId, query, profile)
          .then((answer) => {
            if (isStaleAnswer(seq, slashSeq.current)) return;
            const rows: SlashRow[] = answer.items.map((item) => ({
              item,
              group: item.kind === 'skill' ? t.thread.slash.skills : t.thread.slash.commands,
            }));
            if (!rows.length) {
              setSlash(null);
              return;
            }
            setSlash({ query, rows, replaceFrom: answer.replaceFrom, loading: false });
          })
          .catch(() => {
            if (!isStaleAnswer(seq, slashSeq.current)) setSlash(null);
          });
      }, SLASH_DEBOUNCE_MS);
    },
    [backend, dismissSlash, profile, sessionId],
  );

  /**
   * 0.11.0 R5 — tapping a row INSERTS; it does not send. The splice happens at the server's
   * `replace_from`, then the menu RE-QUERIES with the new text — which is what surfaces a command's
   * argument stage (`/model `) instead of closing the menu on it.
   */
  const applySlashItem = useCallback(
    (item: SlashItem) => {
      const next = spliceCompletion(draft, slash ? slash.replaceFrom : 1, item.text);
      setDraft(next);
      caretAtEnd.current = true;
      querySlash(next);
    },
    [draft, querySlash, slash],
  );

  /**
   * 0.11.0 R6 (approach A, confirmed by the user) — a draft that starts with `/` is a COMMAND.
   *
   * `prompt.submit` has NO slash handling: without this, tapping `/help` and pressing send would submit
   * the literal string "/help" as a prompt — handing the user dead text. The output goes in the notice
   * card that already exists (`attachNote`, the slot the attachment refusals use).
   *
   * §R6.b — a command turn opens NO stream: no `chatStream`, no `setStreaming(true)`, no live bubble, so
   * the composer is never left disabled behind a stream that was never started.
   *
   * §R6.c — the limitation, stated rather than papered over: the output is TRANSIENT. It lives in a
   * card, not in the transcript, so it does not survive a thread refresh and does not scroll with the
   * conversation. A real row is approach B, declined for this build.
   */
  const runCommand = useCallback(
    async (command: string) => {
      setDraft('');
      dismissSlash();
      setAttachNote(null);
      try {
        const result = await backend.runSlashCommand(sessionId, command, profile);
        setAttachNote(result.output || t.thread.slash.noOutput);
      } catch (error) {
        // A failed command SAYS SO. Nothing vanishes silently.
        setAttachNote(t.thread.slash.failed(normalizeError(error).message));
      }
    },
    [backend, dismissSlash, profile, sessionId],
  );

  /**
   * 0.11.0 R6.a/R7.e — the guard runs FIRST, then the `/` interception, then the compose-and-submit.
   *
   * The guard is CORRECT AS WRITTEN and stays a guard rather than becoming the fix: with an empty wire
   * text the turn would still carry nothing the agent can open. A command sent together with a staged
   * attachment is out of scope — send the file first.
   */
  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && !staged.length) || streaming || !sessionId) return;
    dismissSlash();
    if (text.startsWith('/')) {
      await runCommand(text);
      return;
    }
    setDraft('');
    setAttachNote(null);
    const turn = await submitTurn({ text, attachments: staged });
    if (turn.ok) {
      // 0.13.0 W1 — the clear-on-success on the TEXT path as well: a previous failure can never be
      // read as this turn's outcome (the clear is new code; the five note writes were all failures).
      setStaged([]);
      setAttachNote(null);
    } else if ((turn.reason ?? '').trim()) {
      // 0.13.0 W1 — the REAL reason, said out loud instead of being dropped: with the write inside
      // `submitTurn` gone, this is the only writer on this path. An EMPTY reason renders nothing new
      // (the note was cleared above); no generic sentence is invented for a path that never had one.
      setAttachNote((turn.reason ?? '').trim());
    }
  }, [dismissSlash, draft, runCommand, staged, streaming, submitTurn]);

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
          {open ? <MessageBody text={item.text} style={styles.reasoningBody} /> : null}
        </View>
      );
    }

    const mine = item.role === 'user';
    const other = item.role === 'other';
    return (
      <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
        <View style={[styles.bubble, mine ? styles.bubbleMine : other ? styles.bubbleOther : styles.bubbleTheirs]}>
          <Text style={styles.bubbleRole}>{mine ? t.thread.you : t.thread.agent}</Text>
          <MessageBody text={item.text} style={styles.bubbleText} />
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
      {/* 0.11.0 R7.b — the LIVE reasoning block. `reasoning.delta` was already on the wire
          (`agent_callbacks.py:135-138`) and the client's five-case switch dropped it, so reasoning only
          ever appeared after a re-entry, read back from the stored transcript. It renders with the
          existing reasoning card, and is shown OPEN while it streams: the user asked to see the reasoning
          in real time. */}
      {liveReasoning ? (
        <View style={styles.reasoningCard}>
          <View style={styles.runHead}>
            <Ionicons name="bulb-outline" size={16} color={colors.amber} />
            <Text style={[styles.runText, styles.reasoningTitle]}>{t.thread.reasoning}</Text>
          </View>
          <Text style={styles.reasoningBody} numberOfLines={10}>
            {liveReasoning}
          </Text>
        </View>
      ) : null}
      {/* R1 — the user's own bubble carries the CAPTION, never the `@file:` refs, and exists only when
          there is something to show: a turn started on another machine has no caption to echo. */}
      {live && live.user ? (
        <View style={[styles.bubbleRow, styles.bubbleRowMine]}>
          <View style={[styles.bubble, styles.bubbleMine]}>
            <Text style={styles.bubbleRole}>{t.thread.you}</Text>
            <MessageBody text={live.user} style={styles.bubbleText} />
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
            <MessageBody text={live.text || (streaming ? t.thread.thinking : '')} streaming={streaming} style={styles.bubbleText} />
          </View>
        </View>
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      /* 0.11.0 R8 — Android gets NO KAV behaviour any more. 0.9.0 gave it `height` on the reading that
         "with no behaviour the raised keyboard covers the composer"; on RN 0.86 / Expo 57 the Android
         window no longer resizes under the keyboard (edge-to-edge), so `height` has nothing solid left to
         subtract against — and the user's report is exactly the composer staying hidden. The lift is now
         applied directly, as padding on the composer container, from the keyboard's own report
         (`composerLift`). Two spacers fighting is the classic double-gap, so Android gets ONE. iOS keeps
         `padding` plus its offset, untouched. */
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
            {micMode === 'tap'
              ? t.thread.voice.tapHint
              : slideLabel(voice) === 'cancelling'
                ? t.thread.voice.releaseToCancel
                : t.thread.voice.slideToCancel}
          </Text>
          {/* 0.11.0 R3 — tap mode has no drag, so CANCEL must be a button here: a mode with no way to
              abort a recording is a trap. In hold mode the gesture IS the affordance (slide left past
              CANCEL_DX), so this control is not drawn. */}
          {micMode === 'tap' ? (
            <Pressable
              onPress={cancelVoice}
              accessibilityRole="button"
              accessibilityLabel={t.thread.voice.cancel}
              hitSlop={8}
              style={({ pressed }) => [styles.voiceCancel, pressed && styles.pressed]}
            >
              <Ionicons name="close" size={16} color={colors.accentText} />
            </Pressable>
          ) : null}
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

      {/* 0.11.0 R8 — the ONE lifted container: the `/` menu and the composer row move TOGETHER. On
          Android the KAV itself no longer moves (§R8), so the menu has to live inside this box; a
          command menu that stays behind the keyboard is worse than no menu at all. The lift itself is
          the composer row's own `paddingBottom` below. */}
      <View>
        {/* 0.11.0 R5 — the `/` menu: a PLAIN view in the flow, directly above the composer row, never a
            `Modal` (so it has no keyboard math of its own). The rows are the SERVER's list; no new
            dependency and no new socket (§10.10). */}
        {slash ? (
          <View style={[styles.slashMenu, sidePad]}>
            <Text style={styles.slashTitle}>{t.thread.slash.title}</Text>
            {!slash.rows.length ? (
              <Text style={styles.slashNote}>
                {slash.loading ? t.thread.slash.loading : t.thread.slash.empty}
              </Text>
            ) : null}
            <ScrollView style={styles.slashList} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
              {slash.rows.map((row) => (
                <Pressable
                  key={`${row.item.kind}-${row.item.text}`}
                  onPress={() => applySlashItem(row.item)}
                  accessibilityRole="button"
                  accessibilityLabel={row.item.display}
                  style={({ pressed }) => [styles.slashRow, pressed && styles.pressed]}
                >
                  <View style={styles.slashRowText}>
                    <Text style={styles.slashRowLabel} numberOfLines={1}>
                      {row.item.display}
                    </Text>
                    {row.item.meta ? (
                      <Text style={styles.slashMeta} numberOfLines={1}>
                        {row.item.meta}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.slashGroup}>{row.group}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}
        <View style={[styles.composer, sidePad, { paddingBottom: space.md + composerLift }]}>
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
          onChangeText={(value) => {
            draftRef.current = value;
            setDraft(value);
            // 0.11.0 R5 — every keystroke re-asks, debounced and last-write-wins. A draft that stops
            // starting with `/` (or a caret parked mid-text) CLOSES the menu instead of leaving a stale
            // list on screen.
            querySlash(value);
          }}
          onSelectionChange={(event) => {
            // `replace_from` is computed from the STRING'S END, so the menu is only honest with the caret
            // there (§R5). The menu hides rather than splicing into a guess.
            caretAtEnd.current = event.nativeEvent.selection.end >= draftRef.current.length;
          }}
          onBlur={dismissSlash}
          placeholder={t.thread.composerPlaceholder}
          placeholderTextColor={colors.faint}
          style={styles.composerInput}
          multiline
          editable={!streaming}
        />
        {/* F2: icon-only buttons carry a PT-PT accessibility label. */}
        {/* 0.11.0 R3 — the mic, in the mode the user chose. The GLYPH follows the gesture: in 'tap' mode
            a recording turns the button into a red STOP square (the user's own words), and in 'hold' mode it
            stays the mic, because while a thumb is held down a stop square offers nothing to act on.
            `releaseRecording` and the recorder's state machine are untouched — the mode adds an entry
            point and an icon, it does not fork the machine (R3.c). */}
        <Pressable
          {...(micMode === 'hold' ? slidePan.panHandlers : {})}
          onPressIn={micMode === 'hold' ? () => void beginVoice() : undefined}
          onPressOut={micMode === 'hold' ? () => void endVoice() : undefined}
          onPress={micMode === 'tap' ? () => (voice.phase === 'idle' ? void beginVoice() : void endVoice()) : () => undefined}
          delayLongPress={0}
          accessibilityRole="button"
          accessibilityLabel={
            micMode === 'tap'
              ? voice.phase === 'idle'
                ? t.thread.voice.start
                : t.thread.voice.stop
              : t.thread.voice.hold
          }
          hitSlop={8}
          style={({ pressed }) => [
            styles.micButton,
            micMode === 'tap' && voice.phase !== 'idle' && styles.micButtonStop,
            pressed && styles.pressed,
          ]}
        >
          <Ionicons
            name={micMode === 'tap' && voice.phase !== 'idle' ? 'stop' : 'mic-outline'}
            size={22}
            color={micMode === 'tap' && voice.phase !== 'idle' ? colors.accentText : colors.muted}
          />
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
      </View>
      {/* ── 0.11.0 R2: the picker. FOUR sources now, and the rows come from `ATTACH_ROWS` so a row's
             label is looked up by its own key. Re-enabled: the `document` row (it is no longer
             `disabled` — the picker exists) and the new photo-library row. the user chose the sources:
             "Any file + the photo library". ── */}
      <ActionSheet
        visible={pickerOpen}
        title={t.thread.attach.add}
        entries={ATTACH_ROWS.map((row) => ({ key: row.id, label: row.id, icon: row.icon }))}
        labelOf={attachLabelOf}
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
          if (key === 'photo') {
            await pickPhoto();
            return;
          }
          if (key === 'document') {
            await pickDocument();
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
  /** 0.11.0 R3 — the tap mode's controls: a red STOP square on the mic, and a cancel button on the bar. */
  micButtonStop: { backgroundColor: colors.red, borderRadius: radius.sm },
  voiceCancel: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ── 0.11.0 R5: the `/` menu, inside the composer's own box ──
  slashMenu: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.panelAlt,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    gap: 2,
  },
  slashTitle: { color: colors.faint, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  slashNote: { color: colors.muted, fontSize: font.small },
  /** Bounded, so a long command list cannot push the composer off the screen. */
  slashList: { maxHeight: 180 },
  slashRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 6,
  },
  slashRowText: { flex: 1 },
  slashRowLabel: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  slashMeta: { color: colors.faint, fontSize: 10 },
  slashGroup: { color: colors.accent, fontSize: 10, fontWeight: '700' },
  pressed: { opacity: 0.8 },
});
