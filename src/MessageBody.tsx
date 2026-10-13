/**
 * MessageBody — a message body, drawn as STRUCTURED React Native text (0.12.0).
 *
 * Why it lives flat at `src/` and not under `src/ui/`: every component in this codebase sits flat at
 * `src/` (`Avatar.tsx`, `ConnectivityBanner.tsx`, `ConnectivityContext.tsx`). `DESIGN-0.12.0.md`
 * predicted `src/ui/MessageBody.tsx`; that directory has never existed. Logic stays in
 * `src/logic/`, so the plan module is `src/logic/markdown.ts` and this is the painter.
 *
 * It takes a STRING and owns nothing else: no network, no state beyond a code block's copy
 * confirmation, and no colour that is not already in `styles`/theme. Blocks come from
 * `parseBlocks` (cached, §7), so a live turn repaints without re-parsing.
 *
 * The structure is the thing to keep straight while editing:
 *   * the ROOT is a `View`, because a block-level grid or code scroller cannot live inside a `Text`;
 *   * inline runs are NESTED `Text` — the same primitive Telegram uses, and it is native;
 *   * a `View` is NEVER nested inside a `Text` (Android does not honour it).
 *
 * What this batch deliberately does NOT do: syntax colouring (code is monochrome — the user's pick;
 * the node is already `{t:'code', lang}`, so a later batch swaps this one renderer and re-tokenizes
 * nothing), typeset math (`$x$` stays as typed), and any remote-image policy (`![alt](url)` draws
 * its alt text — this app has no image policy and inventing one mid-formatting-batch is how a
 * formatting release becomes a privacy review).
 */

import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';

import { t } from './i18n';
import { parseBlocks, type BlockNode, type InlineNode } from './logic/markdown';
import { colors, font, radius, space } from './theme';

/** Menlo on iOS, the platform monospace on Android. */
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace' });
/** The body size the ramps below are derived from. */
const BODY = font.body;
/** Heading sizes: 1.35×/1.2×/1.1×/1.0× the body, per §5. */
const HEADING_SIZE: Record<number, number> = {
  1: Math.round(BODY * 1.35),
  2: Math.round(BODY * 1.2),
  3: Math.round(BODY * 1.1),
  4: BODY,
  5: BODY,
  6: BODY,
};
/** The bullet/number column: fixed, so wrapped lines hang instead of sliding under the marker. */
const MARKER_WIDTH = 22;
/** A table column is a fixed 140dp — over the 96dp floor, and fixed so a long cell WRAPS inside its
 *  column instead of widening the grid (which is what keeps the horizontal scroll predictable). */
const TABLE_COL_WIDTH = 140;

type Props = {
  text: string;
  /** §7.3: while a turn is in flight the LAST block is painted as raw text, never parsed. */
  streaming?: boolean;
  selectable?: boolean;
  /** The bubble's own text style. Applied to every prose leaf, so nothing about the bubble changes. */
  style?: StyleProp<TextStyle>;
};

export function MessageBody(props: Props): React.ReactElement | null {
  const { text, streaming, selectable, style } = props;

  const blocks = useMemo(() => parseBlocks(text, streaming === true), [text, streaming]);

  if (!blocks.length) {
    // Nothing to draw: return no element rather than an empty one, so the bubble's own `gap: 4`
    // does not grow a phantom slot where an empty `<Text>` used to sit.
    return null;
  }

  return <View>{blocks.map((block, index) => renderBlock(block, `b${index}`, style, selectable))}</View>;
}

// ── inline ──────────────────────────────────────────────────────────────────────────────────────

function openUrl(href: string): void {
  // An OS intent, and therefore device-only: what IS asserted here is that the plan carries the href
  // and that this handler is wired to it (§14.3).
  void Linking.openURL(href);
}

function renderInline(nodes: InlineNode[], keyPrefix: string, selectable?: boolean): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (node.t) {
      case 'text':
        return node.v;
      case 'break':
        // A hard break, or a soft break in prose (§4.1): a real newline inside the parent Text.
        return <Text key={key}>{'\n'}</Text>;
      case 'strong':
        return (
          <Text key={key} style={styles.strong}>
            {renderInline(node.c, key, selectable)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} style={styles.em}>
            {renderInline(node.c, key, selectable)}
          </Text>
        );
      case 'strike':
        return (
          <Text key={key} style={styles.strike}>
            {renderInline(node.c, key, selectable)}
          </Text>
        );
      case 'code':
        return (
          <Text key={key} style={styles.inlineCode}>
            {node.v}
          </Text>
        );
      case 'link':
        return (
          <Text
            key={key}
            style={styles.link}
            accessibilityRole="link"
            onPress={node.href ? () => openUrl(node.href) : undefined}
          >
            {renderInline(node.c, key, selectable)}
          </Text>
        );
      default:
        return null;
    }
  });
}

/** A run of inline nodes as ONE leaf Text — the shape every prose block shares. */
function inlineLeaf(
  nodes: InlineNode[],
  key: string,
  style: StyleProp<TextStyle>,
  extra: StyleProp<TextStyle>,
  selectable?: boolean,
): React.ReactElement {
  return (
    <Text key={key} style={[style, extra]} selectable={selectable}>
      {renderInline(nodes, key, selectable)}
    </Text>
  );
}

