/**
 * TMD parser — FORMAT.md §3 (file structure), §4 (comment classification),
 * §10 (parser conformance): classifies comments with the book's profile,
 * tolerates legacy layouts and timestamps, warns on mid-line IDs, preserves
 * unclassified comments.
 */
import { parse as parseYaml } from 'yaml';
import { classifyComment, normalizeTimestamp } from './classify.js';
import type { TmdProfile } from './profile.js';
import { idRegex } from './profile.js';
import type {
  TmdAnnotation,
  TmdCluster,
  TmdComment,
  TmdDocument,
  TmdMachineFlag,
  TmdStandalone,
  TmdVersionComment,
  TmdWarning,
} from './types.js';

const FOOTNOTE_DEF = /^\[\^([^\]]+)\]:\s*(.*)$/;
/** §11: legacy `[//]: # ( … )` HTML-comment-style remarks — read, never write. */
const LEGACY_COMMENT = /^\[\/\/\]: # \((.*)\)$/s;

interface Line {
  text: string;
  /** 1-based line number in the original source. */
  no: number;
}

/** Parse one TMD file against a book profile. */
export function parse(source: string, profile: TmdProfile): TmdDocument {
  const warnings: TmdWarning[] = [];
  const normalized = source.replace(/\r\n?/g, '\n');
  const allLines = normalized.split('\n');

  // --- frontmatter ---------------------------------------------------------
  let frontmatter: Record<string, unknown> = {};
  let frontmatterRaw = '';
  let bodyStart = 0;
  if (allLines[0]?.trim() === '---') {
    const end = allLines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) {
      frontmatterRaw = allLines.slice(0, end + 1).join('\n') + '\n';
      try {
        frontmatter = (parseYaml(allLines.slice(1, end).join('\n')) as Record<string, unknown>) ?? {};
      } catch {
        warnings.push({
          code: 'legacy-layout',
          message: 'frontmatter block is not valid YAML',
          line: 1,
          severity: 'warning',
        });
      }
      bodyStart = end + 1;
    }
  }

  // --- gather comments and visible lines, honoring multi-line blocks -------
  type Item =
    | { kind: 'comment'; comment: TmdComment }
    | { kind: 'visible'; line: Line }
    | { kind: 'blank'; line: Line };
  const items: Item[] = [];
  const idFull = idRegex(profile);

  for (let i = bodyStart; i < allLines.length; i++) {
    const text = allLines[i]!;
    const no = i + 1;
    const trimmed = text.trim();

    if (trimmed === '') {
      items.push({ kind: 'blank', line: { text, no } });
      continue;
    }

    // whole-line comment (§2.1): starts with %% at column 0 (tolerate indent on read)
    if (trimmed.startsWith('%%')) {
      if (trimmed.length > 2 && trimmed.endsWith('%%') && trimmed !== '%%%') {
        const content = trimmed.slice(2, -2).trim();
        items.push({ kind: 'comment', comment: classifyComment(content, profile, text, no) });
        continue;
      }
      // §2.1 violation: a comment that closes mid-line with visible text after
      // it — `%% … %% trailing prose`. Read the comment, keep the trailing text
      // as a visible line, and warn (this is how annotation/translation lines
      // get glued together in legacy content).
      const closeAt = trimmed.indexOf('%%', 2);
      if (closeAt > 0 && closeAt < trimmed.length - 2) {
        const content = trimmed.slice(2, closeAt).trim();
        const trailing = trimmed.slice(closeAt + 2).trim();
        warnings.push({
          code: 'inline-structural-comment',
          message: `comment closes mid-line with visible text after it — structural comments must occupy whole lines (§2.1)`,
          line: no,
          severity: 'warning',
        });
        items.push({ kind: 'comment', comment: classifyComment(content, profile, text, no) });
        if (trailing) items.push({ kind: 'visible', line: { text: trailing, no } });
        continue;
      }

      // multi-line comment block: %% opens, runs until a line ending with %%
      const start = i;
      const block: string[] = [trimmed.slice(2)];
      let closed = false;
      while (++i < allLines.length) {
        const l = allLines[i]!.trim();
        if (l.endsWith('%%')) {
          block.push(l.slice(0, -2));
          closed = true;
          break;
        }
        block.push(l);
      }
      if (!closed) {
        warnings.push({
          code: 'unterminated-comment',
          message: `comment opened at line ${start + 1} never closes`,
          line: start + 1,
          severity: 'error',
        });
      }
      const raw = allLines.slice(start, Math.min(i + 1, allLines.length)).join('\n');
      const content = block.join('\n').trim();
      items.push({ kind: 'comment', comment: classifyComment(content, profile, raw, start + 1) });
      continue;
    }

    // §11 legacy comment format
    const legacy = trimmed.match(LEGACY_COMMENT);
    if (legacy) {
      warnings.push({
        code: 'legacy-comment',
        message: 'legacy `[//]: # ( … )` comment — parsers may read, writers never emit',
        line: no,
        severity: 'info',
      });
      items.push({ kind: 'comment', comment: classifyComment(legacy[1]!.trim(), profile, text, no) });
      continue;
    }

    // visible line — §2.1: a paragraph-ID marker mid-line is corruption
    if (new RegExp(String.raw`%%\s*(?:${profile.paragraph_id.pattern})\s*%%`).test(trimmed)) {
      warnings.push({
        code: 'midline-id',
        message: `paragraph-ID marker appears mid-line — corruption, clusters after this point may be misparsed`,
        line: no,
        severity: 'error',
      });
    }
    items.push({ kind: 'visible', line: { text, no } });
  }

  // --- group into clusters / standalone blocks ------------------------------
  // Canonical: a cluster starts at an ID comment and ends at the next blank
  // line (§3). Legacy tolerance: content in the same block *before* the ID
  // belongs to the cluster (legacyLayout). Blocks with no ID are standalone.
  const clusters: TmdCluster[] = [];
  const standalone: TmdStandalone[] = [];
  const footnotes: Record<string, string> = {};
  const seenIds = new Set<string>();

  let block: Item[] = [];
  const flushBlock = () => {
    if (block.length === 0) return;
    // split the block at each paragraph-id comment
    const idPositions = block
      .map((it, idx) => (it.kind === 'comment' && it.comment.type === 'paragraph-id' ? idx : -1))
      .filter((idx) => idx >= 0);

    if (idPositions.length === 0) {
      const lines = block.filter((it) => it.kind === 'visible').map((it) => (it as { line: Line }).line);
      const comments = block.filter((it) => it.kind === 'comment').map((it) => (it as { comment: TmdComment }).comment);
      if (lines.length || comments.length) {
        standalone.push({
          line: (lines[0] ?? { no: comments[0]?.line ?? 0 }).no ?? 0,
          lines: lines.map((l) => l.text),
          comments,
        });
      }
      block = [];
      return;
    }

    for (let k = 0; k < idPositions.length; k++) {
      const idIdx = idPositions[k]!;
      const from = k === 0 ? 0 : idPositions[k]!;
      const to = k + 1 < idPositions.length ? idPositions[k + 1]! : block.length;
      const idComment = (block[idIdx] as { comment: TmdComment }).comment;
      const cluster: TmdCluster = {
        id: idComment.content,
        line: idComment.line,
        original: [],
        translation: [],
        annotations: [],
        flags: [],
        versions: [],
        otherComments: [],
        legacyLayout: k === 0 && idIdx > 0,
      };
      if (cluster.legacyLayout) {
        warnings.push({
          code: 'legacy-layout',
          message: `content precedes the paragraph-ID comment for ${cluster.id} (legacy layout; writers must emit canonical order)`,
          line: idComment.line,
          severity: 'info',
        });
      }
      if (seenIds.has(cluster.id)) {
        warnings.push({
          code: 'duplicate-id',
          message: `paragraph ID ${cluster.id} is reused (§2.3: IDs are never reused)`,
          line: idComment.line,
          severity: 'error',
        });
      }
      seenIds.add(cluster.id);

      const slice = k === 0 ? block.slice(0, to) : block.slice(from, to);
      for (const it of slice) {
        if (it.kind === 'blank') continue;
        if (it.kind === 'visible') {
          cluster.translation.push(it.line.text);
          continue;
        }
        const c = it.comment;
        switch (c.type) {
          case 'paragraph-id':
            break; // the marker itself
          case 'original':
            cluster.original.push(c.content);
            break;
          case 'annotation': {
            const a = c as TmdAnnotation;
            const { overflowed } = normalizeTimestamp(a.timestamp);
            if (overflowed) {
              warnings.push({
                code: 'timestamp-overflow',
                message: `annotation timestamp seconds overflow normalized at line ${c.line}`,
                line: c.line,
                severity: 'info',
              });
            }
            const vocab = [...profile.authors.vocabulary, ...profile.authors.retired];
            if (vocab.length > 0 && !vocab.includes(a.author)) {
              warnings.push({
                code: 'unknown-author',
                message: `annotation author "${a.author}" is not in the declared vocabulary (open vocabulary — add it to the profile if intentional)`,
                line: c.line,
                severity: 'warning',
              });
            }
            cluster.annotations.push(a);
            break;
          }
          case 'machine-flag': {
            const f = c as TmdMachineFlag;
            warnings.push({
              code: 'machine-flag',
              message: `open ${f.flag}? work item on ${cluster.id}: ${f.text}`,
              line: c.line,
              severity: 'info',
            });
            cluster.flags.push(f);
            break;
          }
          case 'version':
            cluster.versions.push(c as TmdVersionComment);
            break;
          default:
            cluster.otherComments.push(c); // glossary-link / tag-annotation — preserved (§2.5)
        }
      }
      clusters.push(cluster);
    }
    block = [];
  };

  for (const it of items) {
    if (it.kind === 'blank') {
      flushBlock();
      continue;
    }
    if (it.kind === 'visible') {
      const def = it.line.text.trim().match(FOOTNOTE_DEF);
      if (def) footnotes[def[1]!] = def[2]!;
    }
    block.push(it);
  }
  flushBlock();

  return { frontmatter, frontmatterRaw, clusters, standalone, footnotes, warnings };
}
