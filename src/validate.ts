/**
 * CI-friendly lint — FORMAT.md §10 conformance checks over one file or a
 * corpus: stable-ID uniqueness in the profile's declared scope, footnote
 * integrity, open machine flags, legacy layouts, and the §2.2 projection
 * invariant (stripping every comment must leave no `%%` residue and no
 * legacy `{{…}}` overlays).
 */
import { parse } from './parse.js';
import { project } from './project.js';
import type { TmdProfile } from './profile.js';
import type { TmdDocument, TmdWarning } from './types.js';

const FOOTNOTE_REF = /\[\^([^\]\s]+)\]/g;
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:/;

export interface ValidateFileInput {
  source: string;
  /** Path used in warning output. */
  file?: string;
}

export interface ValidateResult {
  warnings: TmdWarning[];
  /** Per-file parse results, for callers that want the documents too. */
  documents: TmdDocument[];
  /** True when no error-severity warnings were produced. */
  ok: boolean;
}

/** Validate a corpus of TMD files against a profile. */
export function validate(files: ValidateFileInput[], profile: TmdProfile): ValidateResult {
  const warnings: TmdWarning[] = [];
  const documents: TmdDocument[] = [];
  const globalIds = new Map<string, string>(); // id → first file

  for (const { source, file } of files) {
    const doc = parse(source, profile);
    documents.push(doc);
    warnings.push(...doc.warnings.map((w) => ({ ...w, file })));

    // §2.3 / §5 — ID uniqueness in the declared scope (parse() already catches
    // per-file duplicates; check across files when uniqueness is global).
    if (profile.paragraph_id.uniqueness === 'global') {
      for (const cluster of doc.clusters) {
        const firstFile = globalIds.get(cluster.id);
        if (firstFile !== undefined && firstFile !== file) {
          warnings.push({
            code: 'duplicate-id',
            message: `paragraph ID ${cluster.id} already used in ${firstFile || 'another file'}`,
            line: cluster.line,
            file,
            severity: 'error',
          });
        } else if (firstFile === undefined) {
          globalIds.set(cluster.id, file ?? '');
        }
      }
    }

    // §7 — footnote integrity within the file's visible text
    const projected = project(source);
    const refs = new Set<string>();
    const defs = new Set<string>();
    for (const line of projected.split('\n')) {
      const def = line.match(FOOTNOTE_DEF);
      if (def) {
        if (defs.has(def[1]!)) {
          warnings.push({
            code: 'duplicate-footnote',
            message: `footnote [^${def[1]}] defined more than once`,
            file,
            severity: 'error',
          });
        }
        defs.add(def[1]!);
        continue;
      }
      for (const m of line.matchAll(FOOTNOTE_REF)) refs.add(m[1]!);
    }
    for (const r of refs) {
      if (!defs.has(r)) {
        warnings.push({
          code: 'footnote-undefined',
          message: `footnote [^${r}] referenced but never defined`,
          file,
          severity: 'error',
        });
      }
    }
    for (const d of defs) {
      if (!refs.has(d)) {
        warnings.push({
          code: 'footnote-unused',
          message: `footnote [^${d}] defined but never referenced`,
          file,
          severity: 'warning',
        });
      }
    }

    // §2.2 — projection invariant: no comment or overlay residue
    if (projected.includes('%%')) {
      warnings.push({
        code: 'projection-residue',
        message: '`%%` residue after projection — the file violates the §2.2 projection invariant',
        file,
        severity: 'error',
      });
    }
    if (/\{\{[^{]/.test(projected)) {
      warnings.push({
        code: 'overlay-residue',
        message: 'legacy `{{…}}` overlay residue after projection (§8.2 — move to frontmatter)',
        file,
        severity: 'error',
      });
    }

    // §9 — required frontmatter fields
    for (const key of profile.frontmatter.required) {
      if (!(key in doc.frontmatter)) {
        warnings.push({
          code: 'legacy-layout',
          message: `required frontmatter field "${key}" is missing`,
          file,
          severity: 'error',
        });
      }
    }
  }

  return {
    warnings,
    documents,
    ok: !warnings.some((w) => w.severity === 'error'),
  };
}
