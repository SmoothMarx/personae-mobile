/**
 * Typed API errors.
 *
 * The gateway's error envelope is derived from api_server.py::_openai_error (line 933):
 *   { "error": { "message": str, "type": str, "param": str|None, "code": str|None } }
 * and the auth failure (line 1580) is exactly:
 *   { "error": { "message": "Invalid gateway API key (API_SERVER_KEY)",
 *                "type": "gateway_auth_error", "code": "gateway_auth_failed" } } with HTTP 401.
 *
 * P6 requires that a wrong URL or a wrong key produces a *specific, visible* error and never a
 * silent failure, so every failure path carries a user-facing sentence plus the raw detail.
 */

import { t } from '../i18n';

export type ErrorKind =
  | 'config'
  | 'network'
  | 'timeout'
  | 'http'
  | 'parse'
  | 'stream';

export class ApiError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly detail?: string;

  constructor(
    message: string,
    opts: { kind: ErrorKind; status?: number; code?: string; type?: string; detail?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.code = opts.code;
    this.type = opts.type;
    this.detail = opts.detail;
  }

  /** Short technical suffix shown under the plain-language sentence. */
  get technical(): string {
    const bits = [this.status ? `HTTP ${this.status}` : null, this.code || this.type || null, this.detail || null];
    return bits.filter(Boolean).join(' · ');
  }

  get isAuth(): boolean {
    return this.status === 401 || this.code === 'gateway_auth_failed';
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Raised by a stream transport when the SSE request itself failed before the stream opened
 * (non-200 response). Carries the status and the raw body so the client can map it through the
 * normal HTTP error ladder instead of flattening every transport failure into "stream dropped".
 */
export class StreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'StreamHttpError';
  }
}

export function normalizeError(value: unknown): ApiError {
  if (isApiError(value)) return value;
  const detail = value instanceof Error ? value.message : String(value);
  return new ApiError(t.errors.network(detail), { kind: 'network', detail });
}

/** Map an HTTP response body + status onto a specific ApiError. */
export function httpError(status: number, body: unknown, profile?: string): ApiError {
  // Two envelope shapes exist on this server:
  //   handlers            -> {"error": {"message", "type", "param", "code"}}  (_openai_error :933)
  //   profile middleware  -> {"error": "Unknown or unconfigured profile"}     (:1726)
  const rawError = (body as { error?: unknown } | null)?.error;
  const envelope =
    rawError && typeof rawError === 'object'
      ? (rawError as { message?: string; type?: string; code?: string })
      : undefined;
  const serverMessage = envelope?.message || (typeof rawError === 'string' ? rawError : '');
  const code = envelope?.code;
  const type = envelope?.type;

  if (status === 401) {
    const message = profile ? t.errors.unauthorizedProfile(profile) : t.errors.unauthorized;
    return new ApiError(message, { kind: 'http', status, code, type, detail: serverMessage });
  }
  if (status === 404) {
    const what = serverMessage || 'O recurso';
    return new ApiError(t.errors.notFound(what), { kind: 'http', status, code, type, detail: serverMessage });
  }
  if (status >= 500) {
    const detail = serverMessage || 'erro interno';
    return new ApiError(t.errors.server(status, detail), { kind: 'http', status, code, type, detail });
  }
  const detail = serverMessage || `HTTP ${status}`;
  return new ApiError(t.errors.server(status, detail), { kind: 'http', status, code, type, detail });
}
