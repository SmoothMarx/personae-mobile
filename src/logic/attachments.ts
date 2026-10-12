/**
 * Attachments (0.9.0 Phase G) — WhatsApp's shape, on the wire the gateway already speaks.
 *
 * WHY THERE IS NO NEW ENDPOINT, AND NO NEW SERVER FIELD (Phase 0's answer, `RECON-0.9.0.md` §2):
 * a message already carries an attachment two ways, and the app can both produce and read both:
 *
 *   images   a `content` PARTS LIST with an inline `image_url` data URL — which the thread endpoint
 *            the app already calls serves inline (`_project_for_display(inline_images=True)`), and
 *            which the app produces with the `image.attach_bytes` RPC
 *            (`tui_gateway/methods_prompt.py:849`, whose docstring names the remote client);
 *   files    an `@file:<ref>` / `@image:<path>` TEXT reference — the same convention the TUI's
 *            `/image <path>` uses, produced by `file.attach` (`:938`).
 *
 * So an attachment is reachable by the AGENT on the box (it is written into the session's own images
 * directory, or staged into its workspace), and the phone is not the only client that can read it.
 *
 * WHATSAPP'S SHAPE, verbatim from the ask: a paperclip at the composer's left, a picker, a staging
 * strip with per-item remove, send, then a bubble that shows a thumbnail (images) or a file card
 * (name, size, type) with tap-to-open, and a caption line. This module is the arithmetic and the
 * parsing behind all of that; the screen is a thin shell over it.
 */

export type AttachmentKind = 'image' | 'file';

export type StagedAttachment = {
  /** Stable per staging session, so removing one cannot remove its neighbour. */
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  kind: AttachmentKind;
  /** `data:image/png;base64,…` — what the RPC carries. Nothing else is kept in memory. */
  dataUrl: string;
};

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME = /^image\//i;

/** Images are the only thing the phone's picker can produce today; everything else is a file card. */
export function attachmentKind(mime: string, name = ''): AttachmentKind {
  if (IMAGE_MIME.test(String(mime))) return 'image';
  return /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name) ? 'image' : 'file';
}

/** "1.4 MB", "812 kB", "903 B" — never a raw byte count in a bubble the user reads. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The base64 payload of a data URL, or `''`. The RPC wants `content_base64`, not the whole URL. */
export function base64Of(dataUrl: string): string {
  const comma = String(dataUrl ?? '').indexOf(',');
  if (comma < 0) return '';
  return String(dataUrl).slice(comma + 1);
}

/** The mime a data URL declares, or `''`. */
export function mimeOf(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(String(dataUrl ?? ''));
  return match ? match[1] : '';
}

