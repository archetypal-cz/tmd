import { describe, expect, it } from 'vitest';
import {
  alignParagraphs,
  alignToTmd,
  GENERIC_PROFILE,
  parse,
  project,
  splitParagraphs,
  stamp,
} from '../src/index.js';

const EN = `---
title: x
---

<!-- scraped -->

It was a dark and stormy night. The wind howled over the moors of Yorkshire in 1847.

"Who goes there?" asked Heathcliff.

* * *

She did not answer. She simply turned away, and the door closed behind her with a soft click.

[Click here](https://example.com) for the rest of the story.

OK? Fine.

The end.[^1]

[^1]: Written in 2020.
`;

const CS = `---
title: "Temná noc"
---

Byla temná a bouřlivá noc. Vítr hvízdal nad vřesovišti Yorkshiru roku 1847.

„Kdo je tam?“ zeptal se Heathcliff.

* * *

Neodpověděla. Jen se otočila.

Dveře se za ní zavřely s tichým cvaknutím.

[Klikni sem](https://example.com) pro zbytek příběhu.

Dobře? Fajn.

Konec.[^1]

[^1]: Napsáno v roce 2020.
`;

describe('splitParagraphs', () => {
  it('drops frontmatter and a leading HTML comment', () => {
    const p = splitParagraphs(EN);
    expect(p[0]).toMatch(/^It was a dark/);
    expect(p).toContain('* * *');
  });

  it('keeps fenced code with blank lines as one block', () => {
    const p = splitParagraphs('a\n\n```\nx\n\ny\n```\n\nb\n');
    expect(p).toEqual(['a', '```\nx\n\ny\n```', 'b']);
  });
});

describe('alignParagraphs', () => {
  it('pairs 1-1 when counts and lengths match', () => {
    const pairs = alignParagraphs(['One two three.', 'Four five six seven.'], ['Jedna dva tři.', 'Čtyři pět šest sedm.']);
    expect(pairs.map((p) => [p.original.length, p.translation.length])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it('finds a 1-2 split by length', () => {
    const long = 'She did not answer. She simply turned away, and the door closed behind her with a soft click.';
    const pairs = alignParagraphs(['Short line here.', long, 'Last one.'], ['Krátký řádek.', 'Neodpověděla. Jen se otočila.', 'Dveře se za ní zavřely s tichým cvaknutím.', 'Poslední.']);
    expect(pairs.map((p) => [p.original.length, p.translation.length])).toEqual([
      [1, 1],
      [1, 2],
      [1, 1],
    ]);
  });
});

describe('alignToTmd', () => {
  const r = alignToTmd(EN, CS, { idPrefix: '002' });

  it('keeps the projection invariant', () => {
    expect(r.projectionOk).toBe(true);
  });

  it('keeps the translation frontmatter and writes canonical clusters', () => {
    expect(r.source.startsWith('---\ntitle: "Temná noc"\n---\n\n%% 002.0001 %%\n%% It was a dark')).toBe(true);
  });

  it('flags the 1:2 split and keeps the scene break standalone', () => {
    expect(r.source).toContain('%% ALIGN? continues the original of the previous paragraph %%');
    expect(r.source).toMatch(/\n\* \* \*\n/);
    expect(r.stats.sceneBreaks).toBe(1);
    expect(r.stats.merged).toBe(1);
  });

  it('guards originals that would misclassify (§4) so they parse as original text', () => {
    expect(r.stats.escapedOriginals).toBe(3); // "[Click here](…)", "OK? Fine." and the "[^1]: …" footnote
    const doc = parse(r.source, GENERIC_PROFILE);
    expect(doc.clusters.flatMap((c) => c.otherComments)).toEqual([]);
    expect(doc.clusters.flatMap((c) => c.flags)).toHaveLength(r.stats.flags);
    expect(doc.clusters.some((c) => c.original.some((o) => o.includes('[Click here]')))).toBe(true);
    expect(doc.clusters.some((c) => c.original.some((o) => o.includes('OK? Fine.')))).toBe(true);
    const standaloneTypes = doc.standalone.flatMap((s) => s.comments).map((c) => c.type);
    expect(standaloneTypes).not.toContain('tag-annotation');
  });

  it('pairs footnote definitions by index', () => {
    expect(r.source).toMatch(/\[\^1\]: Napsáno v roce 2020\.\n%% .*\[\^1\]: Written in 2020\. %%/);
  });

  it('does not leak originals into the projection', () => {
    const out = project(r.source);
    expect(out).not.toContain('stormy');
    expect(out).not.toContain('Written in');
  });

  it('respects idStep', () => {
    expect(alignToTmd(EN, CS, { idPrefix: '002', idStep: 10 }).source).toContain('%% 002.0020 %%');
  });

  it('reports a projection failure instead of hiding it', () => {
    const bad = alignToTmd('A sentence.\n', 'Jsem si jistý na 100 %% opravdu.\n', { idPrefix: '003' });
    expect(bad.projectionOk).toBe(false);
    expect(bad.projectionDiff?.index).toBe(0);
  });
});

describe('stamp', () => {
  it('inserts IDs and leaves the projection identical to the body', () => {
    const r = stamp(CS, { idPrefix: '005' });
    expect(r.stamped).toBe(7); // 9 blocks minus the scene break and the footnote definition
    expect(r.source).toContain('%% 005.0001 %%\nByla temná');
    expect(splitParagraphs(project(r.source))).toEqual(splitParagraphs(CS));
  });

  it('refuses a file that already has IDs', () => {
    const once = stamp(CS, { idPrefix: '005' }).source;
    expect(() => stamp(once, { idPrefix: '005' })).toThrow(/already has paragraph IDs/);
  });
});
