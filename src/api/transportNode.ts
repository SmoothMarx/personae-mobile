/**
 * Node-only stream transport, used by the offline test suite (`npm test`) against the mock gateway.
 *
 * IT LIVES IN ITS OWN FILE ON PURPOSE. Metro resolves every `require`/`import` it can see
 * statically, even one inside a function that is never called on a device — putting
 * `node:http` in `transport.ts` failed the release build with
 *   "Unable to resolve module node:http from src/api/transport.ts".
 * Nothing under `app/` may import this module; only `tests/`.
 *
 * It shares `SSEParser` with the app transport, so the framing logic the tests exercise is the
 * framing logic the phone runs.
 */

import http from 'node:http';

import { SSEParser, decodeFramePayload, type RawSSEFrame } from './sse';
import { StreamHttpError } from './errors';
import type { StreamCallbacks, StreamHandle, StreamRequest, StreamTransport } from './transport';

export type { StreamCallbacks, StreamHandle, StreamRequest, StreamTransport };

export const nodeTransport: StreamTransport = (request: StreamRequest, callbacks: StreamCallbacks) => {
  const url = new URL(request.url);
  const parser = new SSEParser();
  let aborted = false;
  let closed = false;

  const emit = (frame: RawSSEFrame): void => {
    const payload = decodeFramePayload(frame);
    if (!payload) return;
    callbacks.onEvent({ name: frame.event, payload, raw: frame });
  };

  const finish = (info: { aborted: boolean }): void => {
    if (closed) return;
    closed = true;
    callbacks.onClose(info);
  };

  const req = http.request(
    {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || '80',
      path: `${url.pathname}${url.search}`,
      headers: { ...request.headers, 'Content-Length': Buffer.byteLength(request.body) },
    },
    (res) => {
      callbacks.onOpen?.();
      if (res.statusCode !== 200) {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
        });
        res.on('end', () => {
          callbacks.onError(new StreamHttpError(res.statusCode ?? 0, raw.slice(0, 4000)));
          finish({ aborted });
        });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        for (const frame of parser.push(chunk)) emit(frame);
      });
      res.on('end', () => finish({ aborted }));
      res.on('error', (error: Error) => {
        callbacks.onError(error);
        finish({ aborted });
      });
    },
  );

  req.on('error', (error: Error) => {
    callbacks.onError(error);
    finish({ aborted });
  });
  req.write(request.body);
  req.end();

  return {
    close: () => {
      aborted = true;
      try {
        req.destroy?.();
      } catch {
        /* already closed */
      }
      finish({ aborted: true });
    },
  };
};
