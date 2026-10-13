/**
 * The `/` menu, as data (0.11.0 R5) — the user's "show a list of all the commands that can be inserted".
 *
 * the user, 2026-10-13: *"When typing in the message box, if the user inserts a '/', show a list of all
 * the commands that can be inserted. If they click on one, insert it into the field."*
 *
 * NOTHING HERE INVENTS A COMMAND LIST. The gateway already has one, behind its own RPC:
 * `complete.slash` (`tui_gateway/methods_complete.py:278-331`), which the TUI uses for its own popup.
 * It takes `{text, session_id, profile}` and answers
 * `{items: [{text, display, meta, kind}], replace_from}`. THREE of its decisions are load-bearing and
 * are the server's, not ours to re-derive:
 *
 *   * it answers **only when the text starts with `/`** (`:282-283`) — so the trigger is the server's;
 *   * `kind` is `'command'` or `'skill'` (`:308`) — skills are offered by the same call;
 *   * `replace_from` is the splice index, computed **from the end of the string**
 *     (`text.rfind(" ") + 1 if " " in text else 1`, `:331`) — which is why the menu is only offered
 *     with the caret at the end, and why a tap SPLICES rather than appends.
 *
 * WHY THIS MODULE IS DATA AND NOT JSX: `app/thread/[id].tsx` cannot be rendered on this host, so the
 * splice arithmetic, the staleness rule and the caret rule would otherwise be unverifiable claims
 * about a component. Here they are functions the suite can call.
 */

/** One row the server offered. `display` is what a human reads; `text` is what gets inserted. */
export type SlashItem = {
  text: string;
  display: string;
  meta: string;
  /** `'command'` or `'skill'` — the server's own vocabulary, kept as an open string. */
  kind: string;
};

export type SlashCompletion = {
  items: SlashItem[];
  /** The index to splice the chosen `text` at. From the server; never recomputed here. */
  replaceFrom: number;
};

/**
 * What to ASK, or `null` for "ask nothing".
 *
 * Two conditions, and neither is a second copy of the server's rule:
 *
 *   * **the caret is at the END of the text.** `replace_from` is computed from the string's end, so a
 *     caret parked mid-text would splice into the wrong place. Hiding the menu is the honest
 *     behaviour, and it is the TUI's own assumption.
 *   * **the draft starts with `/`.** This mirrors `complete.slash`'s own gate, so a draft that cannot
 *     produce a completion never produces a REQUEST either — a mid-sentence `/` is a literal
 *     character the server answers nothing for (§R6.d).
 */
export function slashQueryOf(draft: string, caretAtEnd: boolean): string | null {
  if (!caretAtEnd) return null;
  const text = String(draft ?? '');
  if (!text.startsWith('/')) return null;
  return text;
}

/**
 * Where the splice lands, clamped to something that cannot corrupt the draft.
 *
 * The server's own reply is used when it is a number; anything else falls back to the `/`-token rule
 * the server documents (`1` for a bare token). Clamping matters because this text came off a socket:
 * an index past the end would append, a negative one would eat the start.
 */
export function spliceIndexFor(draft: string, replaceFrom: unknown): number {
  const text = String(draft ?? '');
  const raw = Number(replaceFrom);
  const index = Number.isFinite(raw) ? Math.trunc(raw) : 1;
  return Math.max(0, Math.min(index, text.length));
}

/**
 * Tapping a row INSERTS it — it does not send (§R5). And the INSERTION RULE IS THE GATEWAY'S OWN, not
 * invented here: `ui-tui/src/domain/slash.ts:59-63` is the other client that consumes `replace_from`,
 * and it reads
 *
 *     const text = value[compReplace - 1] === '/' && rowText.startsWith('/') ? rowText.slice(1) : rowText
 *     return value.slice(0, compReplace) + text
 *
 * i.e. everything before the server's index is kept, and the row's own leading slash is dropped when
 * the character before the splice point is already one — which is what makes a bare row (`exit`) and a
 * slash-carrying row (`/exit`) both land as `/exit` instead of `//exit`. Two clients, one rule.
 */
export function spliceCompletion(draft: string, replaceFrom: unknown, item: string): string {
  const text = String(draft ?? '');
  const at = spliceIndexFor(text, replaceFrom);
  const row = String(item ?? '');
  const chosen = text[at - 1] === '/' && row.startsWith('/') ? row.slice(1) : row;
  return `${text.slice(0, at)}${chosen}`;
}

/**
 * Last-write-wins. Typing `/he` fires three queries, and a slower EARLIER answer must never overwrite
 * a later one: the caller keeps a monotonic sequence and drops any answer whose sequence is behind
 * the highest it has issued. Pure and one line, because "drop the stale answer" is the sort of rule
 * that quietly stops being true when it lives inside a `.then`.
 */
export function isStaleAnswer(seq: number, latestSeq: number): boolean {
  return seq < latestSeq;
}
