/**
 * Alignment — build a TMD file from an independently sourced original and an
 * existing translation (FORMAT.md §3 clusters). Generalised from the
 * Following-the-Phoenix importer (archetypal `ftp-import/align_tmd.py`,
 * 2026-10-07: 6 732 pairs, 25 `ALIGN?` flags, projection == translation).
 *
 * Dynamic programming over paragraph sequences with moves 1-1, 1-0, 0-1, 2-1
 * and 1-2, scored by length ratio plus lexical anchors (numbers, capitalised
 * names) and paragraph shape (dialogue, italics, ?/!). Uncertain spots become
 * `ALIGN?` machine flags for a human — never silent guesses.
 *
 * The hard guarantee is the projection invariant (§2.2): `alignToTmd` checks
 * that projecting the generated file yields exactly the translation's
 * paragraphs and reports `projectionOk: false` otherwise. Callers (the CLI)
 * must refuse to write a file that fails it.
 */
import { classifyComment } from './classify.js';
import { GENERIC_PROFILE, type TmdProfile } from './profile.js';
import { project } from './project.js';

export interface AlignOptions {
  /** ID prefix (first ID component), e.g. a work number `"002"`. */
  idPrefix: string;
  /** Increment between paragraph numbers (1 → .0001 .0002 …; 10 leaves gaps). Default 1. */
  idStep?: number;
  /** Zero-pad width of the paragraph number. Default 4. */
  idWidth?: number;
  /** Visible scene-break marker written for translation thematic breaks. Default: keep as found. */
  sceneBreak?: string;
  /** 1-1 pairs costing more than this get `ALIGN? weak match`. Default 3.5. */
  weakThreshold?: number;
  /** DP band half-width around the diagonal, in paragraphs. Default 40. */
  band?: number;
  /** Profile used to make sure original comments classify as `original` (§4). */
  profile?: TmdProfile;
}

export interface AlignPair {
  original: string[];
  translation: string[];
  cost: number;
}

export interface AlignStats {
  pairs: number;
  oneToOne: number;
  merged: number;
  originalOnly: number;
  translationOnly: number;
  weak: number;
  sceneBreaks: number;
  escapedOriginals: number;
  flags: number;
}

export interface AlignResult {
  source: string;
  stats: AlignStats;
  projectionOk: boolean;
  /** First differing paragraph when the projection check fails. */
  projectionDiff?: { index: number; expected: string; actual: string };
}

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
/** U+2060 WORD JOINER: invisible guard so an original starting with `[`, `ALLCAPS?` etc. still classifies as original. */
const GUARD = '⁠';

/** Remove YAML frontmatter, if any. */
export function stripFrontmatter(md: string): string {
  return md.replace(/\r\n?/g, '\n').replace(FRONTMATTER, '');
}

/** Return the raw frontmatter block (with `---` lines), or '' when absent. */
export function frontmatterBlock(md: string): string {
  const m = md.replace(/\r\n?/g, '\n').match(FRONTMATTER);
  return m ? m[0] : '';
}

/**
 * Split markdown into block paragraphs on blank lines. Frontmatter and a
 * leading HTML comment are dropped; fenced code blocks stay one block even
 * when they contain blank lines.
 */
export function splitParagraphs(md: string): string[] {
  const text = stripFrontmatter(md).replace(/^\s*<!--[\s\S]*?-->\s*/, '');
  const blocks: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const b = buf.join('\n').trim();
    if (b) blocks.push(b);
    buf = [];
  };
  for (const line of text.split('\n')) {
    const f = line.match(FENCE);
    if (fence) {
      buf.push(line);
      if (f && f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      buf.push(line);
      continue;
    }
    if (line.trim() === '') flush();
    else buf.push(line);
  }
  flush();
  return blocks;
}

const isBreak = (p: string) => THEMATIC_BREAK.test(p.trim());
const isFootnoteDef = (p: string) => FOOTNOTE_DEF.test(p);

// ---- scoring --------------------------------------------------------------------------

const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_#>`]/g, '');
const length = (s: string) => plain(s).length;

