/**
 * A faithful stub of react-native 0.86.3's `XMLHttpRequest`, for exercising `xhrTransport`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The rest of the offline suite drives `nodeTransport`, because Node has no XMLHttpRequest. But
 * react-native's `abort()` behaves differently from node's: it resets `status` to 0 and then
 * dispatches `readystatechange` SYNCHRONOUSLY at `readyState === 4`. That difference hid a real
 * defect — on every *successful* streamed turn the client closed the stream after the `done`
 * frame, the resulting self-inflicted abort looked like `HTTP 0`, and the thread's error branch
 * re-sent the user's message through `chatOnce()`.
 *
 * The suite and that defect lived on different transports, so 40/40 tests could not see it.
 * These semantics are copied from the installed
 * `node_modules/react-native/Libraries/Network/XMLHttpRequest.js`:
 *   - `_reset()` sets `this.status = 0`                                  (~line 189-192)
 *   - `abort()` does `_reset()` then `setReadyState(this.DONE)`           (~line 654-673)
 *   - `setReadyState()` dispatches `readystatechange` synchronously       (~line 687-689)
 */

export type RnXhrScript = {
  /** Final HTTP status. Anything other than 200 is delivered as one non-SSE body. */
  status?: number;
  /** Body used for a non-200 response. */
  body?: string;
  /** SSE chunks, each delivered as a separate LOADING event, then a real DONE. */
  chunks?: string[];
  /** Milliseconds between events. Keep small; the suite must stay fast. */
  stepMs?: number;
};

/** Install the stub as the global XMLHttpRequest. Returns a restore function; always call it. */
export function installRnXhr(script: RnXhrScript): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.XMLHttpRequest;
  const step = script.stepMs ?? 5;

  class RNLikeXHR {
    UNSENT = 0;
    OPENED = 1;
    HEADERS_RECEIVED = 2;
    LOADING = 3;
    DONE = 4;

    readyState = 0;
    status = 0;
    responseText = '';

    private sent = false;
    private timers: ReturnType<typeof setTimeout>[] = [];

    onreadystatechange: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;

    open(): void {
      this.setReadyState(this.OPENED);
    }

    setRequestHeader(): void {
      /* no-op */
    }

    send(): void {
      this.sent = true;
      const status = script.status ?? 200;

      if (status !== 200) {
        this.timers.push(
          setTimeout(() => {
            this.status = status;
            this.responseText = script.body ?? '';
            this.setReadyState(this.HEADERS_RECEIVED);
            this.setReadyState(this.DONE);
          }, step),
        );
        return;
      }

      let t = step;
      this.timers.push(
        setTimeout(() => {
          this.status = 200;
          this.setReadyState(this.HEADERS_RECEIVED);
        }, t),
      );
      for (const chunk of script.chunks ?? []) {
        t += step;
        this.timers.push(
          setTimeout(() => {
            this.responseText += chunk;
            this.setReadyState(this.LOADING);
          }, t),
        );
      }
      t += step;
      this.timers.push(setTimeout(() => this.setReadyState(this.DONE), t));
    }

    private reset(): void {
      this.readyState = this.UNSENT;
      this.status = 0;
      this.responseText = '';
      this.sent = false;
      for (const id of this.timers) clearTimeout(id);
      this.timers = [];
    }

    abort(): void {
      // Mirrors react-native: only reset if there is something to abort, per spec.
      if (
        !(
          this.readyState === this.UNSENT ||
          (this.readyState === this.OPENED && !this.sent) ||
          this.readyState === this.DONE
        )
      ) {
        this.reset();
        this.setReadyState(this.DONE);
      }
      // Reset again after, in case the handler modified state.
      this.reset();
    }

    setReadyState(state: number): void {
      this.readyState = state;
      this.onreadystatechange?.();
    }
  }

  globals.XMLHttpRequest = RNLikeXHR;
  return () => {
    globals.XMLHttpRequest = previous;
  };
}

/** A minimal successful run: two deltas, a final, run.completed, then done. */
export const SSE_OK: string[] = [
  'event: run.started\ndata: {"run_id":"r1"}\n\n',
  'event: assistant.delta\ndata: {"delta":"Ol"}\n\n',
  'event: assistant.delta\ndata: {"delta":"á"}\n\n',
  'event: assistant.completed\ndata: {"content":"Olá"}\n\n',
  'event: run.completed\ndata: {}\n\n',
  'event: done\ndata: {}\n\n',
];
