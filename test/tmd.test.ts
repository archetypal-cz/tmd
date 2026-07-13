import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyComment,
  GENERIC_PROFILE,
  normalizeTimestamp,
  parse,
  parseProfile,
  project,
  projectMany,
  stripComments,
  validate,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf-8');
const profileYaml = (name: string) =>
  fs.readFileSync(path.join(here, '..', 'profiles', name), 'utf-8');

const hpamr = parseProfile(profileYaml('hpamr.yaml'));
const bash = parseProfile(profileYaml('bashkirtseff.yaml'));

describe('parseProfile', () => {
  it('loads the real HPaMR profile', () => {
    expect(hpamr.original_language).toBe('en');
    expect(hpamr.authors.style).toBe('names');
    expect(hpamr.authors.vocabulary).toContain('Kerray');
    expect(hpamr.scene_break).toBe('* * *');
    expect(hpamr.features.glossary_links).toBe(false);
  });

  it('loads the real Bashkirtseff profile', () => {
    expect(bash.authors.style).toBe('codes');
    expect(bash.authors.retired).toContain('GEM');
    expect(bash.features.glossary_links).toBe(true);
  });

  it('rejects a profile without an ID pattern', () => {
    expect(() => parseProfile('spec_version: "1.0"')).toThrow(/paragraph_id.pattern/);
  });
});

describe('classifyComment (§4 order)', () => {
  const c = (content: string, profile = hpamr) => classifyComment(content, profile, '', 1).type;

  it('classifies paragraph IDs per profile', () => {
    expect(c('001.0001')).toBe('paragraph-id');
    expect(c('042.0137')).toBe('paragraph-id');
    expect(c('GLO_VISCONTI.0001', bash)).toBe('paragraph-id');
    expect(c('SUM.001.0001', bash)).toBe('paragraph-id');
    expect(c('GLO_VISCONTI.0001', hpamr)).toBe('original'); // not in HPaMR's scheme
  });

  it('classifies annotations, anchored to the vocabulary', () => {
    expect(c('2015-12-08T23:05:03 Kerray: doplnit poznámku')).toBe('annotation');
    expect(c('2025-12-07T16:00:00.000Z LAN: idiom', bash)).toBe('annotation');
    // open vocabulary: unknown-but-plausible author still parses as annotation
    expect(c('2026-01-01T00:00:00 Novák: nová poznámka')).toBe('annotation');
  });

  it('classifies machine flags before original text', () => {
    expect(c('ALIGN? no English counterpart')).toBe('machine-flag');
    expect(c('FORMAT? emphasis not carried')).toBe('machine-flag');
  });

  it('classifies version comments', () => {
    expect(c('v1.2 starší verze překladu', bash)).toBe('version');
    expect(c('von Neumann was here')).toBe('original'); // v not followed by digits
  });

  it('classifies glossary links and tag annotations', () => {
    expect(c('[#Nice](../../_original/_glossary/places/cities/NICE.md)', bash)).toBe('glossary-link');
    expect(c('[end-note 1]', bash)).toBe('tag-annotation');
  });

  it('falls through to original text', () => {
    expect(c('Beneath the moonlight glints a tiny fragment of silver')).toBe('original');
    // annotation-lookalike inside original prose does not match (timestamp required)
    expect(c('Louis XIV: le Roi Soleil')).toBe('original');
  });
});

describe('normalizeTimestamp (§6 overflow quirk)', () => {
  it('carries overflowed seconds into minutes', () => {
    expect(normalizeTimestamp('2025-12-07T16:00:61')).toEqual({
      timestamp: '2025-12-07T16:01:01',
      overflowed: true,
    });
  });
  it('leaves sane timestamps alone', () => {
    expect(normalizeTimestamp('2025-12-07T16:00:59').overflowed).toBe(false);
  });
});

