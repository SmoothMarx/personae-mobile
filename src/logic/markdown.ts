/**
 * markdown.ts — a message body as a PLAN: blocks and inline runs, ready to be drawn.
 *
 * This module parses; `src/MessageBody.tsx` paints. Nothing here touches React, the network, or a
 * style, which is what makes every rendering claim in this batch testable offline.
 *
 * Three things are load-bearing, and each is a decision rather than an implementation detail:
 *
 *  1. **The parser family is the desktop CORE's.** `unified 11` + `remark-parse 11` + `remark-gfm 4`
 *     — the same family core parses its own transcripts with. The phone cannot import core's
 *     renderer (DOM/Streamdown) or its components, so what is shared is the SEMANTICS: one source
 *     string should yield the same structure on both surfaces. `DESIGN-0.12.0.md` decision 2.
 *  2. **Soft breaks become line breaks in prose** (`remark-soft-breaks.ts` on the desktop side). A
 *     single newline inside a paragraph is a line break, so a reply reads as it was written. This is
 *     the easiest thing in the batch to get subtly wrong, so there is a test that names it.
 *  3. **A hot loop is a cache, not a re-parse** (§7). R7 made the thread watch its own session live,
 *     so the in-flight bubble repaints on every delta. Blocks are split on blank lines (fence-aware)
 *     and parsed INDIVIDUALLY against a bounded cache; while a turn is streaming, the last block is
 *     painted as the raw text it still is. See `parseBlocks` and `splitBlocks`.
 *
 * Text policy (markers out, fences to their label, links to their text) is NOT defined here — it is
 * the vendored `./markdown-text` module, byte-shared with the desktop plugin, so the phone and the
 * roster cannot disagree about what `**bold**` means.
 */

import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { languageLabel, stripMarkdown } from './markdown-text';

export type InlineNode =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: InlineNode[] }
  | { t: 'em'; c: InlineNode[] }
  | { t: 'strike'; c: InlineNode[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: InlineNode[] }
  | { t: 'break' }; // a hard break, and (see §2 above) a soft break in prose

export type BlockNode =
  | { t: 'p'; c: InlineNode[] }
  | { t: 'h'; depth: 1 | 2 | 3 | 4 | 5 | 6; c: InlineNode[] }
  | { t: 'ul' | 'ol'; start?: number; items: BlockNode[][] }
  | { t: 'quote'; c: BlockNode[] }
  | { t: 'hr' }
  | { t: 'code'; lang: string; v: string }
  | { t: 'table'; align: (('l' | 'c' | 'r') | null)[]; head: InlineNode[][]; rows: InlineNode[][][] };

/** A GFM table this wide is not a table on a 360dp phone; it falls back to the code block (§8.2). */
const MAX_TABLE_COLUMNS = 12;

/** How many parsed blocks are kept. Bounded so a 500-message thread cannot leak (§7.2). */
const BLOCK_CACHE_BOUND = 200;

// ── mdast, loosely typed on purpose ─────────────────────────────────────────────────────────────
// The shapes are pinned by the parsers' own packages, and every field read below was MEASURED
// against remark-parse 11 + remark-gfm 4 rather than assumed. A local type keeps the walk honest
// without adding @types/mdast to the dependency budget for one file.
type MdNode = {
  type: string;
  value?: string;
  depth?: number | null;
  ordered?: boolean | null;
  start?: number | null;
  lang?: string | null;
  url?: string | null;
  alt?: string | null;
  align?: (string | null)[] | null;
  children?: MdNode[];
};

const processor = unified().use(remarkParse).use(remarkGfm);

/** The text of a node this module does not know: never nothing, never a crash (§4.3). */
function textOfUnknown(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  if (!node.children?.length) return '';
  return node.children.map(textOfUnknown).join('');
}

// ── inline ──────────────────────────────────────────────────────────────────────────────────────

function mdInline(nodes: MdNode[] | undefined): InlineNode[] {
  const out: InlineNode[] = [];

  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'text': {
        // A soft break lives INSIDE a text node's value (mdast keeps it there — measured), so the
        // sentence's own newlines are what turn into line breaks. §2, and a named test.
        const parts = String(node.value ?? '').split('\n');
        parts.forEach((part, index) => {
          if (index > 0) out.push({ t: 'break' });
          if (part) out.push({ t: 'text', v: part });
        });
        break;
      }
      case 'strong':
        out.push({ t: 'strong', c: mdInline(node.children) });
        break;
      case 'emphasis':
        out.push({ t: 'em', c: mdInline(node.children) });
        break;
      case 'delete': // remark-gfm's strikethrough
        out.push({ t: 'strike', c: mdInline(node.children) });
        break;
      case 'inlineCode':
        out.push({ t: 'code', v: String(node.value ?? '') });
        break;
      case 'link':
      case 'linkReference':
        out.push({ t: 'link', href: String(node.url ?? ''), c: mdInline(node.children) });
        break;
      case 'break':
        out.push({ t: 'break' });
        break;
      case 'image':
      case 'imageReference':
        // §10.2.5: no remote-image policy exists in this app, so an image is its alt text — never a
        // download the user did not ask for, and never a blank.
        out.push({ t: 'text', v: String(node.alt ?? '') });
        break;
      case 'html':
        // §4.2: RN has no DOM, so raw HTML is painted as its LITERAL SOURCE. A stated parity gap
        // with core (whose markdown-html-depth.ts policy has no equivalent on a phone), not a bug.
        out.push({ t: 'text', v: String(node.value ?? '') });
        break;
      case 'footnoteReference':
      case 'definition':
        break; // nothing to show; and the `unknown → text` rule below must not invent one
      default: {
        const text = textOfUnknown(node);
        if (text) out.push({ t: 'text', v: text });
      }
    }
  }

  return out;
}

