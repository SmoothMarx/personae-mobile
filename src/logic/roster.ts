/**
 * Roster/Thread presentation logic — pure functions, no React, no network.
 *
 * Kept separate from the screens so the offline test suite can assert the exact things the screens
 * render (grouping, pagination labels, "new since last visit" counts, status-dot priority) without
 * a device or a renderer.
 */

import { formatAge, formatDate, firstLine, initialOf, toMillis } from '../format';
import { t } from '../i18n';
import type { HermesSession } from '../api/client';
import { profilePrefix, type Settings } from '../settings';

export type Contact = {
  /** Value used for the /p/<profile>/ prefix ('' = the gateway's own/default profile). */
  profile: string;
  /** What the user sees. Empty profile shows the plain label, never an internal id. */
  label: string;
  isPrimary: boolean;
  prefix: string;
};

export type ProbeStatus = 'ok' | 'degraded' | 'down' | 'auth' | 'unknown';

export type Probe = {
  status: ProbeStatus;
  version?: string;
  detail?: string;
};

/**
 * Contacts = the gateway's own profile first, then every extra profile from Settings.
 * The server exposes no /api/profiles route (see QUESTIONS.md Q2), so the list is user-declared.
 */
export function contactsOf(settings: Settings): Contact[] {
  const contacts: Contact[] = [{ profile: '', label: t.roster.primary, isPrimary: true, prefix: '' }];
  for (const name of settings.profiles) {
    contacts.push({ profile: name, label: name, isPrimary: false, prefix: profilePrefix(name) });
  }
  return contacts;
}

/** Status-dot priority: auth > down > degraded > ok > unknown. */
export function probeFromHealth(response: { status?: string; version?: string } | null, error?: unknown): Probe {
  if (error) {
    const withStatus = error as { status?: number; isAuth?: boolean };
    if (withStatus.isAuth || withStatus.status === 401) {
      return { status: 'auth', detail: t.status.auth };
    }
    return { status: 'down', detail: t.status.down };
  }
  if (!response) return { status: 'unknown', detail: t.status.unknown };
  if (response.status === 'ok') return { status: 'ok', version: response.version };
  return { status: 'degraded', version: response.version, detail: t.status.degraded };
}

export function statusColor(status: ProbeStatus, palette: { green: string; amber: string; red: string; grey: string }): string {
  switch (status) {
    case 'ok':
      return palette.green;
    case 'degraded':
      return palette.amber;
    case 'down':
    case 'auth':
      return palette.red;
    default:
      return palette.grey;
  }
}

export type SessionRow = {
  id: string;
  title: string;
  preview: string;
  initial: string;
  age: string;
  date: string;
  count: string;
  model: string;
  pinned: boolean;
  /** Newer than the last time this profile was opened on this phone. */
  isNew: boolean;
};

export function sessionTitle(session: HermesSession): string {
  const title = (session.title || '').trim();
  if (title) return title;
  // No invented names (pedro-app-defaults): fall back to the id, which is what the user can match
  // against `hermes sessions` on the box.
  return session.id;
}

export function toRow(session: HermesSession, lastSeenMs: number, now = Date.now()): SessionRow {
  const lastActive = toMillis(session.last_active ?? session.started_at);
  const body = (session.preview || '').trim();
  return {
    id: session.id,
    title: sessionTitle(session),
    preview: body ? firstLine(body) : '',
    initial: initialOf(sessionTitle(session)),
    age: lastActive ? formatAge(lastActive, now) : '',
    date: formatDate(lastActive),
    count: typeof session.message_count === 'number' ? String(session.message_count) : '',
    model: (session.model || '').trim(),
    pinned: Boolean(session.pinned),
    isNew: lastActive !== null && lastActive > lastSeenMs,
  };
}

/**
 * The thread's top-bar title (F4).
 *
 * The bug: `app/index.tsx` pushed `{id, profile}` without the title the row already had, and the
 * thread screen set `title: sessionId` — so a raw id was shown while a title existed.
 *
 * The chain is title -> id, in that order, and the *source* of the title is the route param first
 * (instant paint on a cold open, no blank bar) then the loaded row (authoritative — that is how a
 * rename lands while the screen is open, since `PATCH /api/sessions/{id}` returns the new title
 * and `GET /api/sessions/{id}` re-reads it).
 */
export function threadTitle(input: { param?: string | null; loaded?: string | null; id: string }): {
  title: string;
  /** True when nothing but the id was available — the screen may style it as a placeholder. */
  isId: boolean;
} {
  const param = (input.param || '').trim();
  if (param) return { title: param, isId: false };
  const loaded = (input.loaded || '').trim();
  if (loaded) return { title: loaded, isId: false };
  return { title: input.id, isId: true };
}

export function countNew(sessions: HermesSession[], lastSeenMs: number): number {
  let count = 0;
  for (const session of sessions) {
    const lastActive = toMillis(session.last_active ?? session.started_at);
    if (lastActive !== null && lastActive > lastSeenMs) count += 1;
  }
  return count;
}

export type RowGroup = { key: string; label: string; rows: SessionRow[] };

/** Group by day, newest first — the group header repeats across pages (pedro-app-defaults). */
export function groupByDay(rows: SessionRow[]): RowGroup[] {
  const groups: RowGroup[] = [];
  const index = new Map<string, RowGroup>();
  for (const row of rows) {
    const key = row.date || 'sem-data';
    let group = index.get(key);
    if (!group) {
      group = { key, label: key === 'sem-data' ? '' : key, rows: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  const dated = groups.filter((g) => g.key !== 'sem-data');
  const undated = groups.filter((g) => g.key === 'sem-data');
  dated.sort((a, b) => (a.key < b.key ? 1 : -1));
  return [...dated, ...undated];
}

export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  from: number;
  to: number;
};

export const PAGE_SIZE = 25;

export function paginate<T>(items: T[], page: number, pageSize = PAGE_SIZE): Page<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page: safePage,
    pageSize,
    totalPages,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + slice.length,
  };
}

export function pageLabel<T>(page: Page<T>): string {
  if (page.total === 0) return '';
  return t.roster.page(page.page, page.totalPages, page.from, page.to, page.total);
}

export function countLabel(count: number): string {
  if (count <= 0) return '';
  return `${count}`;
}
