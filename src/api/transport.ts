/**
 * Transport layer for the session chat SSE stream (client side).
 *
 * One implementation ships to the device: `xhrTransport`. XMLHttpRequest delivers the SSE body
 * incrementally at readyState 3; this is the same technique every RN SSE client uses, and it lets
 * `close()` abort the request — that is the Stop button.
 *
 * The Node implementation used by the offline tests lives in `./transportNode.ts` and is imported
 * ONLY by `tests/`. Metro resolves requires statically, so a `node:http` import anywhere in this
 * file — even inside a function that is never called on a device — fails the release bundle
 * ("Unable to resolve module node:http from /work/src/api/transport.ts").
 *
 * Both transports feed the SAME `SSEParser` (./sse.ts), so the framing logic exercised by the
 * offline tests is the framing logic the phone runs.
 */

import { SSEParser, decodeFramePayload, type RawSSEFrame } from './sse';
import { StreamHttpError } from './errors';

export type StreamEvent = {
  /** SSE `event:` name, exactly as the server wrote it (run.started, assistant.delta, …). */
  name: string;
  /** Decoded JSON payload of the frame. */
  payload: Record<string, unknown>;
  raw: RawSSEFrame;
};

export type StreamCallbacks = {
  onOpen?: () => void;
  onEvent: (event: StreamEvent) => void;
  onError: (error: Error) => void;
  onClose: (info: { aborted: boolean }) => void;
};

export type StreamRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type StreamHandle = { close: () => void };

export type StreamTransport = (request: StreamRequest, callbacks: StreamCallbacks) => StreamHandle;

const seenPayloads = new WeakSet<object>();

function emit(frame: RawSSEFrame, callbacks: StreamCallbacks): void {
  const payload = decodeFramePayload(frame);
  if (!payload) return; // keepalive comments and non-object data never reach the UI
  if (seenPayloads.has(payload)) return;
  seenPayloads.add(payload);
  callbacks.onEvent({ name: frame.event, payload, raw: frame });
}

/** App transport: XMLHttpRequest with incremental responseText and a real abort path. */
export const xhrTransport: StreamTransport = (request, callbacks) => {
  const xhr = new XMLHttpRequest();
  const parser = new SSEParser();
  let consumed = 0;
  let aborted = false;
  let closed = false;

  const finish = (info: { aborted: boolean }) => {
    if (closed) return;
    closed = true;
    callbacks.onClose(info);
  };

  xhr.open('POST', request.url, true);
  for (const [key, value] of Object.entries(request.headers)) {
    try {
      xhr.setRequestHeader(key, value);
    } catch {
      /* forbidden header on some platforms — the gateway does not require it */
    }
  }
  xhr.onreadystatechange = () => {
    if (xhr.readyState === 2 || xhr.readyState === 3) {
      callbacks.onOpen?.();
    }
    if (xhr.readyState >= 3) {
      const text = xhr.responseText || '';
      if (text.length > consumed) {
        const chunk = text.slice(consumed);
        consumed = text.length;
        for (const frame of parser.push(chunk)) emit(frame, callbacks);
      }
    }
    if (xhr.readyState === 4) {
      if (xhr.status !== 200) {
        // The whole error body arrived as one non-SSE payload.
        callbacks.onError(new StreamHttpError(xhr.status, (xhr.responseText || '').slice(0, 4000)));
      }
      finish({ aborted });
    }
  };
  xhr.onerror = () => {
    callbacks.onError(new Error('network request failed'));
    finish({ aborted });
  };
  xhr.ontimeout = () => {
    callbacks.onError(new Error('request timed out'));
    finish({ aborted });
  };
  xhr.send(request.body);

  return {
    close: () => {
      aborted = true;
      try {
        xhr.abort();
      } catch {
        /* already finished */
      }
      finish({ aborted: true });
    },
  };
};
