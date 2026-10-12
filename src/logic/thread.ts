/**
 * Thread item building — F3's data half, pure so the offline suite can assert it.
 *
 * The bug this replaces (`PLAN-UI.md` §7 F3): the old builder produced
 * `{kind:'tools', count, names}` — a count and a list of names, and nothing else — so "Ver
 * detalhes" could only ever change a *label*. The payloads were already on the wire; the client
 * dropped them.
 *
 * What is built now, from the same rows the gateway stores:
 *   { kind:'tools',     count, calls:[{id, name, args, result, ok}] }
 *   { kind:'reasoning', text }
 * A call is joined to its result by `tool_call_id` (the api_server allow-lists `tool_call_id`,
 * `tool_calls`, `tool_name`, `reasoning`, `reasoning_content`, `display_kind` —
 * `gateway/platforms/api_server.py:3046-3052`, and the dashboard's own projection carries the same
 * fields). Rows flagged `display_kind === 'hidden'` are scaffolding: they never render.
 *
 * Expansion state is NOT here on purpose — it belongs to the screen, keyed by these item keys
 * (never one global boolean; PLAN-UI.md §7 F3 cause 2).
 */

import type { HermesMessage } from '../api/client';
import { parseMessageContent, type InboundAttachment } from './attachments';
import { toMillis } from '../format';
import { t } from '../i18n';

export type ToolCall = {
  /** Stable key: the provider's tool_call_id when there is one, else `run-index`. */
  id: string;
  name: string;
  /** Pretty-printed JSON arguments, truncated; '' when the row carried none. */
  args: string;
  /** The joined tool result, truncated; null when no result row arrived. */
  result: string | null;
  /** False only when the result row looks like a failure; true otherwise. */
  ok: boolean;
};

export type ThreadItem =
  | {
      kind: 'message';
      key: string;
      role: 'user' | 'assistant' | 'other';
      text: string;
      at: number | null;
      /**
       * 0.9.0 G — what the message CARRIED. Images arrive as inline data URLs (the thread endpoint
       * inlines them) and files as `@file:` refs, both parsed by `parseMessageContent`. Empty for a
       * plain text message, which is most of them.
       */
      attachments: InboundAttachment[];
    }
  | { kind: 'tools'; key: string; count: number; names: string[]; calls: ToolCall[] }
  | { kind: 'reasoning'; key: string; text: string };

