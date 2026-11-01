import { describe, expect, it } from 'vitest';
import {
  checkAudio,
  compileParagraph,
  compileRuns,
  parseCast,
  parseEffects,
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

describe('literal brackets', () => {
  it('turns literal [..] in the work text into (..) so the engine does not treat them as tags', () => {
    expect(projectForListening('Verš. [Pozn. překl.: Fischer]')).toBe('Verš. (Pozn. překl.: Fischer)');
    expect(compileParagraph('Verš. [Pozn.]', [{ tone: 'calm' }]).text).toBe('[calmly] Verš. (Pozn.)');
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

// ---- radio play (cast mode) ----------------------------------------------------------------

const VOICES = {
  tomas: { id: 'f225Nmo9MdjZXT8PTUL6', name: 'Tomas' },
  eva: { id: 'X5oONw80qVQcYhQgP6Zf', name: 'Eva' },
  filip: { id: 'ldAghHa0sbrFzmtJkg4g' },
  adam: { id: 'uYFJyGaibp4N2VwYQshk' },
};
const CAST_YAML = `version: 1
labels: hide
turn_pause_ms: 250
default_role: vypravec
labels_map: {MANNOVÁ: mannova, VZDUCH: vzduch}
roles:
  vypravec: {voice: tomas}
  mannova: {voice: eva}
  vzduch: {voice: filip, fx: robot}
  buh: {voice: adam}
`;
const EFFECTS = parseEffects(`version: 1
presets:
  robot: {desc: "robot", ffmpeg: "afftfilt=real='hypot(re,im)':imag='0'"}
  telefon: {desc: "telefon", ffmpeg: "highpass=f=300,lowpass=f=3400"}
  sakralni: {desc: "dozvuk", ffmpeg: "aecho=0.8:0.7:60:0.35"}
`).presets;
const CAST_TMD = `---
title: y
---

%% 020.0001 %%
%% **MANN:** Fine. %%
**MANNOVÁ:** Dobře. Moje první otázka.
%%[audio tone=dry]%%

%% 020.0002 %%
%% **AIR:** story %%
**VZDUCH:** Šel jsem pryč. „Nemám ve zvyku odpovídat,“ řekl Bůh. Pak jsem odešel.
%%[audio at="Nemám ve zvyku" until="odpovídat" speaker=buh]%%

%% 020.0003 %%
%% narration %%
Vypravěč mluví.
`;
const castOf = (yaml = CAST_YAML) => {
  const r = parseCast(yaml, VOICES);
  expect(r.errors).toEqual([]);
  return r.cast!;
};

describe('cast: no cast is unchanged', () => {
  it('plan stays version 1 with the same hashes as v0.2.1', () => {
    const plan = planAudio(TMD, GENERIC_PROFILE, { voice: VOICE });
    expect(plan.version).toBe(1);
    expect(plan.segments.map((s) => s.hash)).toEqual(['2dcb2742f9db64b8', '4f925182b851f262']);
    expect(Object.keys(plan.segments[0]!)).toEqual(['pid', 'speaker', 'text', 'plain', 'pause_after_ms', 'chars', 'hash', 'directed']);
    expect(plan).not.toHaveProperty('cast');
    expect(plan.totals).not.toHaveProperty('roles');
  });

  it('labels are read and spans ignored (with a warning) without a cast', () => {
    const plan = planAudio(CAST_TMD, GENERIC_PROFILE, { voice: VOICE });
    expect(plan.segments.map((s) => s.pid)).toEqual(['020.0001', '020.0002', '020.0003']);
    expect(plan.segments[0]!.text).toBe('[dryly] MANNOVÁ: Dobře. Moje první otázka.');
    expect(plan.findings).toContainEqual(expect.objectContaining({ pid: '020.0002', severity: 'warning' }));
  });
});

describe('cast: labels', () => {
  const plan = planAudio(CAST_TMD, GENERIC_PROFILE, { cast: castOf(), effects: EFFECTS });

  it('hides the label from text, keeps it in plain, speaker from labels_map', () => {
    const s = plan.segments[0]!;
    expect(s.text).toBe('[dryly] Dobře. Moje první otázka.');
    expect(s.plain).toBe('MANNOVÁ: Dobře. Moje první otázka.');
    expect(s.role).toBe('mannova');
    expect(s.speaker).toBe('mannova');
    expect(s.voice).toEqual({ key: 'eva', id: VOICES.eva.id });
  });

  it('labels: read keeps the label in the engine text', () => {
    const read = planAudio(CAST_TMD, GENERIC_PROFILE, { cast: castOf(CAST_YAML.replace('labels: hide', 'labels: read')), effects: EFFECTS });
    expect(read.segments[0]!.text).toBe('[dryly] MANNOVÁ: Dobře. Moje první otázka.');
    expect(read.segments[0]!.role).toBe('mannova');
  });

  it('unknown label is an error; paragraph speaker= overrides the label', () => {
    const t = CAST_TMD.replace('**MANNOVÁ:** Dobře.', '**KDOSI:** Dobře.');
    expect(checkAudio(t, GENERIC_PROFILE, [], { cast: castOf(), effects: EFFECTS })).toContainEqual(
      expect.objectContaining({ pid: '020.0001', severity: 'error', message: 'unknown label KDOSI (not in cast labels_map)' })
    );
    const r = compileRuns('**MANNOVÁ:** Ano.', [{ speaker: 'vzduch' }], [], { cast: castOf(), effects: EFFECTS });
    expect(r.runs.map((x) => [x.role, x.text])).toEqual([['vzduch', 'Ano.']]);
    // mixed-case bold lead-in that the cast does not know is not a label
    const n = compileRuns('**Poznámka:** text.', [], [], { cast: castOf(), effects: EFFECTS });
    expect(n.errors).toEqual([]);
    expect(n.runs[0]!.role).toBe('vypravec');
  });

  it('warns about lexicon entries for labels in hide mode', () => {
    const lex = parseLexicon('entries:\n  - {say: "MANNOVÁ:", as: "Mannová:"}\n  - {say: "AI", as: "ej áj"}\n');
    const f = checkAudio(CAST_TMD, GENERIC_PROFILE, lex, { cast: castOf(), effects: EFFECTS });
    expect(f.filter((x) => /pointless/.test(x.message))).toEqual([
      { severity: 'warning', message: 'lexicon say="MANNOVÁ:" is pointless with labels: hide (the label is not read)' },
    ]);
    expect(f.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('cast: speaker spans', () => {
  const plan = planAudio(CAST_TMD, GENERIC_PROFILE, { cast: castOf(), effects: EFFECTS });

  it('splits a paragraph at at/until into 3 runs with their own voices', () => {
    const segs = plan.segments.filter((s) => s.pid.startsWith('020.0002'));
    expect(segs.map((s) => [s.pid, s.role, s.text, s.fx])).toEqual([
      ['020.0002#1', 'vzduch', 'Šel jsem pryč.', 'robot'],
      ['020.0002#2', 'buh', '„Nemám ve zvyku odpovídat,“', undefined],
      ['020.0002#3', 'vzduch', 'řekl Bůh. Pak jsem odešel.', 'robot'],
    ]);
    expect(segs.map((s) => s.plain)).toEqual(['VZDUCH: Šel jsem pryč.', '„Nemám ve zvyku odpovídat,“', 'řekl Bůh. Pak jsem odešel.']);
    expect(segs[1]!.voice).toEqual({ key: 'adam', id: VOICES.adam.id });
    expect(plan.fx).toEqual({ robot: EFFECTS.robot });
    expect(plan.totals.roles).toEqual({
      mannova: 'Dobře. Moje první otázka.'.length + '[dryly] '.length,
      vzduch: 'Šel jsem pryč.'.length + 'řekl Bůh. Pak jsem odešel.'.length,
      buh: '„Nemám ve zvyku odpovídat,“'.length,
      vypravec: 'Vypravěč mluví.'.length,
    });
  });

  it('adds turn_pause_ms only on a speaker change after a segment without its own pause', () => {
    expect(plan.segments.map((s) => s.pause_after_ms)).toEqual([250, 250, 250, 250, 0]);
    const p = planAudio(CAST_TMD.replace('%%[audio tone=dry]%%', '%%[audio tone=dry pause_after=900]%%'), GENERIC_PROFILE, { cast: castOf(), effects: EFFECTS });
    expect(p.segments[0]!.pause_after_ms).toBe(900);
  });

  it('keeps inline tone markers inside the span that contains them; leading tone on the first run only', () => {
    const r = compileRuns(
      'Šel jsem. „Nemám ve zvyku,“ řekl Bůh. „Ale tentokrát ano.“ Konec.',
      [{ tone: 'calm' }, { at: 'Nemám', until: 'zvyku', speaker: 'buh' }, { at: 'Ale tentokrát', speaker: 'buh', until: 'ano.' }, { at: 'tentokrát', tone: 'warm' }, { say: 'Bůh', as: 'Bůůh' }],
      [],
      { cast: castOf(), effects: EFFECTS }
    );
    expect(r.errors).toEqual([]);
    expect(r.runs.map((x) => [x.role, x.text])).toEqual([
      ['vypravec', '[calmly] Šel jsem.'],
      ['buh', '„Nemám ve zvyku,“'],
      ['vypravec', 'řekl Bůůh.'],
      ['buh', '„Ale [warmly] tentokrát ano.“'],
      ['vypravec', 'Konec.'],
    ]);
  });

  it('reports at/until not found, overlaps and unknown roles', () => {
    const ctx = { cast: castOf(), effects: EFFECTS };
    expect(compileRuns('a b c', [{ at: 'x', speaker: 'buh' }], [], ctx).errors).toEqual(['at="x" not found']);
    expect(compileRuns('a b c', [{ at: 'b', until: 'x', speaker: 'buh' }], [], ctx).errors).toEqual(['until="x" not found after at="b"']);
    expect(compileRuns('a b c d', [{ at: 'a', until: 'c', speaker: 'buh' }, { at: 'b', speaker: 'mannova' }], [], ctx).errors).toEqual([
      'spans overlap: at="a" and at="b"',
    ]);
    expect(compileRuns('a b', [{ at: 'b', speaker: 'pan' }], [], ctx).errors).toEqual(['unknown role pan']);
    expect(compileRuns('a b', [{ until: 'b' }], [], ctx).errors).toEqual(['until="b" without at']);
  });
});

describe('cast: fx', () => {
  const ctx = { cast: castOf(), effects: EFFECTS };
  const fx = (markers: Record<string, string>[], text = 'Ahoj světe. Píp píp. Konec.') =>
    compileRuns(text, [{ speaker: 'vzduch' }, ...markers], [], ctx).runs.map((r) => r.fx);

  it('resolves span fx > paragraph fx > role fx, none disables', () => {
    expect(fx([])).toEqual(['robot']);
    expect(fx([{ fx: 'telefon' }])).toEqual(['telefon']);
    expect(fx([{ fx: 'none' }])).toEqual([undefined]);
    expect(fx([{ at: 'Píp píp.', until: 'Píp píp.', fx: 'sakralni' }])).toEqual(['robot', 'sakralni', 'robot']);
    expect(fx([{ fx: 'telefon' }, { at: 'Píp píp.', until: 'Píp píp.', fx: 'none' }])).toEqual(['telefon', undefined, 'telefon']);
    // span with the same (role, fx) as its surroundings does not split
    expect(fx([{ at: 'Píp', fx: 'robot' }])).toEqual(['robot']);
  });

  it('unknown fx is an error (marker and role)', () => {
    expect(compileRuns('a b', [{ at: 'b', fx: 'echo' }], [], ctx).errors).toEqual(['unknown fx echo']);
    expect(compileRuns('a b', [{ fx: 'echo' }], [], ctx).errors).toEqual(['unknown fx echo']);
    const f = checkAudio(CAST_TMD, GENERIC_PROFILE, [], { cast: castOf(), effects: {} });
    expect(f).toContainEqual({ severity: 'error', message: 'cast: role vzduch: unknown fx robot' });
  });

  it('fx is not part of the hash', () => {
    const a = planAudio(CAST_TMD, GENERIC_PROFILE, { cast: castOf(), effects: EFFECTS });
    const b = planAudio(CAST_TMD, GENERIC_PROFILE, { cast: castOf(CAST_YAML.replace(', fx: robot', '')), effects: EFFECTS });
    expect(b.segments.map((s) => s.hash)).toEqual(a.segments.map((s) => s.hash));
    expect(b.segments[1]!.fx).toBeUndefined();
  });
});

describe('cast: plan v2', () => {
  it('has version 2, cast block, per-segment voice/stability; role stability changes the hash', () => {
    const a = planAudio(CAST_TMD, GENERIC_PROFILE, { cast: castOf(), effects: EFFECTS, stability: 0.4 });
    expect(a.version).toBe(2);
    expect(a.voice).toEqual({ key: 'tomas', id: VOICES.tomas.id, name: 'Tomas' });
    expect(a.cast!.labels).toBe('hide');
    expect(a.cast!.roles.vzduch).toEqual({ voice: { key: 'filip', id: VOICES.filip.id }, fx: 'robot' });
    expect(a.segments[0]!.stability).toBe(0.4);
    const b = planAudio(CAST_TMD, GENERIC_PROFILE, {
      cast: castOf(CAST_YAML.replace('vzduch: {voice: filip, fx: robot}', 'vzduch: {voice: filip, fx: robot, stability: 0.5}')),
      effects: EFFECTS,
      stability: 0.4,
    });
    const v = b.segments.findIndex((s) => s.role === 'vzduch');
    expect(b.segments[v]!.stability).toBe(0.5);
    expect(b.segments[v]!.hash).not.toBe(a.segments[v]!.hash);
    expect(b.segments[0]!.hash).toBe(a.segments[0]!.hash); // mannova unchanged
  });

  it('parseCast reports unknown voice keys and bad references', () => {
    const r = parseCast(CAST_YAML.replace('voice: adam', 'voice: nobody').replace('VZDUCH: vzduch', 'VZDUCH: vitr'), VOICES);
    expect(r.errors).toEqual(['cast: role buh: unknown voice key nobody', 'cast: labels_map VZDUCH → unknown role vitr']);
  });
});