describe('parse', () => {
  it('parses the real HPaMR chapter 1', () => {
    const doc = parse(fixture('hpamr-ch1.md'), hpamr);
    expect(doc.frontmatter.chapter).toBe('001');
    expect(doc.frontmatter.title_en).toBe('A Day of Very Low Probability');
    expect(doc.clusters.length).toBeGreaterThan(50);
    const first = doc.clusters[0]!;
    expect(first.id).toBe('001.0001');
    expect(first.original.join(' ')).toContain('Beneath the moonlight');
    expect(first.translation.join(' ')).toContain('Rowlingové');
    // 001.0003 carries a Kerray annotation
    const c3 = doc.clusters.find((cl) => cl.id === '001.0003')!;
    expect(c3.annotations[0]?.author).toBe('Kerray');
    // scene breaks stand alone between clusters (§3)
    expect(doc.standalone.some((s) => s.lines.some((l) => l.trim() === '* * *'))).toBe(true);
    expect(doc.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  it('parses the real Bashkirtseff entry', () => {
    const doc = parse(fixture('bashkirtseff-entry.md'), bash);
    expect(doc.frontmatter.carnet).toBe('001');
    const first = doc.clusters[0]!;
    expect(first.id).toBe('001.0001');
    expect(first.otherComments.some((cm) => cm.type === 'glossary-link')).toBe(true);
    expect(first.annotations.some((a) => a.author === 'LAN')).toBe(true);
    expect(first.original.join(' ')).toContain('Carnet N° 1');
    expect(first.translation.join(' ')).toContain('Sešit č. 1');
    expect(doc.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  });

  it('warns loudly on mid-line paragraph IDs (§2.1)', () => {
    const doc = parse('text before %% 001.0001 %% text after\n', hpamr);
    expect(doc.warnings.some((w) => w.code === 'midline-id' && w.severity === 'error')).toBe(true);
  });

  it('warns on duplicate IDs (§2.3)', () => {
    const src = '%% 001.0001 %%\nJednou.\n\n%% 001.0001 %%\nPodruhé.\n';
    const doc = parse(src, hpamr);
    expect(doc.warnings.some((w) => w.code === 'duplicate-id')).toBe(true);
  });

  it('tolerates legacy layout (content before the ID) and flags it', () => {
    const src = '%% Le texte original %%\n%% 001.0001 %%\nPřeklad.\n';
    const doc = parse(src, bash);
    expect(doc.clusters[0]!.legacyLayout).toBe(true);
    expect(doc.clusters[0]!.original[0]).toBe('Le texte original');
    expect(doc.warnings.some((w) => w.code === 'legacy-layout')).toBe(true);
  });

  it('reads multi-line comment blocks', () => {
    const src = '%% 001.0001 %%\n%%\nA very long original paragraph\nspanning several lines.\n%%\nPřeklad.\n';
    const doc = parse(src, hpamr);
    expect(doc.clusters[0]!.original[0]).toContain('spanning several lines');
    expect(doc.clusters[0]!.translation).toEqual(['Překlad.']);
  });

  it('surfaces open machine flags as work items', () => {
    const src = '%% 001.0001 %%\n%% ALIGN? no English counterpart %%\nPřeklad.\n';
    const doc = parse(src, hpamr);
    expect(doc.clusters[0]!.flags[0]!.flag).toBe('ALIGN');
    expect(doc.warnings.some((w) => w.code === 'machine-flag' && w.severity === 'info')).toBe(true);
  });

  it('recovers from a comment that closes mid-line with trailing prose (§2.1)', () => {
    // real defect shape from bashkirtseff carnet 071: annotation glued to translation
    const src =
      '%% 071.0030 %%\n%% 2026-06-10T14:10:00 RED: oprava %% Jen ať se dá představit.\n';
    const doc = parse(src, bash);
    expect(doc.warnings.some((w) => w.code === 'inline-structural-comment')).toBe(true);
    expect(doc.clusters[0]!.annotations[0]?.author).toBe('RED');
    expect(doc.clusters[0]!.translation.join(' ')).toContain('Jen ať se dá představit.');
    expect(doc.warnings.some((w) => w.code === 'unterminated-comment')).toBe(false);
  });

  it('preserves unknown comments (§2.5) and legacy [//]: # remarks (§11)', () => {
    const src = '%% 001.0001 %%\n%%[end-note 1]%%\nPřeklad.\n\n[//]: # ( old remark )\n';
    const doc = parse(src, bash);
    expect(doc.clusters[0]!.otherComments[0]!.type).toBe('tag-annotation');
    expect(doc.warnings.some((w) => w.code === 'legacy-comment')).toBe(true);
  });
});

describe('stripComments / project (§2.2, §8)', () => {
  it('projection invariant on real HPaMR content: strip the %%, get the book', () => {
    const out = project(fixture('hpamr-ch1.md'));
    expect(out).not.toContain('%%');
    expect(out).toContain('Prohlášení: Vše stále patří J. K. Rowlingové.');
    expect(out).not.toContain('Beneath the moonlight'); // no original text leaks
    expect(out).not.toContain('Kerray:'); // no annotations leak
    expect(out).not.toMatch(/\n\n\n/); // blank runs collapsed
  });

  it('projection invariant on real Bashkirtseff content', () => {
    const out = project(fixture('bashkirtseff-entry.md'));
    expect(out).not.toContain('%%');
    expect(out).toContain('Sešit č. 1');
    expect(out).not.toContain('Carnet N° 1'); // French original stays in comments
    expect(out).not.toContain('LAN:');
    expect(out).not.toContain('date: 1873-01-11'); // frontmatter removed
  });

  it('handles inline comments without inventing whitespace', () => {
    expect(stripComments('a%%c%%b')).toBe('ab');
    expect(stripComments('text %%c%% more')).toBe('text more');
  });

  it('fails safe on unterminated comments', () => {
    expect(stripComments('viditelné\n%% tajný originál bez konce')).toBe('viditelné\n');
  });

  it('leaves %% inside code alone', () => {
    const src = 'před `a %% b` po\n\n```\n%% not a comment %%\n```\n';
    expect(stripComments(src)).toBe(src);
  });

  it('strips legacy {{…}} overlays but not {{{ }}} pipeline plumbing', () => {
    const out = project('%% 001.0001 %%\nNadpis {{"chapter": 1}} konec\n');
    expect(out).toBe('Nadpis  konec\n');
  });

  it('projectMany renumbers footnotes per file (§8.3)', () => {
    const ch1 = '---\nchapter: "001"\ntitle_cz: "První"\n---\n%% 001.0001 %%\nText[^1].\n\n[^1]: první pozn.\n';
    const ch2 = '---\nchapter: "002"\ntitle_cz: "Druhá"\n---\n%% 002.0001 %%\nJiný[^1].\n\n[^1]: druhá pozn.\n';
    const heading = (fm: Record<string, unknown>) => `## ${Number(fm.chapter)}. ${fm.title_cz}`;
    const out = projectMany([
      { source: ch1, heading, footnotePrefix: '1' },
      { source: ch2, heading, footnotePrefix: '2' },
    ]);
    expect(out).toContain('## 1. První');
    expect(out).toContain('Text[^1-1].');
    expect(out).toContain('[^2-1]: druhá pozn.');
    expect(out).not.toContain('%%');
  });
});

describe('validate (§10)', () => {
  it('passes real content', () => {
    const result = validate(
      [
        { source: fixture('hpamr-ch1.md'), file: 'hpamr-ch1.md' },
      ],
      hpamr
    );
    expect(result.ok).toBe(true);
  });

  it('catches cross-file duplicate IDs under global uniqueness', () => {
    const a = '%% 001.0001 %%\nJedna.\n';
    const result = validate(
      [
        { source: a, file: 'a.md' },
        { source: a, file: 'b.md' },
      ],
      hpamr
    );
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.code === 'duplicate-id' && w.file === 'b.md')).toBe(true);
  });

  it('catches undefined and unused footnotes', () => {
    const src = '%% 001.0001 %%\nOdkaz[^1] a[^2].\n\n[^1]: definice.\n[^3]: sirotek.\n';
    const result = validate([{ source: src, file: 'x.md' }], hpamr);
    expect(result.warnings.some((w) => w.code === 'footnote-undefined')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'footnote-unused')).toBe(true);
  });

  it('catches missing required frontmatter', () => {
    const result = validate([{ source: '%% 001.0001 %%\nText.\n', file: 'x.md' }], hpamr);
    expect(result.warnings.some((w) => w.message.includes('title_cz'))).toBe(true);
  });

  it('generic profile parses anything with IDs in the union scheme', () => {
    const doc = parse('%% 00.01 %%\nText.\n', GENERIC_PROFILE);
    expect(doc.clusters[0]!.id).toBe('00.01');
  });
});
