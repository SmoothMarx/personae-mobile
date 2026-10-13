/**
 * Hand-written declarations for the VENDORED `markdown-text.js` (0.12.0).
 *
 * That file is a byte-copy of `hermes-desktop-plugins/personae/shared/markdown-text.js`, produced by
 * `scripts/vendor-markdown-text.sh` — it is not written here and must not be edited here. This
 * declaration file exists so TypeScript knows its shape without asking the compiler to infer types
 * from a file it does not own (`allowJs` is already on, so this is belt-and-braces).
 *
 * The hash of the `.js` is asserted by `tests/run.ts` against the constant that the vendoring script
 * stamps into the plugin's sentinel line, so this pair cannot drift apart silently.
 */

export declare const MARKDOWN_TEXT_VERSION: string;

/** Shared policy: these delimiters are MATH, and this batch paints math exactly as typed. */
export declare const MATH_DELIMITERS: readonly string[];

/** An opening fence: a line that starts with ``` or ~~~. */
export declare const FENCE: RegExp;

/** The label shown for a fence's info string — normalised when known, as typed when not, '' when absent. */
export declare function languageLabel(raw: unknown): string;

/** True when `text` looks like it carries markdown. Cheap (one regex), and never throws. */
export declare function looksMarkdown(text: unknown): boolean;

/**
 * The markdown OUT of a source string: markers out, whitespace collapsed to single spaces, a fenced
 * body dropped to its language label, links flattened to their text, truncated at `limit` (0 = no
 * limit). The ONE definition of that policy, shared with the desktop plugin's one-line previews.
 */
export declare function stripMarkdown(text: unknown, limit?: number): string;

/** An mdast inline array as text (the mirror of the same policy, for a caller that holds the tree). */
export declare function flattenInline(nodes: unknown, opts?: { separator?: string }): string;

/** An mdast root (or any block array) as one line of text, blocks joined by `separator`. */
export declare function flattenBlocks(nodes: unknown, opts?: { separator?: string }): string;
