/**
 * SSE frame parser — pure, no platform API.
 *
 * Wire format derived from gateway/platforms/api_server.py::_sse_frame (line 258) and the session
 * chat stream handler (_handle_session_chat_stream, line 3640):
 *
 *   [id: <n>\n] [event: <name>\n] data: <json>\n\n
 *   ": keepalive\n\n" every CHAT_COMPLETIONS_SSE_KEEPALIVE_SECONDS (comments, not events).
 *
 * Every event written by that handler is named, so `event:` is always present on real frames; a
 * frame without one defaults to "message" (the SSE spec default) rather than being dropped.
 */

export type RawSSEFrame = {
  event: string;
  data: string;
  id?: string;
};

/** Split a text chunk into complete frames, retaining the incomplete tail in the buffer. */
export class SSEParser {
  private buffer = '';

  constructor(private readonly maxBuffer = 2_000_000) {}

  push(chunk: string): RawSSEFrame[] {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBuffer) {
      // Degenerate input (a server that never sends a blank line). Keep the tail so the next
      // frame boundary can still be found; never grow without bound.
      this.buffer = this.buffer.slice(-this.maxBuffer);
    }
    const frames: RawSSEFrame[] = [];
    let index = this.buffer.search(/\r?\n\r?\n/);
    while (index !== -1) {
      const raw = this.buffer.slice(0, index);
      const match = this.buffer.slice(index).match(/^\r?\n\r?\n/)!;
      this.buffer = this.buffer.slice(index + match[0].length);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
      index = this.buffer.search(/\r?\n\r?\n/);
    }
    return frames;
  }

  /** Drop a trailing partial frame (used when a stream ends mid-frame). */
  reset(): void {
    this.buffer = '';
  }

  get pending(): string {
    return this.buffer;
  }
}

export function parseFrame(raw: string): RawSSEFrame | null {
  const lines = raw.split(/\r?\n/);
  const dataLines: string[] = [];
  let event = '';
  let id: string | undefined;
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // blank or comment (keepalive)
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        id = value;
        break;
      default:
        break; // retry: / unknown fields are ignored per spec
    }
  }
  if (!dataLines.length) return null;
  return { event: event || 'message', data: dataLines.join('\n'), ...(id !== undefined ? { id } : {}) };
}

/** JSON-decode a frame's data payload; returns null when the payload is not an object. */
export function decodeFramePayload(frame: RawSSEFrame): Record<string, unknown> | null {
  try {
    const value = JSON.parse(frame.data);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
