/**
 * Deterministic comment classification — FORMAT.md §4. Patterns are tested in
 * spec order, first match wins. This replaces the legacy heuristics ("20+
 * characters starting with a letter = original text").
 */
import type { TmdProfile } from './profile.js';
import { idRegex } from './profile.js';
import type {
  CommentType,
  TmdAnnotation,
  TmdComment,
  TmdMachineFlag,
  TmdVersionComment,
} from './types.js';

/** §6: ISO-8601, seconds required, milliseconds and `Z` optional. */
const TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?`;
/** §6 fallback author shape when no vocabulary is declared. */
const ANNOTATION = new RegExp(`^(${TIMESTAMP})\\s+(\\S{1,24}):\\s(.*)$`, 's');
const MACHINE_FLAG = /^([A-Z]+)\?\s*(.*)$/s;
const VERSION = /^v(\d+(?:[._-]\d+)*)\s+(.*)$/s;

/**
 * §6 legacy quirk: auto-incremented timestamps overflowed seconds (`:60`, `:61`).
 * Normalize by carrying into minutes. Returns the input unchanged when sane.
 */
export function normalizeTimestamp(ts: string): { timestamp: string; overflowed: boolean } {
  const m = ts.match(/^(\d{4}-\d{2}-\d{2}T\d{2}):(\d{2}):(\d{2})((?:\.\d{3})?Z?)$/);
  if (!m) return { timestamp: ts, overflowed: false };
  const sec = parseInt(m[3]!, 10);
  if (sec < 60) return { timestamp: ts, overflowed: false };
  const min = parseInt(m[2]!, 10) + Math.floor(sec / 60);
  const normalized = `${m[1]}:${String(min).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}${m[4]}`;
  return { timestamp: normalized, overflowed: true };
}

/**
 * Classify the content of one `%% … %%` comment (delimiters already removed,
 * outer whitespace trimmed) per the §4 table. Returns a fully-populated comment
 * object; `raw` and `line` are the caller's bookkeeping.
 */
export function classifyComment(
  content: string,
  profile: TmdProfile,
  raw: string,
  line: number
): TmdComment {
  const base = { content, raw, line };

  // 1. Paragraph ID (profile-defined, §5)
  if (idRegex(profile).test(content)) {
    return { ...base, type: 'paragraph-id' };
  }

  // 2. Annotation — anchor author matching to the declared vocabulary where one
  // exists (original prose can contain `Louis XIV:`-style text), falling back
  // to the generic shape after a valid timestamp (§6).
  const ann = content.match(ANNOTATION);
  if (ann) {
    const vocab = [...profile.authors.vocabulary, ...profile.authors.retired];
    if (vocab.length === 0 || vocab.includes(ann[2]!) || genericAuthorOk(profile, ann[2]!)) {
      const { timestamp } = normalizeTimestamp(ann[1]!);
      const out: TmdAnnotation = {
        ...base,
        type: 'annotation',
        timestamp,
        author: ann[2]!,
        text: ann[3]!.trim(),
      };
      return out;
    }
  }

  // 3. Machine flag: `ALIGN? …`, `FORMAT? …`
  const flag = content.match(MACHINE_FLAG);
  if (flag) {
    const out: TmdMachineFlag = { ...base, type: 'machine-flag', flag: flag[1]!, text: flag[2]!.trim() };
    return out;
  }

  // 4. Version comment (optional feature): `v1.2 earlier translation`
  const ver = content.match(VERSION);
  if (ver) {
    const out: TmdVersionComment = { ...base, type: 'version', version: `v${ver[1]}`, text: ver[2]!.trim() };
    return out;
  }

  // 5. Glossary link: `[#Name](…)`, ≥1 link
  if (content.startsWith('[#')) {
    return { ...base, type: 'glossary-link' };
  }

  // 6. Tag annotation: `[` immediately after `%%`, e.g. `%%[end-note 1]%%`
  if (content.startsWith('[')) {
    return { ...base, type: 'tag-annotation' };
  }

  // 7. Original text — anything else
  return { ...base, type: 'original' };
}

/**
 * With a declared vocabulary, an unknown author after a valid timestamp is
 * still an annotation (the vocabulary is open, §6) — but only when the author
 * token looks like the profile's style, so `Louis XIV:` in original prose
 * doesn't get misread. Role codes are ALL-CAPS; names start with a capital.
 */
function genericAuthorOk(profile: TmdProfile, author: string): boolean {
  return profile.authors.style === 'codes' ? /^[A-Z]{2,8}$/.test(author) : /^\p{Lu}[\p{L}\d._-]*$/u.test(author);
}

export type { CommentType };
