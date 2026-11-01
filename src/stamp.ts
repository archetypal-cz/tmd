/**
 * Stamping — give a translation-only file permanent paragraph IDs (audio-plan
 * §12.2: "IDs for everything"). Inserts `%% PREFIX.NNNN %%` before every
 * visible paragraph except scene breaks and footnote definitions; the visible
 * text is untouched, so the projection is byte-for-byte the input body.
 *
 * Refuses files that already carry IDs of the profile's pattern — IDs are
 * permanent (§5): re-stamping would renumber them.
 */
import { GENERIC_PROFILE, type TmdProfile } from './profile.js';
import { frontmatterBlock, splitParagraphs } from './align.js';

export interface StampOptions {
  idPrefix: string;
  idStep?: number;
  idWidth?: number;
  profile?: TmdProfile;
}

export interface StampResult {
  source: string;
  stamped: number;
}

const THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/;

export function stamp(md: string, options: StampOptions): StampResult {
  const profile = options.profile ?? GENERIC_PROFILE;
  const step = options.idStep ?? 1;
  const width = options.idWidth ?? 4;
  const src = md.replace(/\r\n?/g, '\n');
  const idLine = new RegExp(`^%%\\s*(?:${profile.paragraph_id.pattern})\\s*%%\\s*$`, 'm');
  if (idLine.test(src)) throw new Error('stamp: file already has paragraph IDs - IDs are permanent, refusing to renumber');
  const fm = frontmatterBlock(src);
  const blocks = splitParagraphs(src);
  let num = 0;
  const out: string[] = [];
  for (const b of blocks) {
    if (THEMATIC_BREAK.test(b.trim()) || FOOTNOTE_DEF.test(b)) {
      out.push(b, '');
      continue;
    }
    num += step;
    out.push(`%% ${options.idPrefix}.${String(num).padStart(width, '0')} %%`, b, '');
  }
  const source = (fm ? fm.replace(/\n*$/, '\n') + '\n' : '') + out.join('\n').replace(/\n+$/, '') + '\n';
  return { source, stamped: num };
}
