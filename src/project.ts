/**
 * Projections — FORMAT.md §8: derive a publishable document from TMD files.
 * The baseline projection (§2.2) is `stripComments`; the practical publishing
 * projection here additionally strips legacy `{{…}}` overlays, collapses the
 * blank runs left by stripped comment clusters, and — when concatenating
 * multiple files — emits per-file headings from frontmatter and renumbers
 * footnotes to avoid per-file-uniqueness collisions (§7).
 */
import { parse as parseYaml } from 'yaml';
import { stripComments } from './strip.js';

/** Stray legacy `{{…}}` metadata overlay (§11) — never `{{{ }}}`, which is pipeline plumbing. */
const OVERLAY = /\{\{[^{].*?\}\}/g;
const FOOTNOTE = /\[\^([A-Za-z0-9.-_]+)\]/g;

export interface ProjectOptions {
  /**
   * Namespace prefix applied to every footnote ID in this file, e.g. a chapter
   * number — `[^1]` → `[^12-1]`. Required for collision-free concatenation of
   * files whose footnote uniqueness is per-file (§7, §8.3).
   */
  footnotePrefix?: string;
  /** Strip stray legacy `{{…}}` overlays (§8.2). Default true. */
  stripOverlays?: boolean;
}

/**
 * Project one TMD source string into publishable plain markdown: frontmatter
 * removed, every comment stripped, blank runs collapsed.
 */
export function project(source: string, options: ProjectOptions = {}): string {
  const { footnotePrefix, stripOverlays = true } = options;
  const noFrontmatter = removeFrontmatter(source.replace(/\r\n?/g, '\n'));
  let text = stripComments(noFrontmatter);
  if (stripOverlays) text = text.replace(OVERLAY, '');
  if (footnotePrefix) text = text.replace(FOOTNOTE, (_, id: string) => `[^${footnotePrefix}-${id}]`);
  return collapseBlankRuns(text);
}

export interface ProjectFileInput {
  source: string;
  /**
   * Heading emitted before this file's content, or a function deriving it from
   * the file's frontmatter (e.g. `fm => `## ${fm.chapter}. ${fm.title_cz}``).
   * Omit for no heading.
   */
  heading?: string | ((frontmatter: Record<string, unknown>) => string);
  /** Explicit footnote prefix; defaults to the file's 1-based index. */
  footnotePrefix?: string;
}

/**
 * Concatenate several TMD files into one publishable document (§8.3): heading
 * per file from frontmatter, footnotes renumbered per file.
 */
export function projectMany(files: ProjectFileInput[], options: ProjectOptions = {}): string {
  const parts: string[] = [];
  files.forEach((f, idx) => {
    const fm = readFrontmatter(f.source);
    const heading = typeof f.heading === 'function' ? f.heading(fm) : f.heading;
    const body = project(f.source, {
      ...options,
      footnotePrefix: f.footnotePrefix ?? String(idx + 1),
    });
    if (heading) parts.push(heading, '');
    parts.push(body, '');
  });
  return collapseBlankRuns(parts.join('\n')).trimEnd() + '\n';
}

/** Parse and return a file's YAML frontmatter (empty object when absent/invalid). */
export function readFrontmatter(source: string): Record<string, unknown> {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return {};
  try {
    return (parseYaml(lines.slice(1, end).join('\n')) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function removeFrontmatter(source: string): string {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') return source;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return source;
  return lines.slice(end + 1).join('\n');
}

/** Collapse runs of blank lines (left by stripped comment clusters) to one. */
function collapseBlankRuns(text: string): string {
  const out: string[] = [];
  let prevBlank = true;
  for (const line of text.split('\n')) {
    const blank = line.trim() === '';
    if (blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  while (out.length && out[out.length - 1]!.trim() === '') out.pop();
  return out.join('\n') + (out.length ? '\n' : '');
}
