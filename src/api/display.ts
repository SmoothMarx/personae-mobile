/**
 * One place that turns any thrown value into the two-line shape the screens show:
 * a plain-language sentence, and the technical detail underneath it.
 */

import { isApiError, normalizeError } from './errors';

export function parseErrorForDisplay(value: unknown): string {
  const error = normalizeError(value);
  if (!isApiError(error)) return String(error);
  return error.technical ? `${error.message} (${error.technical})` : error.message;
}