/** A degenerate GFM table is not a table: the code block is the fallback, never a broken grid. */
function isDegenerateTable(columns: number, head: InlineNode[][], rows: InlineNode[][][]): boolean {
  if (columns < 2 || columns > MAX_TABLE_COLUMNS) return true;
  if (rows.length < 1) return true; // a header and a delimiter row, and nothing else
  const blank = (cells: InlineNode[][]) => cells.every((cell) => cell.map((n) => (n.t === 'text' ? n.v : 'x')).join('').trim() === '');
  return blank(head) && rows.every(blank);
}

function tableNode(node: MdNode, source: string): BlockNode {
  const rows = node.children ?? [];
  const head = (rows[0]?.children ?? []).map((cell) => mdInline(cell.children));
  const body = rows.slice(1).map((row) => (row.children ?? []).map((cell) => mdInline(cell.children)));
  const columns = (node.align ?? []).length || head.length;

  if (isDegenerateTable(columns, head, body)) {
    // The SOURCE, not a re-serialisation: a fallback that rebuilt the table from its cells would
    // silently drop column alignment and any escaping the author used.
    return { t: 'code', lang: '', v: source.trim() };
  }

  return {
    t: 'table',
    align: (node.align ?? []).map((a) => (a === 'left' ? 'l' : a === 'center' ? 'c' : a === 'right' ? 'r' : null)),
    head,
    rows: body,
  };
}

// ── blocks ──────────────────────────────────────────────────────────────────────────────────────

function mdBlocks(nodes: MdNode[] | undefined, source: string): BlockNode[] {
  const out: BlockNode[] = [];

  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'paragraph':
        out.push({ t: 'p', c: mdInline(node.children) });
        break;
      case 'heading': {
        const depth = Math.min(6, Math.max(1, Number(node.depth ?? 1))) as 1 | 2 | 3 | 4 | 5 | 6;
        out.push({ t: 'h', depth, c: mdInline(node.children) });
        break;
      }
      case 'list': {
        const items = (node.children ?? []).map((item) => mdBlocks(item.children, source));
        const start = node.ordered && typeof node.start === 'number' && node.start !== 1 ? node.start : undefined;
        out.push(start === undefined ? { t: node.ordered ? 'ol' : 'ul', items } : { t: 'ol', start, items });
        break;
      }
      case 'blockquote':
        // A quote is a container: it holds paragraphs, lists, and (measured) tables.
        out.push({ t: 'quote', c: mdBlocks(node.children, source) });
        break;
      case 'thematicBreak':
        out.push({ t: 'hr' });
        break;
      case 'code':
        // Fences and indented code are the same node to mdast; the language is normalised ONCE, in
        // the shared module, so the header label and a preview's label cannot disagree (§4.5).
        out.push({ t: 'code', lang: languageLabel(node.lang), v: String(node.value ?? '') });
        break;
      case 'table':
        out.push(tableNode(node, source));
        break;
      case 'html':
        out.push({ t: 'p', c: [{ t: 'text', v: String(node.value ?? '') }] });
        break;
      case 'definition':
      case 'footnoteDefinition':
        break; // a link target is not content
      default: {
        const text = textOfUnknown(node);
        if (text.trim()) out.push({ t: 'p', c: [{ t: 'text', v: text }] });
      }
    }
  }

  return out;
}

