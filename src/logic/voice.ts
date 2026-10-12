/**
 * Voice notes (0.9.0 Phase H) — hold to record, slide to cancel, release to send; and play what
 * arrives.
 *
 * ── SEND ────────────────────────────────────────────────────────────────────────────────────────
 *
 * The one new native dependency of this release is `expo-audio` (installed with `npx expo install`,
 * so the version came from the SDK and was never hand-pinned — noted out loud in `PROGRESS.md`, as
 * the goal's §1.6 requires). The alternative, `expo-av`, is published for the pre-57 line and is the
 * wrong package for this SDK.
 *
 * HOW A VOICE NOTE LEAVES THE PHONE. There is no audio-attach RPC on the dashboard's `/api/ws`
 * (measured 2026-10-12: `image.attach_bytes`, `file.attach`, `pdf.attach` exist; `audio.attach` does
 * not), so the recording rides **`file.attach`**, whose docstring is explicit that it takes *"any
 * media type (unlike the image-specific decoder)"* and stages the bytes into the session workspace,
 * returning an `@file:<ref>`. That is the same convention the TUI's `/image <path>` uses, so the
 * agent on the box has a real file to read — and the phone is not a special client.
 *
 * ── RECEIVE ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The goal notes that "receive" has two plausible meanings — the agent SENDING a voice note, and the
 * phone PLAYING one it received — and asks for both. This module treats them as one case: an inbound
 * message whose attachment is an audio file (by extension) is a voice note, and the bubble offers
 * playback. The bytes are reached over the media route the desktop already uses as its player source
 * (`GET /api/files/stream`, inline disposition, HTTP Range — `files.py:613-621`), so playback needs
 * no new route either. The ONE thing that cannot be settled without a device is whether the Android
 * media pipeline accepts the URL with the app's bearer header, and that is written down in
 * `PROGRESS.md` rather than claimed.
 */

export type VoicePhase = 'idle' | 'recording' | 'cancelling';

export type VoiceRecording = {
  phase: VoicePhase;
  /** When recording began, in epoch ms. `0` while idle. */
  startedAt: number;
  /** The hand's horizontal travel, so "slide to cancel" is a number and not a hope. */
  slideDx: number;
};

export const IDLE_RECORDING: VoiceRecording = { phase: 'idle', startedAt: 0, slideDx: 0 };

/** Slide LEFT past this to arm the cancel — WhatsApp's own gesture, made measurable. */
export const CANCEL_DX = -80;

/** Shorter than this and the note is not sent: a stray tap is not a message. */
export const MIN_DURATION_MS = 1000;

/** The maximum a single note may run, so one held thumb cannot fill the workspace. */
export const MAX_DURATION_MS = 5 * 60 * 1000;

export const VOICE_EXTENSION = '.m4a';
export const VOICE_MIME = 'audio/mp4';
const AUDIO_EXTENSIONS = ['.m4a', '.mp4', '.ogg', '.opus', '.wav', '.mp3', '.flac', '.aac', '.3gp', '.webm', '.weba'];

/** Holding the mic begins a recording. A second hold while recording is ignored. */
export function beginRecording(state: VoiceRecording, now: number): VoiceRecording {
  if (state.phase === 'recording' || state.phase === 'cancelling') return state;
  return { phase: 'recording', startedAt: now, slideDx: 0 };
}

/**
 * The thumb's travel. Past `CANCEL_DX` the gesture is in the CANCELLING phase, which is what the bar
 * says out loud (a label that flips is the whole affordance — there is no undo for a sent note).
 */
export function updateSlide(state: VoiceRecording, dx: number): VoiceRecording {
  if (state.phase === 'idle') return state;
  const travel = Number.isFinite(dx) ? dx : 0;
  return { ...state, slideDx: travel, phase: travel <= CANCEL_DX ? 'cancelling' : 'recording' };
}

export function elapsedMs(state: VoiceRecording, now: number): number {
  if (state.phase === 'idle') return 0;
  return Math.max(0, Math.min(MAX_DURATION_MS, now - state.startedAt));
}

/** "0:07", "1:42" — never a raw millisecond count in a bubble. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export type ReleaseOutcome =
  | { kind: 'cancel'; reason: 'slid' | 'too-short' }
  | { kind: 'send'; durationMs: number };

/**
 * Releasing the mic. Two ways to end with nothing sent, and BOTH are named: the slide the user
 * performed, and a hold too short to be a message.
 */
export function releaseRecording(state: VoiceRecording, now: number): ReleaseOutcome {
  if (state.phase === 'idle') return { kind: 'cancel', reason: 'too-short' };
  const duration = elapsedMs(state, now);
  if (state.phase === 'cancelling') return { kind: 'cancel', reason: 'slid' };
  if (duration < MIN_DURATION_MS) return { kind: 'cancel', reason: 'too-short' };
  return { kind: 'send', durationMs: duration };
}

/** Does the bar read "recording" or "release to cancel"? The label is the affordance. */
export function slideLabel(state: VoiceRecording): 'recording' | 'cancelling' {
  return state.phase === 'cancelling' ? 'cancelling' : 'recording';
}

// ─────────────────────────────────────────────────────── receiving ──

/** Is this an audio file, by extension? The only signal a message carries for a voice note. */
export function isVoiceNote(name: string): boolean {
  const lower = String(name ?? '').toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type VoiceNoteView = {
  /** What to hand the player: an absolute path on the box, or an inline data URL. */
  source: string;
  name: string;
  durationMs: number | null;
};

/**
 * A voice note out of a message's parsed attachments, or `null` when there is none.
 *
 * `durationMs` is `null` when the wire does not carry one — the phone cannot decode a duration it
 * was not told, and a fabricated one would be worse than an absent one.
 */
export function voiceNoteOf(
  attachments: readonly { kind: string; source: string; name: string }[],
): VoiceNoteView | null {
  const hit = attachments.find(
    (attachment) =>
      (attachment.kind === 'file' || attachment.kind === 'image') &&
      (isVoiceNote(attachment.name) || isVoiceNote(attachment.source)),
  );
  if (!hit) return null;
  return { source: hit.source, name: hit.name, durationMs: null };
}

/** The playback label: the duration when it is known, and a neutral word when it is not. */
export function voiceLabel(view: VoiceNoteView): string {
  return view.durationMs === null ? 'Voice note' : formatDuration(view.durationMs);
}

/** What the recorder hands the staging strip, once the file has been read back as base64. */
export function voiceAttachment(durationMs: number, base64: string, name?: string): {
  name: string;
  dataUrl: string;
  mime: string;
  durationMs: number;
} {
  return {
    name: name ?? `voice-${Date.now()}${VOICE_EXTENSION}`,
    dataUrl: `data:${VOICE_MIME};base64,${base64}`,
    mime: VOICE_MIME,
    durationMs,
  };
}
