/**
 * Core types for Translation Markdown (TMD) — see FORMAT.md.
 *
 * Terminology (FORMAT.md §1): a TMD file interleaves the visible *translation*
 * with `%% … %%` *comments* carrying everything else — paragraph IDs, the
 * *original* source text, dated *annotations*, and *machine flags*. The unit of
 * alignment is the *paragraph cluster*: one ID comment plus the original,
 * translation and annotations belonging to that paragraph.
 */

/** Comment classification per FORMAT.md §4 (first match wins, in this order). */
export type CommentType =
  | 'paragraph-id'
  | 'annotation'
  | 'machine-flag'
  | 'version'
  | 'glossary-link'
  | 'tag-annotation'
  | 'original';

/** A single `%% … %%` comment, classified. */
export interface TmdComment {
  type: CommentType;
  /** Raw comment text with the `%%` delimiters and outer whitespace removed. */
  content: string;
  /** Raw source lines exactly as they appeared (for §2.5 byte-identical passthrough). */
  raw: string;
  /** 1-based line number of the comment's first line in the source file. */
  line: number;
}

/** A dated, attributed annotation: `%% 2024-01-30T07:53:33 Kerray: … %%` (§6). */
export interface TmdAnnotation extends TmdComment {
  type: 'annotation';
  /** ISO-8601 timestamp as written (after overflow-seconds normalization, §6). */
  timestamp: string;
  /** Author name or role code (profile-defined vocabulary, §6). */
  author: string;
  /** The remark text after `<author>: `. */
  text: string;
}

/** A tool-inserted work item: `%% ALIGN? no English counterpart %%` (§6). */
export interface TmdMachineFlag extends TmdComment {
  type: 'machine-flag';
  /** Flag name without the `?`, e.g. `ALIGN`, `FORMAT`. */
  flag: string;
  text: string;
}

/** An earlier translation version: `%% v1.2 earlier text %%` (Bashkirtseff, §4 row 4). */
export interface TmdVersionComment extends TmdComment {
  type: 'version';
  version: string;
  text: string;
}

/** The unit of alignment (§1, §3): ID + original + translation + annotations + flags. */
export interface TmdCluster {
  /** The stable paragraph ID (§2.3, §5), e.g. `042.0007` or `GLO_VISCONTI.0001`. */
  id: string;
  /** 1-based line of the ID comment. */
  line: number;
  /** Original-language text from unprefixed comments, in file order. */
  original: string[];
  /** Visible translation lines (trimmed of trailing whitespace), in file order. */
  translation: string[];
  annotations: TmdAnnotation[];
  flags: TmdMachineFlag[];
  versions: TmdVersionComment[];
  /** Glossary-link / tag-annotation / unclassifiable comments, preserved per §2.5. */
  otherComments: TmdComment[];
  /**
   * True when visible text or comments preceded the ID comment (legacy layout, §3).
   * Writers must emit canonical order; parsers tolerate this on read.
   */
  legacyLayout: boolean;
}

/** Content between clusters that stands alone (§3): headings, scene breaks, prose. */
export interface TmdStandalone {
  line: number;
  lines: string[];
  comments: TmdComment[];
}

export type WarningCode =
  | 'midline-id' // §2.1 — paragraph-ID marker mid-line is corruption
  | 'duplicate-id' // §2.3 — stable IDs are never reused
  | 'timestamp-overflow' // §6 — seconds :60/:61 normalized by carrying
  | 'unknown-author' // §6 — annotation author outside the declared vocabulary
  | 'legacy-layout' // §3 — content before the ID comment
  | 'legacy-comment' // §11 — `[//]: # ( … )` HTML-comment-style remark
  | 'inline-structural-comment' // §2.1 — structural comment closes mid-line with visible text after it
  | 'unterminated-comment' // `%%` opened but never closed before EOF
  | 'machine-flag' // §6 — open work item (informational)
  | 'footnote-undefined' // reference without definition
  | 'footnote-unused' // definition without reference
  | 'duplicate-footnote' // §7 — footnote ID reused within its uniqueness scope
  | 'overlay-residue' // §8/§11 — `{{…}}` legacy metadata overlay in visible text
  | 'projection-residue'; // §2.2 — `%%` residue after projection (invariant violation)

export interface TmdWarning {
  code: WarningCode;
  message: string;
  /** 1-based line number in the source file, when known. */
  line?: number;
  /** File path, when the operation spans multiple files. */
  file?: string;
  severity: 'error' | 'warning' | 'info';
}

/** Result of parsing one TMD file. */
export interface TmdDocument {
  /** Parsed YAML frontmatter (empty object when absent). */
  frontmatter: Record<string, unknown>;
  /** Raw frontmatter block including delimiters, `''` when absent. */
  frontmatterRaw: string;
  clusters: TmdCluster[];
  /** Standalone (non-cluster) content in file order. */
  standalone: TmdStandalone[];
  /** Footnote definitions: id → definition text. */
  footnotes: Record<string, string>;
  warnings: TmdWarning[];
}