// ── the block cache (§7) ────────────────────────────────────────────────────────────────────────

/** Parsed blocks, keyed by the block's OWN source string, so a block seen before parses once. */
const blockCache = new Map<string, BlockNode[]>();

function parseBlockCached(block: string): BlockNode[] {
  const hit = blockCache.get(block);
  if (hit) return hit;

  const tree = processor.parse(block) as unknown as { children?: MdNode[] };
  const parsed = mdBlocks(tree.children, block);
  blockCache.set(block, parsed);

  // Evict oldest past the bound. A Map iterates in insertion order, and an existing key is never
  // re-set, so the first key really is the oldest.
  if (blockCache.size > BLOCK_CACHE_BOUND) {
    const oldest = blockCache.keys().next();
    if (!oldest.done) blockCache.delete(oldest.value);
  }

  return parsed;
}

/**
 * Split source into blocks on blank lines, FENCE-AWARE: a blank line inside an open ``` fence is
 * content, not a boundary.
 *
 * Deliberately NOT exported: the contract for this module is `parseBlocks` and `plainText`, and the
 * splitter's behaviour is observable through the plan it produces (a fence containing a blank line
 * comes back as ONE `code` block), so a test can pin it without widening the public surface.
 *
 * Tables need no special case and that is worth stating: a GFM table's rows cannot contain a blank
 * line, so a table is contiguous by construction and this splitter cannot break one. (The mobile
 * side parses each block independently, exactly as core's `parseMarkdownIntoBlocksCached` does, and
 * the cost of that is one known trade-off: a list written LOOSE — a blank line between its items —
 * parses as two lists, because the blank line really is a boundary between blocks.)
 */
function splitBlocks(src: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };

  for (const line of src.split(/\r?\n/)) {
    const open = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);

    if (open && !fence) {
      fence = open[1][0];
      current.push(line);
      continue;
    }
    if (close && fence && close[1][0] === fence) {
      fence = null;
      current.push(line);
      continue;
    }
    if (!fence && line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }

  flush();
  return blocks;
}

/**
 * The plan for a message body.
 *
 * `streaming` is the ONLY extra input, and it exists because of §7.3: while a turn is in flight the
 * LAST block is not trusted — it may be half a fence, half a table, a `**` whose partner has not
 * arrived. It is painted as the raw text it still is, and every closed block above it is painted
 * through the renderer. A sealed message therefore never shows a marker and the tail of a live one
 * sometimes does; that difference is correct and is asserted, not "fixed".
 *
 * Blocks are cached by their own source, so a delta repaints the tail (as text) and re-uses every
 * closed block above it: 200 deltas over a 6-block reply parse each closed block ONCE.
 */
export function parseBlocks(src: string, streaming = false): BlockNode[] {
  const blocks = splitBlocks(src);
  const out: BlockNode[] = [];
  const last = blocks.length - 1;

  blocks.forEach((block, index) => {
    if (streaming && index === last) {
      out.push({ t: 'p', c: [{ t: 'text', v: block }] });
      return;
    }
    for (const node of parseBlockCached(block)) out.push(node);
  });

  return out;
}

/**
 * A message body as one line of plain text — through the VENDORED module, so the phone and the
 * desktop plugin answer this question with the same bytes (`DESIGN-0.12.0.md` decision 3).
 */
export function plainText(src: string): string {
  return stripMarkdown(src, 0);
}