const CAP_WORD =
  /(?<![.!?„"“]\s)(?<!^)\b[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÀÂÆÇÈÊËÎÏÔŒÙÛÜŸÄÖÑ][\p{L}]{3,}/gu;

function anchors(s: string): { nums: Set<string>; caps: Set<string> } {
  const p = plain(s);
  return {
    nums: new Set(p.match(/\d+/g) ?? []),
    caps: new Set((p.match(CAP_WORD) ?? []).map((w) => w.slice(0, 4).toLowerCase())),
  };
}

function shape(s: string): boolean[] {
  const t = s.trim();
  return [/^["„“”«»'‚‘]/.test(t), t.startsWith('*') && t.endsWith('*'), t.endsWith('?'), t.endsWith('!'), t.startsWith('#')];
}

function cost11(e: string, c: string, ratio: number): number {
  const base = Math.abs(Math.log((length(c) + 15) / (ratio * length(e) + 15))) * 6;
  const ae = anchors(e);
  const ac = anchors(c);
  let numsBoth = 0;
  let numsXor = 0;
  for (const n of ae.nums) (ac.nums.has(n) ? numsBoth++ : numsXor++);
  for (const n of ac.nums) if (!ae.nums.has(n)) numsXor++;
  let capsBoth = 0;
  for (const w of ae.caps) if (ac.caps.has(w)) capsBoth++;
  const bonus = 1.5 * numsBoth + 0.8 * capsBoth - 0.8 * numsXor;
  const se = shape(e);
  const sc = shape(c);
  const same = se.reduce((acc, v, i) => acc + (v === sc[i] ? 1 : 0), 0) - 3;
  return base - Math.min(bonus, 4) - 0.5 * same;
}

/**
 * Align two paragraph sequences. Returns the pairs in order; every input
 * paragraph appears in exactly one pair.
 */
export function alignParagraphs(
  original: string[],
  translation: string[],
  options: Pick<AlignOptions, 'band'> = {}
): AlignPair[] {
  const E = original;
  const C = translation;
  const n = E.length;
  const m = C.length;
  const band = Math.max(options.band ?? 40, Math.abs(n - m) + 5);
  const SKIP = 4.0;
  const MERGE = 1.5;
  const textLenE = E.filter((p) => !isBreak(p)).reduce((a, p) => a + length(p), 0);
  const textLenC = C.filter((p) => !isBreak(p)).reduce((a, p) => a + length(p), 0);
  const ratio = textLenC / Math.max(1, textLenE) || 1;

  const INF = Number.POSITIVE_INFINITY;
  const D: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(INF));
  const B: ([number, number, number] | null)[][] = Array.from({ length: n + 1 }, () =>
    new Array<[number, number, number] | null>(m + 1).fill(null)
  );
  D[0]![0] = 0;
  for (let i = 0; i <= n; i++) {
    const center = Math.round((i * m) / Math.max(n, 1));
    for (let j = Math.max(0, center - band); j <= Math.min(m, center + band); j++) {
      const d = D[i]![j]!;
      if (d === INF) continue;
      const cand: [number, number, number][] = [];
      if (i < n && j < m) {
        const bothBreak = isBreak(E[i]!) && isBreak(C[j]!);
        const eitherBreak = isBreak(E[i]!) || isBreak(C[j]!);
        cand.push([1, 1, bothBreak ? -2 : eitherBreak ? 50 : cost11(E[i]!, C[j]!, ratio)]);
      }
      if (i < n) cand.push([1, 0, SKIP * (isBreak(E[i]!) ? 0.3 : 1)]);
      if (j < m) cand.push([0, 1, SKIP * (isBreak(C[j]!) ? 0.3 : 1)]);
      if (i + 1 < n && j < m && !isBreak(E[i]!) && !isBreak(E[i + 1]!) && !isBreak(C[j]!))
        cand.push([2, 1, cost11(`${E[i]} ${E[i + 1]}`, C[j]!, ratio) + MERGE]);
      if (i < n && j + 1 < m && !isBreak(E[i]!) && !isBreak(C[j]!) && !isBreak(C[j + 1]!))
        cand.push([1, 2, cost11(E[i]!, `${C[j]} ${C[j + 1]}`, ratio) + MERGE]);
      for (const [di, dj, c] of cand) {
        if (d + c < D[i + di]![j + dj]!) {
          D[i + di]![j + dj] = d + c;
          B[i + di]![j + dj] = [di, dj, c];
        }
      }
    }
  }
  if (D[n]![m] === INF) throw new Error('alignParagraphs: no path (band too narrow)');
  const out: AlignPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const [di, dj, c] = B[i]![j]!;
    out.push({ original: E.slice(i - di, i), translation: C.slice(j - dj, j), cost: c });
    i -= di;
    j -= dj;
  }
  return out.reverse();
}

// ---- rendering --------------------------------------------------------------------------

function commentFor(text: string, profile: TmdProfile): { line: string; escaped: boolean } {
  // a blank line would end the cluster (§3) - keep the original one block
  const body = text.replace(/%%/g, '%').replace(/\n[ \t]*\n+/g, '\n');
  const t = classifyComment(body.trim(), profile, body, 0).type;
  if (t === 'original') return { line: `%% ${body} %%`, escaped: false };
  return { line: `%% ${GUARD}${body} %%`, escaped: true };
}

function normalizeBlock(p: string): string {
  return p.replace(/\s+/g, ' ').trim();
}

/**
 * Build a TMD source from original + translation markdown. Frontmatter of the
 * result is `frontmatter` when given, else the translation's own frontmatter.
 */
export function alignToTmd(
  originalMd: string,
  translationMd: string,
  options: AlignOptions & { frontmatter?: string }
): AlignResult {
  const profile = options.profile ?? GENERIC_PROFILE;
  const step = options.idStep ?? 1;
  const width = options.idWidth ?? 4;
  const weak = options.weakThreshold ?? 3.5;

  const allE = splitParagraphs(originalMd);
  const allC = splitParagraphs(translationMd);
  const notesE = allE.filter(isFootnoteDef);
  const notesC = allC.filter(isFootnoteDef);
  const E = allE.filter((p) => !isFootnoteDef(p));
  const C = allC.filter((p) => !isFootnoteDef(p));

  const pairs = alignParagraphs(E, C, options);
  const stats: AlignStats = {
    pairs: pairs.length,
    oneToOne: 0,
    merged: 0,
    originalOnly: 0,
    translationOnly: 0,
    weak: 0,
    sceneBreaks: 0,
    escapedOriginals: 0,
    flags: 0,
  };

  let num = 0;
  const nextId = () => {
    num += step;
    return `%% ${options.idPrefix}.${String(num).padStart(width, '0')} %%`;
  };
  const orig = (p: string) => {
    const r = commentFor(p, profile);
    if (r.escaped) stats.escapedOriginals++;
    return r.line;
  };
  const flag = (text: string) => {
    stats.flags++;
    return `%% ALIGN? ${text} %%`;
  };

  const body: string[] = [];
  for (const { original: e, translation: c, cost } of pairs) {
    // scene breaks stand alone (§7); an original-only break is dropped (it is markup, not text)
    if (c.length === 1 && isBreak(c[0]!)) {
      body.push(options.sceneBreak ?? c[0]!.trim(), '');
      stats.sceneBreaks++;
      continue;
    }
    if (c.length === 0 && e.every(isBreak)) continue;

    if (c.length === 2) {
      // 1 original : 2 translation → second translation paragraph gets its own cluster, flagged
      body.push(nextId(), orig(e[0]!), c[0]!, '');
      body.push(nextId(), c[1]!, flag('continues the original of the previous paragraph'), '');
      stats.merged++;
      continue;
    }
    const cl = [nextId(), ...e.map(orig), ...c];
    if (e.length && !c.length) {
      cl.push(flag('no translation counterpart'));
      stats.originalOnly++;
    } else if (c.length && !e.length) {
      cl.push(flag('no original counterpart'));
      stats.translationOnly++;
    } else if (e.length === 2) {
      stats.merged++;
    } else {
      stats.oneToOne++;
      if (cost > weak) {
        cl.push(flag('weak match, check pairing'));
        stats.weak++;
      }
    }
    body.push(...cl, '');
  }

  // footnote definitions: translation's stay visible at the end, each followed by the
  // original's definition with the same index (if any) as a comment.
  if (notesC.length || notesE.length) {
    for (let k = 0; k < Math.max(notesC.length, notesE.length); k++) {
      const block: string[] = [];
      if (notesC[k]) block.push(notesC[k]!);
      if (notesE[k]) block.push(orig(notesE[k]!));
      if (!notesC[k]) block.push(flag('original footnote without translation'));
      body.push(...block, '');
    }
    if (notesC.length !== notesE.length)
      body.push(flag(`footnote count differs: original ${notesE.length}, translation ${notesC.length}`), '');
  }

  const fm = options.frontmatter ?? frontmatterBlock(translationMd);
  const source = (fm ? fm.replace(/\n*$/, '\n') + '\n' : '') + body.join('\n').replace(/\n+$/, '') + '\n';

  // projection invariant: the visible text must be exactly the translation
  const expected = allC.filter((p) => !isFootnoteDef(p)).concat(notesC).map(normalizeBlock);
  const actual = splitParagraphs(project(source)).map((p) => normalizeBlock(p.replace(new RegExp(GUARD, 'g'), '')));
  const expectedNoBreaks = options.sceneBreak
    ? expected.map((p) => (isBreak(p) ? normalizeBlock(options.sceneBreak!) : p))
    : expected;
  let projectionOk = expectedNoBreaks.length === actual.length;
  let projectionDiff: AlignResult['projectionDiff'];
  for (let k = 0; k < Math.max(expectedNoBreaks.length, actual.length); k++) {
    if (expectedNoBreaks[k] !== actual[k]) {
      projectionOk = false;
      projectionDiff = { index: k, expected: expectedNoBreaks[k] ?? '<none>', actual: actual[k] ?? '<none>' };
      break;
    }
  }
  return { source, stats, projectionOk, projectionDiff };
}
