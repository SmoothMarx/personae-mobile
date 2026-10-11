/**
 * Dates, figures and previews — display-only helpers.
 *
 * pedro-app-defaults: dates display DD-MM-YYYY everywhere; decimal comma in the locale's numbers.
 * Storage/API timestamps are epoch seconds (Python `time.time()`) and are never reformatted on
 * the wire — only here, at render time.
 */

import { t } from './i18n';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/** Epoch seconds (or ms) -> DD-MM-YYYY. Empty stays empty: never invent a value. */
export function formatDate(input?: number | null): string {
  const ms = toMillis(input);
  if (ms === null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = MONTHS[d.getMonth()];
  return `${day}-${month}-${d.getFullYear()}`;
}

export function formatTime(input?: number | null): string {
  const ms = toMillis(input);
  if (ms === null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatDateTime(input?: number | null): string {
  const date = formatDate(input);
  const time = formatTime(input);
  if (!date) return '';
  return time ? `${date} ${time}` : date;
}

/** "há 3 min" style age, computed against an explicit now for testability. */
export function formatAge(input?: number | null, now = Date.now()): string {
  const ms = toMillis(input);
  if (ms === null) return '';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return t.time.justNow;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t.time.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t.time.hoursAgo(hours);
  const days = Math.round(hours / 24);
  if (days < 30) return t.time.daysAgo(days);
  return formatDate(ms);
}

export function dayKey(input?: number | null): string {
  const ms = toMillis(input);
  if (ms === null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function toMillis(input?: number | null): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return null;
  // The gateway emits epoch SECONDS (time.time()). Anything past year 2286 in seconds is
  // already milliseconds, so this is a safe heuristic rather than a guess about the source.
  return input > 10_000_000_000 ? input : Math.round(input * 1000);
}

/** Initial letter for an avatar. Returns '' for an unknown name rather than a placeholder glyph. */
export function initialOf(name?: string | null): string {
  const value = (name || '').trim();
  if (!value) return '';
  const match = value.match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : '';
}

/** Message content may be a string or a multimodal part list (server-normalised). */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
          if (record.type === 'image_url') return '[imagem]';
          if (typeof record.type === 'string') return `[${record.type}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
  }
  return '';
}

export function firstLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatCount(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return String(Math.trunc(value));
}

/** Minutes as an hour figure with a decimal comma ("12,5 h"), matching the locale. */
export function formatHours(minutes?: number | null): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '';
  return `${(minutes / 60).toFixed(1).replace('.', ',')} h`;
}