// ── blocks ──────────────────────────────────────────────────────────────────────────────────────

function renderBlock(
  block: BlockNode,
  key: string,
  style: StyleProp<TextStyle>,
  selectable?: boolean,
): React.ReactElement {
  switch (block.t) {
    case 'p':
      return inlineLeaf(block.c, key, style, styles.paragraph, selectable);

    case 'h':
      return inlineLeaf(block.c, key, style, [styles.heading, { fontSize: HEADING_SIZE[block.depth] }], selectable);

    case 'hr':
      return <View key={key} style={styles.hr} />;

    case 'quote':
      return (
        <View key={key} style={styles.quote}>
          {block.c.map((child, index) => renderBlock(child, `${key}-${index}`, style, selectable))}
        </View>
      );

    case 'ul':
    case 'ol':
      return (
        <View key={key} style={styles.list}>
          {block.items.map((item, index) => (
            <View key={`${key}-${index}`} style={styles.listRow}>
              <Text style={[style, styles.marker]} selectable={selectable}>
                {block.t === 'ul' ? '•' : `${(block.start ?? 1) + index}.`}
              </Text>
              <View style={styles.listBody}>
                {item.map((child, childIndex) => renderBlock(child, `${key}-${index}-${childIndex}`, style, selectable))}
              </View>
            </View>
          ))}
        </View>
      );

    case 'code':
      return <CodeBlock key={key} lang={block.lang} value={block.v} />;

    case 'table':
      return <TableView key={key} align={block.align} head={block.head} rows={block.rows} style={style} selectable={selectable} />;

    default:
      return <View key={key} />;
  }
}

// ── T2: a fenced code block — monospace, no wrap, a language label and a copy button ────────────

function CodeBlock(props: { lang: string; value: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    void Clipboard.setStringAsync(props.value).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      // ONE shot, not a poll: the confirmation goes away by itself. Cleared on unmount.
      timer.current = setTimeout(() => setCopied(false), 1600);
    });
  }, [props.value]);

  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHead}>
        {/* An unlabelled fence keeps the header (and the copy button) with no language. */}
        <Text style={styles.codeLang}>{props.lang}</Text>
        <Pressable
          onPress={copy}
          accessibilityRole="button"
          accessibilityLabel={t.thread.copyCode}
          hitSlop={space.sm}
        >
          <Text style={styles.codeCopy}>{copied ? t.thread.copiedCode : t.thread.copyCode}</Text>
        </Pressable>
      </View>
      {/* `horizontal` + no numberOfLines: a long line SCROLLS. It must never wrap and never widen
          the bubble — the scroller is what gives it a bounded width to overflow. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText} selectable>
          {props.value}
        </Text>
      </ScrollView>
    </View>
  );
}

// ── T3: a GFM table — a horizontal-scroll grid, and the ONLY thing here that scrolls sideways ───

const ALIGN: Record<string, TextStyle['textAlign']> = { l: 'left', c: 'center', r: 'right' };

function TableView(props: {
  align: (('l' | 'c' | 'r') | null)[];
  head: InlineNode[][];
  rows: InlineNode[][][];
  style: StyleProp<TextStyle>;
  selectable?: boolean;
}): React.ReactElement {
  const { align, head, rows, style } = props;
  const grid: InlineNode[][][] = [head, ...rows];

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View style={styles.table}>
        {grid.map((cells, rowIndex) => (
          <View key={`row-${rowIndex}`} style={[styles.tr, rowIndex < grid.length - 1 ? styles.trLine : null]}>
            {cells.map((cell, columnIndex) =>
              inlineLeaf(
                cell,
                `row-${rowIndex}-${columnIndex}`,
                style,
                [styles.td, { textAlign: ALIGN[align[columnIndex] ?? 'l'] ?? 'left' }, rowIndex === 0 ? styles.th : null],
                props.selectable,
              ),
            )}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  paragraph: { marginTop: space.xs },
  heading: { fontWeight: '700', marginTop: space.sm },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  inlineCode: {
    fontFamily: MONO,
    fontSize: BODY * 0.9,
    backgroundColor: colors.border,
    paddingHorizontal: 4,
    borderRadius: 2,
  },
  link: { color: colors.accent, textDecorationLine: 'underline' },

  hr: { height: 1, backgroundColor: colors.border, marginVertical: space.sm },

  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.border,
    paddingLeft: space.sm,
    marginTop: space.xs,
  },

  list: { marginTop: space.xs },
  listRow: { flexDirection: 'row' },
  marker: { width: MARKER_WIDTH, color: colors.muted },
  listBody: { flex: 1, minWidth: 0 },

  codeBlock: {
    marginTop: space.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    overflow: 'hidden',
  },
  codeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  codeLang: { color: colors.faint, fontSize: font.small },
  codeCopy: { color: colors.accent, fontSize: font.small },
  codeText: { fontFamily: MONO, fontSize: font.small + 1, lineHeight: 19, color: colors.text, padding: space.sm },

  table: { marginTop: space.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden' },
  tr: { flexDirection: 'row' },
  trLine: { borderBottomWidth: 1, borderBottomColor: colors.border },
  td: {
    width: TABLE_COL_WIDTH,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  th: { fontWeight: '700' },
});