/** Bytes a data URL decodes to, from its base64 length — no decode needed, so it is cheap. */
export function bytesOfDataUrl(dataUrl: string): number {
  const b64 = base64Of(dataUrl);
  if (!b64) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export type StageResult = { staged: StagedAttachment[]; refused: { name: string; reason: string } | null };

/**
 * Add one picked item to the strip. A too-large item is REFUSED WITH ITS REASON rather than silently
 * dropped — the same rule every disabled verb in this app follows.
 */
export function stage(
  current: readonly StagedAttachment[],
  input: { name: string; dataUrl: string; mime?: string },
  id: string,
): StageResult {
  const mime = (input.mime ?? mimeOf(input.dataUrl) ?? '').trim();
  const sizeBytes = bytesOfDataUrl(input.dataUrl);
  if (!base64Of(input.dataUrl)) {
    return { staged: [...current], refused: { name: input.name, reason: 'That file was empty.' } };
  }
  if (sizeBytes > ATTACHMENT_MAX_BYTES) {
    return {
      staged: [...current],
      refused: { name: input.name, reason: `That file is ${humanSize(sizeBytes)}; the limit is 25 MB.` },
    };
  }
  const name = input.name || (attachmentKind(mime) === 'image' ? 'photo.png' : 'file');
  return {
    staged: [...current, { id, name, mime: mime || 'application/octet-stream', sizeBytes, kind: attachmentKind(mime, name), dataUrl: input.dataUrl }],
    refused: null,
  };
}

/** Per-item remove — by id, so removing one never removes its neighbour. */
export function unstage(current: readonly StagedAttachment[], id: string): StagedAttachment[] {
  return current.filter((item) => item.id !== id);
}

/**
 * The caption the turn carries. WhatsApp's rule: the caption is the message, and the attachments ride
 * with it. An empty caption is legal — a photo with no words is still a message.
 */
export function captionFor(draft: string): string {
  return draft.trim();
}

// ─────────────────────────────────────────── reading what came back ──

export type InboundAttachment = {
  kind: AttachmentKind;
  /** For an image: the inline data URL. For a file: the path the agent was given. */
  source: string;
  name: string;
  sizeBytes: number;
};

export type ParsedMessage = { text: string; attachments: InboundAttachment[] };

const IMAGE_PART = /^data:image\/[^;,]+;base64,/i;

/**
 * Split one message's `content` into what to show and what was attached.
 *
 * Handles BOTH shapes the gateway serves, because both are live in the wild:
 *   * a PARTS LIST — `[{type:'text',text}, {type:'image_url',image_url:{url:'data:image/…'}}]`;
 *   * a plain STRING — with `@image:<path>` / `@file:<path>` refs and the older
 *     `[Image attached at: <path>]` hint (the same refs the desktop's own extractor reads).
 *
 * A part that is neither renders as text, never as nothing: a message the user sent must not vanish.
 */
export function parseMessageContent(content: unknown): ParsedMessage {
  const attachments: InboundAttachment[] = [];
  const chunks: string[] = [];
  const push = (part: unknown): void => {
    if (typeof part === 'string') {
      parseStringContent(part, chunks, attachments);
      return;
    }
    if (!part || typeof part !== 'object') return;
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') {
      chunks.push(record.text);
      return;
    }
    const type = String(record.type ?? '');
    if (type === 'image_url') {
      const url = String((record.image_url as { url?: unknown } | undefined)?.url ?? '');
      if (IMAGE_PART.test(url)) {
        attachments.push({
          kind: 'image',
          source: url,
          name: nameForIndex(attachments.length),
          sizeBytes: bytesOfDataUrl(url),
        });
        return;
      }
      chunks.push(url);
      return;
    }
    chunks.push(type ? `[${type}]` : '');
  };
  if (Array.isArray(content)) content.forEach(push);
  else push(content);
  return { text: chunks.join('').trim(), attachments };
}

function nameForIndex(index: number): string {
  return `image-${index + 1}.png`;
}

const IMAGE_REF = /@image:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g;
const FILE_REF = /@file:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g;
const IMAGE_HINT = /\[Image attached at: ([^\]\n]+)\]/g;

/** A plain string: pull the refs out, keep the rest as the caption. */
function parseStringContent(text: string, chunks: string[], attachments: InboundAttachment[]): void {
  let body = String(text);
  for (const pattern of [IMAGE_REF, FILE_REF, IMAGE_HINT]) {
    body = body.replace(pattern, (_match, value: string) => {
      const trimmed = String(value);
      const inner = trimmed.length > 1 && /^[`"']/.test(trimmed) && trimmed[0] === trimmed[trimmed.length - 1]
        ? trimmed.slice(1, -1)
        : trimmed;
      const isImage = pattern === IMAGE_REF || pattern === IMAGE_HINT;
      attachments.push({
        kind: isImage ? 'image' : 'file',
        source: inner,
        name: inner.split('/').pop() || inner,
        sizeBytes: 0,
      });
      return '';
    });
  }
  const trimmed = body.replace(/[ \t]+$/gm, '').trim();
  if (trimmed) chunks.push(trimmed);
}

/** The file-card line: "report.pdf · 1.4 MB · application/pdf". */
export function fileCardLine(attachment: { name: string; sizeBytes: number; mime?: string }): string {
  const bits = [attachment.name];
  if (attachment.sizeBytes > 0) bits.push(humanSize(attachment.sizeBytes));
  if (attachment.mime) bits.push(attachment.mime);
  return bits.join(' · ');
}
