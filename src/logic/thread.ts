/**
 * Thread presentation logic — pure, so the offline suite can assert it without a renderer.
 */

import type { HermesMessage } from '../api/client';
import { toMillis } from '../format';

export type ThreadItem =
  | { kind: 'message'; key: string; role: 'user' | 'assistant' | 'other'; text: string; at: number | null }
  | { kind: 'tools'; key: string; count: number; names: string[] };

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

export function isToolMessage(message: HermesMessage): boolean {
  if (message.role === 'tool') return true;
  if (message.tool_name) return true;
  const calls = message.tool_calls;
  return Array.isArray(calls) ? calls.length > 0 : Boolean(calls);
}

function roleOf(message: HermesMessage): 'user' | 'assistant' | 'other' {
  if (message.role === 'user') return 'user';
  if (message.role === 'assistant') return 'assistant';
  return 'other';
}

function textOf(message: HermesMessage): string {
  // Imported lazily-through-value to keep this module free of React and of the i18n table.
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

/**
 * Build the render list: ordinary bubbles in order, with each run of consecutive tool messages
 * collapsed into one collapsible row (SPEC §2: "tool calls collapsed").
 */
export function buildItems(messages: HermesMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let run: HermesMessage[] = [];
  let index = 0;

  const flush = () => {
    if (!run.length) return;
    const names: string[] = [];
    for (const message of run) {
      const name = (message.tool_name || '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
    items.push({ kind: 'tools', key: `tools-${index}`, count: run.length, names });
    run = [];
  };

  for (const message of sortMessages(messages)) {
    if (isToolMessage(message)) {
      run.push(message);
      continue;
    }
    flush();
    const text = textOf(message);
    if (!text.trim() && message.display_kind === 'hidden') continue; // scaffolding rows stay hidden
    items.push({
      kind: 'message',
      key: message.id || `msg-${index}`,
      role: roleOf(message),
      text,
      at: toMillis(message.timestamp),
    });
    index += 1;
  }
  flush();
  return items;
}

export function toolSummary(count: number): string {
  return `${count}`;
}
