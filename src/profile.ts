/**
 * Book profile (FORMAT.md §9) — the per-book plug-in layer: paragraph-ID scheme,
 * author vocabulary, footnote scheme, frontmatter fields, optional features.
 * Declared in a machine-readable `format-profile.yaml` at the book repo root.
 */
import { parse as parseYaml } from 'yaml';

export interface ParagraphIdScheme {
  /** Regex source a valid ID matches in full (no anchors needed). */
  pattern: string;
  /** What the dot-separated components mean, e.g. `[chapter, paragraph]`. */
  fields: string[];
  uniqueness: 'global' | 'per-file';
  ordering: string;
}

export interface AuthorScheme {
  style: 'names' | 'codes';
  /** Open vocabulary (§6): new identifiers may be added at any time. */
  vocabulary: string[];
  /** Retired identifiers remain valid in existing annotations forever. */
  retired: string[];
}

export interface FootnoteScheme {
  pattern: string;
  uniqueness: 'per-file' | 'global';
}

export interface TmdFeatures {
  version_comments: boolean;
  glossary_links: boolean;
  tag_annotations: boolean;
}

export interface TmdProfile {
  spec_version: string;
  original_language: string;
  translation_language: string;
  paragraph_id: ParagraphIdScheme;
  authors: AuthorScheme;
  footnotes: FootnoteScheme;
  /** Canonical thematic-break marker for the translation (`* * *` or `---`, §7). */
  scene_break: string;
  features: TmdFeatures;
  frontmatter: { required: string[]; optional: string[] };
  layout?: string;
}

/**
 * A permissive fallback profile: parses any TMD file without book-specific
 * knowledge. The ID pattern is the union of the schemes in use today (§5);
 * real tools should load the book's own `format-profile.yaml` instead.
 */
export const GENERIC_PROFILE: TmdProfile = {
  spec_version: '1.0',
  original_language: 'und',
  translation_language: 'und',
  paragraph_id: {
    pattern: String.raw`(\d{2,3}|GLO_[A-Z0-9_]+|SUM\.\d{3})\.\d{1,4}`,
    fields: ['group', 'sequence'],
    uniqueness: 'global',
    ordering: 'per-group',
  },
  authors: { style: 'names', vocabulary: [], retired: [] },
  footnotes: { pattern: String.raw`\S+`, uniqueness: 'per-file' },
  scene_break: '* * *',
  features: { version_comments: true, glossary_links: true, tag_annotations: true },
  frontmatter: { required: [], optional: [] },
};

/** Parse and validate a `format-profile.yaml` document. Missing optional sections get defaults. */
export function parseProfile(yamlSource: string): TmdProfile {
  const raw = parseYaml(yamlSource) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('format-profile: not a YAML mapping');

  const pid = raw.paragraph_id as Partial<ParagraphIdScheme> | undefined;
  if (!pid?.pattern) throw new Error('format-profile: paragraph_id.pattern is required');
  try {
    new RegExp(pid.pattern);
  } catch (e) {
    throw new Error(`format-profile: paragraph_id.pattern is not a valid regex: ${e}`);
  }

  const authors = (raw.authors ?? {}) as Partial<AuthorScheme>;
  const footnotes = (raw.footnotes ?? {}) as Partial<FootnoteScheme>;
  const features = (raw.features ?? {}) as Partial<TmdFeatures>;
  const frontmatter = (raw.frontmatter ?? {}) as Partial<{ required: string[]; optional: string[] }>;

  return {
    spec_version: String(raw.spec_version ?? '1.0'),
    original_language: String(raw.original_language ?? 'und'),
    translation_language: String(raw.translation_language ?? 'und'),
    paragraph_id: {
      pattern: pid.pattern,
      fields: pid.fields ?? [],
      uniqueness: pid.uniqueness ?? 'global',
      ordering: pid.ordering ?? '',
    },
    authors: {
      style: authors.style ?? 'names',
      vocabulary: authors.vocabulary ?? [],
      retired: authors.retired ?? [],
    },
    footnotes: {
      pattern: footnotes.pattern ?? String.raw`\S+`,
      uniqueness: footnotes.uniqueness ?? 'per-file',
    },
    scene_break: String(raw.scene_break ?? '* * *'),
    features: {
      version_comments: features.version_comments ?? false,
      glossary_links: features.glossary_links ?? false,
      tag_annotations: features.tag_annotations ?? false,
    },
    frontmatter: {
      required: frontmatter.required ?? [],
      optional: frontmatter.optional ?? [],
    },
    layout: raw.layout ? String(raw.layout) : undefined,
  };
}

/** Compile the profile's paragraph-ID pattern anchored for full-content matching. */
export function idRegex(profile: TmdProfile): RegExp {
  return new RegExp(`^(?:${profile.paragraph_id.pattern})$`);
}

/** Compile a regex that finds the profile's ID comment *mid-line* (§2.1 corruption check). */
export function midlineIdRegex(profile: TmdProfile): RegExp {
  return new RegExp(String.raw`\S.*%%\s*(?:${profile.paragraph_id.pattern})\s*%%|%%\s*(?:${profile.paragraph_id.pattern})\s*%%.*\S`);
}
