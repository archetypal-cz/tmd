import { describe, expect, it } from 'vitest';
import {
  checkAudio,
  compileParagraph,
  GENERIC_PROFILE,
  parseLexicon,
  parseMarker,
  planAudio,
  project,
  projectForListening,
  splitSentences,
} from '../src/index.js';

const TMD = `---
title: x
---

%% 010.0001 %%
%% "It's time," said Lord Pilot. %%
„Je na čase,“ řekl Lord Pilot, „abychom to ukončili.“ Pronesl to Thomas Clarksonem v roce 1785.
%%[audio speaker=pilot at="Je na čase" tone=angry pause_before=300]%%
%%[audio say="Lord Pilot" as="lórd pilot"]%%

* * *

%% 010.0002 %%
%% Read [this](https://x.y) *now*. %%
Přečti si [tohle](https://x.y) *hned*.[^1]
%%[audio speaker=narrator tone=calm pause_after=800]%%

%% 010.0003 %%
%% Contents %%
Obsah
%%[audio skip=true]%%

[^1]: Poznámka.
`;

const VOICE = { key: 'tomas', id: 'f225Nmo9MdjZXT8PTUL6' };

describe('projectForListening', () => {
  it('drops links, URLs, emphasis and footnote refs', () => {
    expect(projectForListening('Přečti si [tohle](https://x.y) *hned*.[^1] https://a.b')).toBe('Přečti si tohle hned.');
  });
});

describe('parseMarker', () => {
  it('parses quoted and bare values and flags unknown keys', () => {
    const r = parseMarker('[audio at="Je na čase" tone=angry foo=bar]')!;
    expect(r.marker).toEqual({ at: 'Je na čase', tone: 'angry' });
    expect(r.errors).toEqual(['unknown key foo']);
    expect(parseMarker('[end-note 1]')).toBeNull();
  });
});

describe('compileParagraph', () => {
  it('applies inline tags, pauses after punctuation, Czech stems and leading tone', () => {
    const r = compileParagraph(
      'Řekl Clarksonem: začínáme právě teď.',
      [
        { tone: 'calm' },
        { at: 'začínáme právě teď', pause_after: '600' },
        { say: 'Clarkson', as: 'Klárkson' },
      ]
    );
    expect(r.text).toBe('[calmly] Řekl Klárksonem: začínáme právě teď. [pause]');
    expect(r.errors).toEqual([]);
  });

  it('paragraph say beats the work lexicon; lexicon applies everywhere else', () => {
    const lex = parseLexicon('entries:\n  - say: FBI\n    as: ef bí áj\n  - say: Lord\n    as: Lórd\n');
    const r = compileParagraph('FBI a Lord.', [{ say: 'Lord', as: 'lórd' }], lex);
    expect(r.text).toBe('ef bí áj a lórd.');
  });

  it('reports at= that is missing or ambiguous', () => {
    expect(compileParagraph('a b a b', [{ at: 'a b', tone: 'calm' }]).errors[0]).toMatch(/found 2x/);
    expect(compileParagraph('xyz', [{ at: 'nope', tone: 'calm' }]).errors[0]).toMatch(/found 0x/);
  });

  it('maps furious to [angrily] (2026-11-01 intensity feedback)', () => {
    expect(compileParagraph('Ne!', [{ tone: 'furious' }]).text).toBe('[angrily] Ne!');
  });
});

describe('splitSentences', () => {
  it('splits long text at sentence ends', () => {
    const parts = splitSentences('Jedna věta. Druhá věta! Třetí?', 15);
    expect(parts).toEqual(['Jedna věta.', 'Druhá věta!', 'Třetí?']);
  });
});

describe('planAudio', () => {
  const plan = planAudio(TMD, GENERIC_PROFILE, { voice: VOICE });

  it('compiles every paragraph except skipped ones', () => {
    expect(plan.segments.map((s) => s.pid)).toEqual(['010.0001', '010.0002']);
    expect(plan.segments[0]!.text).toBe(
      '„[short pause] [angrily] Je na čase,“ řekl lórd pilot, „abychom to ukončili.“ Pronesl to Thomas Clarksonem v roce 1785.'
    );
  });

  it('puts scene-break silence after the preceding paragraph', () => {
    expect(plan.segments[0]!.pause_after_ms).toBe(1500);
    expect(plan.segments[1]!.pause_after_ms).toBe(800);
  });

  it('hash depends on voice and text, not on markers that do not change the text', () => {
    const other = planAudio(TMD, GENERIC_PROFILE, { voice: { key: 'eva', id: 'X5oONw80qVQcYhQgP6Zf' } });
    expect(other.segments[0]!.hash).not.toBe(plan.segments[0]!.hash);
    const noted = planAudio(TMD.replace('tone=calm pause_after=800', 'tone=calm pause_after=800 note="x"'), GENERIC_PROFILE, { voice: VOICE });
    expect(noted.segments[1]!.hash).toBe(plan.segments[1]!.hash);
  });

  it('keeps the projection untouched (markers are comments)', () => {
    expect(project(TMD)).not.toContain('audio');
  });

  it('totals and findings', () => {
    expect(plan.totals.segments).toBe(2);
    expect(plan.totals.tags).toBe(3);
    expect(plan.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('checkAudio', () => {
  it('finds bad markers with their paragraph id', () => {
    const bad = TMD.replace('tone=angry', 'tone=livid');
    const f = checkAudio(bad, GENERIC_PROFILE);
    expect(f).toContainEqual(expect.objectContaining({ pid: '010.0001', severity: 'error', message: 'unknown tone livid' }));
  });

  it('warns about a paragraph ending in an engine tag', () => {
    const t = TMD.replace('pause_after=800]', 'pause_after=800]\n%%[audio at="hned" pause_after=700]');
    expect(checkAudio(t, GENERIC_PROFILE).some((f) => f.severity === 'warning' && /ends with an engine tag/.test(f.message))).toBe(true);
  });
});