/** Arguments/results can be huge (file bodies, transcripts); the list stays readable. */
export const ARG_LIMIT = 600;
export const RESULT_LIMIT = 800;

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… ${t.thread.truncated(text.length - limit)}`;
}

/** Pretty-print JSON when it parses, otherwise the raw text — the API sends both shapes. */
export function prettyArgs(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    try {
      return truncate(JSON.stringify(JSON.parse(trimmed), null, 2), ARG_LIMIT);
    } catch {
      return truncate(trimmed, ARG_LIMIT);
    }
  }
  try {
    return truncate(JSON.stringify(raw, null, 2), ARG_LIMIT);
  } catch {
    return truncate(String(raw), ARG_LIMIT);
  }
}

/** Text of a tool result row, whatever shape it arrived in. */
export function resultText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return truncate(content, RESULT_LIMIT);
  try {
    return truncate(JSON.stringify(content, null, 2), RESULT_LIMIT);
  } catch {
    return truncate(String(content), RESULT_LIMIT);
  }
}

const FAILURE_PREFIX = /^\s*(error|erro|failed|falhou|traceback|exception)\b/i;

/**
 * Did this result row report a failure? A deliberate, documented heuristic: an explicit
 * `error`/`is_error` field, or a body that opens with the word error. It never invents a failure
 * from a missing field — an unknown result counts as ok.
 */
export function resultOk(message: HermesMessage): boolean {
  if (message.finish_reason === 'error') return false;
  const content = message.content;
  if (Array.isArray(content)) {
    return !content.some((part) => part && typeof part === 'object' && ('error' in (part as object)));
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (record.error !== undefined || record.is_error === true) return false;
    if (typeof record.text === 'string') return !FAILURE_PREFIX.test(record.text);
    return true;
  }
  if (typeof content === 'string') return !FAILURE_PREFIX.test(content);
  return true;
}

export function isToolMessage(message: HermesMessage): boolean {
  if (message.role === 'tool') return true;
  if (message.tool_name) return true;
  const calls = message.tool_calls;
  return Array.isArray(calls) ? calls.length > 0 : Boolean(calls);
}

/** `reasoning` / `reasoning_content` are on the wire and were being dropped (F3 cause 3). */
export function reasoningText(message: HermesMessage): string {
  const value: unknown = message.reasoning ?? message.reasoning_content;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return String((part as { text: string }).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return String((value as { text: string }).text).trim();
  }
  return '';
}

export function isReasoningMessage(message: HermesMessage): boolean {
  return reasoningText(message).length > 0;
}

type RawCall = { id: string; name: string; args: string };

/** Every call shape the gateway can hand us: OpenAI `function.{name,arguments}`, flat, or nested. */
export function callsOf(message: HermesMessage, prefix: string): RawCall[] {
  const out: RawCall[] = [];
  const calls = message.tool_calls;
  const list = Array.isArray(calls) ? calls : calls ? [calls] : [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      out.push({ id: `${prefix}-${index}`, name: '', args: '' });
      return;
    }
    const record = entry as Record<string, unknown>;
    const fn = (record.function && typeof record.function === 'object' ? record.function : {}) as Record<string, unknown>;
    const id = String(record.id ?? record.tool_call_id ?? record.call_id ?? `${prefix}-${index}`);
    const name = String(fn.name ?? record.name ?? record.tool_name ?? message.tool_name ?? '');
    const args = prettyArgs(fn.arguments ?? record.arguments ?? record.args ?? record.input ?? '');
    out.push({ id, name, args });
  });
  if (!list.length && message.tool_name) {
    out.push({ id: String(message.tool_call_id ?? `${prefix}-0`), name: String(message.tool_name), args: '' });
  }
  return out;
}

/**
 * Chronological order. The server returns a page of rows (latest-first ordering is decided by the
 * query, not guaranteed in the payload), so the screen sorts by timestamp rather than trusting it.
 * Rows without a timestamp keep their relative position at the end.
 */
export function sortMessages(messages: HermesMessage[]): HermesMessage[] {
  return messages
    .map((message, index) => ({ message, index, at: toMillis(message.timestamp) }))
    .sort((a, b) => {
      if (a.at === null && b.at === null) return a.index - b.index;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      if (a.at === b.at) return a.index - b.index;
      return a.at - b.at;
    })
    .map((entry) => entry.message);
}

function roleOf(message: HermesMessage): 'user' | 'assistant' | 'other' {
  if (message.role === 'user') return 'user';
  if (message.role === 'assistant') return 'assistant';
  return 'other';
}

function textOf(message: HermesMessage): string {
  const content = message.content;
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

/** A contiguous stretch of tool/reasoning activity between two visible bubbles. */
function flushRun(run: HermesMessage[], items: ThreadItem[], runIndex: number): void {
  if (!run.length) return;
  const reasoning = run
    .map((message) => reasoningText(message))
    .filter(Boolean)
    .join('\n\n')
    .trim();
  if (reasoning) {
    items.push({ kind: 'reasoning', key: `reasoning-${runIndex}`, text: truncate(reasoning, RESULT_LIMIT) });
  }

  const calls: ToolCall[] = [];
  const results = new Map<string, HermesMessage>();
  run.forEach((message, index) => {
    if (message.role === 'tool' || (message.tool_call_id && !message.tool_calls)) {
      const id = String(message.tool_call_id ?? `orphan-${runIndex}-${index}`);
      results.set(id, message);
      return;
    }
    for (const call of callsOf(message, `call-${runIndex}-${index}`)) {
      calls.push({ id: call.id, name: call.name, args: call.args, result: null, ok: true });
    }
  });

  const consumed = new Set<string>();
  for (const call of calls) {
    const result = results.get(call.id);
    if (!result) continue;
    consumed.add(call.id);
    call.result = resultText(result.content);
    call.ok = resultOk(result);
  }
  // Orphan results (no matching call in this page) are still real activity: show them.
  for (const [id, message] of results) {
    if (consumed.has(id)) continue;
    calls.push({
      id,
      name: String(message.tool_name ?? ''),
      args: '',
      result: resultText(message.content),
      ok: resultOk(message),
    });
  }

  if (calls.length) {
    const names: string[] = [];
    for (const call of calls) if (call.name && !names.includes(call.name)) names.push(call.name);
    items.push({ kind: 'tools', key: `tools-${runIndex}`, count: calls.length, names, calls });
  }
}

/**
 * Build the render list: ordinary bubbles in order, with each run of consecutive tool/reasoning
 * rows collapsed into its own collapsible items (one `reasoning`, one `tools`) carrying real
 * payloads. Items that only exist as scaffolding (`display_kind === 'hidden'`) are dropped before
 * anything is joined, so they can neither render nor masquerade as a tool result.
 */
export function buildItems(messages: HermesMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let run: HermesMessage[] = [];
  let runIndex = 0;
  let messageIndex = 0;

  const visible = sortMessages(messages).filter((message) => message.display_kind !== 'hidden');

  for (const message of visible) {
    if (isToolMessage(message) || isReasoningMessage(message)) {
      // A *prose* row can also carry calls (an assistant that narrates and then calls a tool): the
      // prose stays a normal bubble and the call still belongs to the run around it. A `role:'tool'`
      // row is not prose — its content IS the result — so it never becomes a bubble.
      const text = textOf(message);
      if (message.role !== 'tool' && text.trim() && isToolMessage(message)) {
        flushRun(run, items, runIndex);
        if (run.length) runIndex += 1;
        run = [];
        const carried = parseMessageContent(message.content);
        items.push({
          kind: 'message',
          key: message.id || `msg-${messageIndex}`,
          role: roleOf(message),
          text: carried.attachments.length ? carried.text : text,
          at: toMillis(message.timestamp),
          attachments: carried.attachments,
        });
        messageIndex += 1;
      }
      run.push(message);
      continue;
    }
    flushRun(run, items, runIndex);
    if (run.length) runIndex += 1;
    run = [];
    const text = textOf(message);
    if (!text.trim() && message.display_kind === 'hidden') continue;
    // 0.9.0 G: a message's attachment part is not prose — it is pulled out of the text and drawn as
    // a thumbnail (images) or a file card, and only the caption is left in the bubble.
    const carried = parseMessageContent(message.content);
    items.push({
      kind: 'message',
      key: message.id || `msg-${messageIndex}`,
      role: roleOf(message),
      text: carried.attachments.length ? carried.text : text,
      at: toMillis(message.timestamp),
      attachments: carried.attachments,
    });
    messageIndex += 1;
  }
  flushRun(run, items, runIndex);
  return items;
}

export function toolSummary(count: number): string {
  return `${count}`;
}
