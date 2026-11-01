/**
 * Audio direction — the `%%[audio …]%%` marker layer (Archetypal skill
 * `audio-direction`) compiled into a render plan for a TTS engine.
 *
 * Markers are whole-line tag annotations (§4 type 6) inside a cluster, so the
 * projection never sees them. This module is the ONE implementation of the
 * marker vocabulary and its compilation (the Windmill renderer only consumes
 * the plan). Vocabulary and compile order mirror the skill's
 * `references/vocabulary.md` — change both together.
 *
 *   checkAudio(source, profile, lexicon, {cast, effects}) → findings (unknown keys/tones/roles/fx…)
 *   planAudio(source, profile, options)  → AudioPlan (segments with engine text, pauses, hashes)
 *
 * Radio play ("cast mode", only when a cast is passed — `audio/cast.yaml` in the work):
 * roles → voices, speaker from the `**NAME:**` label, hidden labels, mid-paragraph speaker/fx
 * spans (`at` … `until`), turn pauses, fx presets (`audio/effects.yaml`) → plan `version: 2`.
 * Without a cast the output is exactly the single-voice plan `version: 1`.
 */
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { parse } from './parse.js';
import type { TmdProfile } from './profile.js';

/** Our tones → ElevenLabs eleven_v4 inline tags (vocabulary.md). */
export const AUDIO_TONES: Record<string, string> = {
  calm: '[calmly]',
  warm: '[warmly]',
  reassuring: '[reassuring]',
  tender: '[softly]',
  dry: '[dryly]',
  ironic: '[sarcastically]',
  amused: '[amused]',
  amazed: '[amazed]',
  sad: '[sadly]',
  solemn: '[solemnly]',
  tense: '[tense]',
  fearful: '[nervously]',
  hesitant: '[hesitantly]',
  excited: '[excited]',
  angry: '[angrily]',
  furious: '[angrily]', // 2026-11-01: [shouting] was too much (Kerray)
  cold: '[coldly]',
  knowing: '[knowingly]',
  guarded: '[guardedly]',
  feigned: '[with feigned sincerity]',
  wry: '[wryly]',
  mysterious: '[mysteriously]',
  whisper: '[whispers]',
  announcer: '[announcer voice]',
  breaking: '[voice breaking]',
  sigh: '[sighs]',
  laugh: '[laughs]',
};
export const AUDIO_PACES: Record<string, string> = { slow: '[slowly]', fast: '[quickly]' };
const KEYS = new Set([
  'speaker', 'tone', 'manner', 'pause_before', 'pause_after', 'pace', 'say', 'as',
  'skip', 'read_as', 'note', 'at', 'none', 'fx', 'until',
]);

export type AudioMarker = Record<string, string>;

export interface LexiconEntry {
  say: string;
  as: string;
  note?: string;
}

export interface AudioFinding {
  pid?: string;
  line?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface AudioVoiceRef {
  key: string;
  id: string;
  name?: string;
}

export interface AudioSegment {
  /** Paragraph ID, `#n` suffix when a paragraph was split (long paragraph and/or speaker/fx change). */
  pid: string;
  speaker?: string;
  /** v2 (cast): role of this segment (same as `speaker`). */
  role?: string;
  /** v2 (cast): voice of the role. */
  voice?: { key: string; id: string };
  /** v2 (cast): role stability override, else the plan default. */
  stability?: number | null;
  /** v2 (cast): resolved fx preset name (span > paragraph > role); absent = none. Not in `hash`. */
  fx?: string;
  /** Text sent to the engine (tags + pronunciation substitutions). */
  text: string;
  /** Listening projection without direction (for request stitching / previews). */
  plain: string;
  /** Silence the player inserts after this segment, ms. */
  pause_after_ms: number;
  chars: number;
  /** sha256(model|voice|stability|text)[:16] — the render cache key. */
  hash: string;
  directed: boolean;
}

export interface CastRole {
  voice: AudioVoiceRef;
  fx?: string;
  stability?: number;
}

/** Parsed `audio/cast.yaml` with voice keys resolved against the voice catalog. */
export interface AudioCast {
  labels: 'hide' | 'read';
  turn_pause_ms: number;
  default_role: string;
  labels_map: Record<string, string>;
  roles: Record<string, CastRole>;
}

export interface FxPreset {
  desc?: string;
  ffmpeg: string;
}

/** `voices:` of `audio/voices.yaml`. */
export type VoiceCatalog = Record<string, { id: string; name?: string }>;

export interface AudioCastOptions {
  cast?: AudioCast;
  /** Merged presets (shared `audio/effects.yaml` overlaid by the work's own). */
  effects?: Record<string, FxPreset>;
}

export interface AudioPlanOptions extends AudioCastOptions {
  /** Single voice; with a cast it defaults to the default_role's voice. */
  voice?: AudioVoiceRef;
  model?: string;
  language?: string;
  stability?: number | null;
  lexicon?: LexiconEntry[];
  /** Segments longer than this are split at sentence ends. Default 2500. */
  maxSegmentChars?: number;
  /** Silence after a scene break, ms. Default 1500. */
  sceneBreakPauseMs?: number;
}

export interface AudioPlanCast {
  labels: 'hide' | 'read';
  turn_pause_ms: number;
  roles: Record<string, CastRole>;
}

export interface AudioPlan {
  version: 1 | 2;
  work: Record<string, unknown>;
  voice: AudioVoiceRef;
  model: string;
  language: string;
  stability: number | null;
  /** v2 only. */
  cast?: AudioPlanCast;
  /** v2 only: presets actually used by segments. */
  fx?: Record<string, FxPreset>;
  segments: AudioSegment[];
  totals: {
    segments: number;
    directed: number;
    chars: number;
    tags: number;
    silence_ms: number;
    /** v2 only: chars per role. */
    roles?: Record<string, number>;
  };
  findings: AudioFinding[];
}

// ---- listening projection ------------------------------------------------------------

/** Markdown → text a listener should hear: links/footnotes/URLs/emphasis gone. */
export function projectForListening(text: string): string {
  let t = text.replace(/\[\^[^\]]+\]/g, '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, '');
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');
  t = t.replace(/(?<![\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])/gu, '$1');
  t = t.replace(/\*/g, '').replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
  // Literal brackets in the WORK's text would be taken by ElevenLabs v3/v4 as audio tags
  // ("[Pozn. překl.: …]" performed instead of read). Engine tags are inserted after projection.
  t = t.replace(/\[/g, '(').replace(/\]/g, ')');
  return t.replace(/[ \t]+/g, ' ').trim();
}

// ---- markers ---------------------------------------------------------------------------

const MARKER = /^\[audio(?:\s+(.*?))?\]$/s;
const ATTR = /(\w+)(?:=(?:"([^"]*)"|(\S+)))?/g;

/** Parse the content of one `%%[audio …]%%` comment (delimiters removed). Null when not an audio marker. */
export function parseMarker(content: string): { marker: AudioMarker; errors: string[] } | null {
  const m = content.trim().match(MARKER);
  if (!m) return null;
  const marker: AudioMarker = {};
  const errors: string[] = [];
  for (const a of (m[1] ?? '').matchAll(ATTR)) {
    const key = a[1]!;
    const value = a[2] ?? a[3] ?? 'true';
    if (!KEYS.has(key)) errors.push(`unknown key ${key}`);
    else marker[key] = value;
  }
  return { marker, errors };
}

function pauseTag(ms: number): string {
  if (ms < 600) return '[short pause]';
  if (ms <= 1500) return '[pause]';
  return '[long pause]';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `**NAME:**` or `**NAME**:` at the start of a paragraph's translation. */
const LABEL = /^\s*\*\*([^*:\n]{1,40}?)(?::\*\*|\*\*:)[ \t]*/u;
const OPENING = '„‚«»"\'‘“(';
const CLOSING = '.,;:!?…“”"\'–—)';
const TAG_RE = /\[[a-z][a-z ,]*\]/g;
const isSpanMarker = (m: AudioMarker) => 'speaker' in m || 'fx' in m || 'until' in m;

/** One contiguous stretch of a paragraph with one (role, fx): the unit of a segment. */
export interface AudioRun {
  role?: string;
  fx?: string;
  /** Engine text (tags + substitutions). */
  text: string;
  /** Plain listening text of this run (the label kept on the first run). */
  plain: string;
  /** Label prefix for `plain` when the label is hidden from `text` (first run only). */
  labelPlain?: string;
}

export interface CompiledParagraph {
  runs: AudioRun[];
  errors: string[];
  warnings: string[];
  pauseAfterMs: number;
  speaker?: string;
  label?: string;
  directed: boolean;
}

/**
 * Compile one paragraph into runs: label → projection → skip/read_as → spans (cast) →
 * inline `at` → say/as (paragraph markers over the work lexicon) → leading tone/pace tag
 * on the first run. Without a cast there is exactly one run (or none when skipped).
 */
export function compileRuns(
  text: string,
  markers: AudioMarker[],
  lexicon: LexiconEntry[] = [],
  ctx: AudioCastOptions = {}
): CompiledParagraph {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cast = ctx.cast;
  const effects = ctx.effects ?? {};
  const para = markers.filter((m) => !('at' in m) && !('none' in m));
  const inline = markers.filter((m) => 'at' in m);
  for (const m of markers) if ('until' in m && !('at' in m)) errors.push(`until="${m.until}" without at`);

  // label + speaker
  let label: string | undefined;
  let labelPlain: string | undefined;
  let body = text;
  let speaker: string | undefined;
  if (!cast) {
    speaker = markers.find((m) => m.speaker)?.speaker;
    if (inline.some(isSpanMarker) || para.some((m) => 'fx' in m))
      warnings.push('speaker/fx spans and fx are ignored without a cast (audio/cast.yaml)');
  } else {
    const lm = text.match(LABEL);
    if (lm) {
      const name = lm[1]!.trim();
      // A bold lead-in is a label when the cast knows it, or when it is all caps (ZEMĚ:).
      if (name in cast.labels_map || !/\p{Ll}/u.test(name)) {
        label = name;
        if (cast.labels === 'hide') {
          body = text.slice(lm[0].length);
          labelPlain = projectForListening(lm[0]);
        }
      }
    }
    speaker = para.find((m) => m.speaker)?.speaker;
    if (!speaker && label) {
      speaker = cast.labels_map[label];
      if (!speaker) errors.push(`unknown label ${label} (not in cast labels_map)`);
    }
    speaker ??= cast.default_role;
    if (!(speaker in cast.roles)) errors.push(`unknown role ${speaker}`);
  }

  let pauseAfterMs = 0;
  for (const m of para) {
    if (m.pause_after) {
      const ms = Number(m.pause_after);
      if (!Number.isFinite(ms) || ms < 200 || ms > 3000) errors.push(`pause_after=${m.pause_after} out of 200-3000`);
      else pauseAfterMs = ms;
    }
  }
  const directed = markers.some((m) => Object.keys(m).some((k) => !['speaker', 'note', 'manner', 'none'].includes(k)));
  const done = (runs: AudioRun[]): CompiledParagraph => ({ runs, errors, warnings, pauseAfterMs, speaker, label, directed });
  if (para.some((m) => m.skip === 'true')) return done([]);
  let t = projectForListening(body);
  for (const m of para) if (m.read_as) t = m.read_as;

  // ---- spans (cast only): [start, end) with their own role/fx
  const paraFx = para.find((m) => m.fx)?.fx;
  if (cast && paraFx && paraFx !== 'none' && !(paraFx in effects)) errors.push(`unknown fx ${paraFx}`);
  const fxFor = (role: string | undefined, spanFx?: string) => {
    const f = spanFx ?? paraFx ?? (role ? cast?.roles[role]?.fx : undefined);
    return f && f !== 'none' ? f : undefined;
  };
  interface Span { start: number; end: number; role?: string; fx?: string; at: string }
  const spanAt = new Map<AudioMarker, number>();
  let spans: Span[] = [];
  if (cast) {
    for (const m of inline) {
      if (!isSpanMarker(m)) continue;
      const at = projectForListening(m.at!);
      const idx = at ? t.indexOf(at) : -1;
      if (idx < 0) {
        errors.push(`at="${m.at}" not found`);
        continue;
      }
      spanAt.set(m, idx);
      let start = idx;
      while (start > 0 && OPENING.includes(t[start - 1]!)) start--;
      let end = t.length;
      if (m.until) {
        const u = projectForListening(m.until);
        const j = u ? t.indexOf(u, idx) : -1;
        if (j < 0) {
          errors.push(`until="${m.until}" not found after at="${m.at}"`);
          continue;
        }
        end = j + u.length;
        while (end < t.length && CLOSING.includes(t[end]!)) end++;
      }
      if (m.speaker && !(m.speaker in cast.roles)) errors.push(`unknown role ${m.speaker}`);
      if (m.fx && m.fx !== 'none' && !(m.fx in effects)) errors.push(`unknown fx ${m.fx}`);
      spans.push({ start, end, role: m.speaker ?? speaker, fx: m.fx, at: m.at! });
    }
    spans.sort((a, b) => a.start - b.start);
    const kept: Span[] = [];
    for (const s of spans) {
      const prev = kept[kept.length - 1];
      if (prev && s.start < prev.end) errors.push(`spans overlap: at="${prev.at}" and at="${s.at}"`);
      else kept.push(s);
    }
    spans = kept;
  }

  // pieces of the paragraph, adjacent equal (role, fx) merged
  type Piece = { s: number; e: number; role?: string; fx?: string };
  const raw: Piece[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start > cursor) raw.push({ s: cursor, e: s.start, role: speaker, fx: fxFor(speaker) });
    raw.push({ s: s.start, e: s.end, role: s.role, fx: fxFor(s.role, s.fx) });
    cursor = s.end;
  }
  if (cursor < t.length || !raw.length) raw.push({ s: cursor, e: t.length, role: speaker, fx: cast ? fxFor(speaker) : undefined });
  const pieces: Piece[] = [];
  for (const p of raw) {
    const prev = pieces[pieces.length - 1];
    if (prev && prev.role === p.role && prev.fx === p.fx) prev.e = p.e;
    else pieces.push({ ...p });
  }

  // ---- inline tone/pause inserts (positions in t)
  const inserts: [number, string, 'before' | 'after'][] = [];
  for (const m of inline) {
    const at = projectForListening(m.at!);
    let start: number;
    if (cast && isSpanMarker(m)) {
      if (!spanAt.has(m)) continue; // error already reported
      start = spanAt.get(m)!;
    } else {
      const count = at ? t.split(at).length - 1 : 0;
      if (count !== 1) {
        errors.push(`at="${m.at}" found ${count}x`);
        continue;
      }
      start = t.indexOf(at);
    }
    let end = start + at.length;
    while (end < t.length && CLOSING.includes(t[end]!)) end++;
    if (m.tone) {
      const tag = AUDIO_TONES[m.tone];
      if (tag) inserts.push([start, `${tag} `, 'before']);
      else errors.push(`unknown tone ${m.tone}`);
    }
    for (const [key, pos] of [['pause_before', start], ['pause_after', end]] as const) {
      if (!(key in m)) continue;
      const ms = Number(m[key]);
      if (!Number.isFinite(ms) || ms < 200 || ms > 3000) {
        errors.push(`${key}=${m[key]} out of 200-3000`);
        continue;
      }
      inserts.push([pos, `${key === 'pause_after' ? ' ' : ''}${pauseTag(ms)} `, key === 'pause_after' ? 'after' : 'before']);
    }
  }
  inserts.sort((a, b) => b[0] - a[0]);
  const applyInserts = (s: string, offset: number, list: typeof inserts) => {
    for (const [pos, ins] of list) s = s.slice(0, pos - offset) + ins + s.slice(pos - offset);
    return s;
  };
  const pieceOf = (pos: number, kind: 'before' | 'after') => {
    const i = pieces.findIndex((p) => (kind === 'before' ? p.s <= pos && pos < p.e : p.s < pos && pos <= p.e));
    return i >= 0 ? i : kind === 'before' ? pieces.length - 1 : 0;
  };
  const full = applyInserts(t, 0, inserts);

  // pronunciation: paragraph `say` beats the work lexicon for the same `say`
  const subs = new Map<string, string>();
  for (const e of lexicon) subs.set(e.say, e.as);
  for (const m of para) {
    if (!m.say) continue;
    if (!m.as) {
      errors.push(`say="${m.say}" without as`);
      continue;
    }
    subs.set(m.say, m.as);
    if (!new RegExp(`(?<!\\p{L})${escapeRe(m.say)}`, 'u').test(full)) errors.push(`say="${m.say}" not in text`);
  }
  const substitute = (s: string) => {
    for (const [say, as] of [...subs].sort((a, b) => b[0].length - a[0].length))
      s = s.replace(new RegExp(`(?<!\\p{L})${escapeRe(say)}`, 'gu'), as);
    return s;
  };

  const lead: string[] = [];
  for (const m of para) {
    if (m.tone) {
      if (AUDIO_TONES[m.tone]) lead.push(AUDIO_TONES[m.tone]!);
      else errors.push(`unknown tone ${m.tone}`);
    }
    if (m.pace) {
      if (AUDIO_PACES[m.pace]) lead.push(AUDIO_PACES[m.pace]!);
      else errors.push(`unknown pace ${m.pace}`);
    }
  }

  const runs: AudioRun[] = [];
  pieces.forEach((p, i) => {
    let s = applyInserts(t.slice(p.s, p.e), p.s, inserts.filter(([pos, , kind]) => pieceOf(pos, kind) === i));
    s = substitute(s);
    // a piece of only punctuation/whitespace between two spans is not worth a segment
    if (pieces.length > 1 && !/[\p{L}\p{N}]/u.test(s.replace(TAG_RE, ''))) return;
    if (!runs.length && lead.length) s = `${lead.join(' ')} ${s}`;
    const first = !runs.length;
    const piecePlain = t.slice(p.s, p.e).replace(/[ \t]+/g, ' ').trim();
    runs.push({
      role: p.role,
      fx: p.fx,
      text: s.replace(/[ \t]{2,}/g, ' ').trim(),
      plain: pieces.length === 1
        ? projectForListening(text)
        : first && labelPlain ? `${labelPlain} ${piecePlain}` : piecePlain,
      labelPlain: first ? labelPlain : undefined,
    });
  });
  return done(runs);
}

/**
 * Compile one paragraph without a cast (single voice): the engine text of the whole
 * paragraph ('' when skipped). Kept for compatibility; see `compileRuns`.
 */
export function compileParagraph(
  text: string,
  markers: AudioMarker[],
  lexicon: LexiconEntry[] = []
): { text: string; errors: string[]; pauseAfterMs: number; speaker?: string; directed: boolean } {
  const r = compileRuns(text, markers, lexicon);
  return { text: r.runs[0]?.text ?? '', errors: r.errors, pauseAfterMs: r.pauseAfterMs, speaker: r.speaker, directed: r.directed };
}

// ---- cast + effects -----------------------------------------------------------------------

/** Parse `audio/cast.yaml`, resolving voice keys against the `voices:` catalog of voices.yaml. */
export function parseCast(yamlSource: string, voices: VoiceCatalog): { cast?: AudioCast; errors: string[] } {
  const errors: string[] = [];
  const raw = parseYaml(yamlSource) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return { errors: ['cast: not a YAML mapping'] };
  if (raw.version !== undefined && raw.version !== 1) errors.push(`cast: unsupported version ${String(raw.version)}`);
  const labels = (raw.labels ?? 'hide') as string;
  if (labels !== 'hide' && labels !== 'read') errors.push(`cast: labels must be hide or read, not ${labels}`);
  const turn = raw.turn_pause_ms ?? 250;
  if (typeof turn !== 'number' || !(turn >= 0 && turn <= 3000)) errors.push(`cast: turn_pause_ms=${String(turn)} out of 0-3000`);
  const roles: Record<string, CastRole> = {};
  const rawRoles = (raw.roles ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const [name, r] of Object.entries(rawRoles)) {
    const key = r?.voice;
    if (typeof key !== 'string') {
      errors.push(`cast: role ${name} has no voice`);
      continue;
    }
    const v = voices[key];
    if (!v) errors.push(`cast: role ${name}: unknown voice key ${key}`);
    const role: CastRole = { voice: { key, id: v?.id ?? '', ...(v?.name ? { name: v.name } : {}) } };
    if (r!.fx !== undefined) role.fx = String(r!.fx);
    if (r!.stability !== undefined && r!.stability !== null) {
      const s = r!.stability;
      if (typeof s !== 'number' || s < 0 || s > 1) errors.push(`cast: role ${name}: stability ${String(s)} out of 0-1`);
      else role.stability = s;
    }
    roles[name] = role;
  }
  if (!Object.keys(rawRoles).length) errors.push('cast: no roles');
  const defaultRole = raw.default_role as string | undefined;
  if (!defaultRole) errors.push('cast: default_role missing');
  else if (!(defaultRole in rawRoles)) errors.push(`cast: default_role ${defaultRole} is not a role`);
  const labelsMap = (raw.labels_map ?? {}) as Record<string, string>;
  for (const [l, role] of Object.entries(labelsMap))
    if (!(role in rawRoles)) errors.push(`cast: labels_map ${l} → unknown role ${role}`);
  return {
    cast: {
      labels: labels === 'read' ? 'read' : 'hide',
      turn_pause_ms: typeof turn === 'number' ? turn : 250,
      default_role: defaultRole ?? '',
      labels_map: labelsMap,
      roles,
    },
    errors,
  };
}

/** Parse an `audio/effects.yaml`; merge several with `{...shared, ...work}`. */
export function parseEffects(yamlSource: string): { presets: Record<string, FxPreset>; errors: string[] } {
  const errors: string[] = [];
  const raw = parseYaml(yamlSource) as { version?: number; presets?: Record<string, Partial<FxPreset> | null> } | null;
  const presets: Record<string, FxPreset> = {};
  if (raw?.version !== undefined && raw.version !== 1) errors.push(`effects: unsupported version ${raw.version}`);
  for (const [name, p] of Object.entries(raw?.presets ?? {})) {
    if (name === 'none') errors.push('effects: preset name none is reserved');
    else if (!p || typeof p.ffmpeg !== 'string' || !p.ffmpeg) errors.push(`effects: preset ${name} has no ffmpeg chain`);
    else presets[name] = { ...(p.desc ? { desc: String(p.desc) } : {}), ffmpeg: p.ffmpeg };
  }
  return { presets, errors };
}

/** Parse `audio/lexicon.yaml`. */
export function parseLexicon(yamlSource: string): LexiconEntry[] {
  const raw = parseYaml(yamlSource) as { entries?: LexiconEntry[] } | null;
  return (raw?.entries ?? []).filter((e) => e && e.say && e.as);
}

/** Split text at sentence ends into chunks of at most `max` chars (a single over-long sentence stays whole). */
export function splitSentences(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+[“”"']?|$)\s*/gu) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > max) {
      out.push(cur.trim());
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const segHash = (model: string, voice: string, stability: number | null, text: string) =>
  createHash('sha256').update(`${model}|${voice}|${stability ?? ''}|${text}`).digest('hex').slice(0, 16);

interface ParaInput {
  pid: string;
  text: string;
  markers: AudioMarker[];
  markerErrors: string[];
  line: number;
}

function collectParagraphs(source: string, profile: TmdProfile): { paras: ParaInput[]; breaksAfter: Set<string>; work: Record<string, unknown> } {
  const doc = parse(source, profile);
  const paras: ParaInput[] = doc.clusters.map((c) => {
    const markers: AudioMarker[] = [];
    const markerErrors: string[] = [];
    for (const oc of c.otherComments) {
      const p = parseMarker(oc.content);
      if (!p) continue;
      markers.push(p.marker);
      markerErrors.push(...p.errors);
    }
    return { pid: c.id, text: c.translation.join(' ').trim(), markers, markerErrors, line: c.line };
  });
  // scene breaks standing between clusters → silence after the previous paragraph
  const breaksAfter = new Set<string>();
  for (const s of doc.standalone) {
    if (!s.lines.some((l) => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(l))) continue;
    const prev = [...doc.clusters].reverse().find((c) => c.line < s.line);
    if (prev) breaksAfter.add(prev.id);
  }
  return { paras, breaksAfter, work: doc.frontmatter };
}

/** Validate audio markers of a TMD file (no plan, no hashing). With a cast also roles, labels and fx. */
export function checkAudio(
  source: string,
  profile: TmdProfile,
  lexicon: LexiconEntry[] = [],
  ctx: AudioCastOptions = {}
): AudioFinding[] {
  const findings: AudioFinding[] = [];
  const { paras } = collectParagraphs(source, profile);
  const labelsSeen = new Set<string>();
  for (const p of paras) {
    for (const e of p.markerErrors) findings.push({ pid: p.pid, line: p.line, severity: 'error', message: e });
    const r = compileRuns(p.text, p.markers, lexicon, ctx);
    if (r.label) labelsSeen.add(r.label);
    for (const e of r.errors) findings.push({ pid: p.pid, line: p.line, severity: 'error', message: e });
    for (const w of r.warnings) findings.push({ pid: p.pid, line: p.line, severity: 'warning', message: w });
    if (r.runs.some((run) => /\[[a-z][a-z ,]*\]\s*$/.test(run.text)))
      findings.push({ pid: p.pid, line: p.line, severity: 'warning', message: 'paragraph ends with an engine tag - use a paragraph-level pause_after (player silence) instead' });
  }
  if (!paras.length) findings.push({ severity: 'warning', message: 'no paragraph clusters - stamp IDs first (tmd stamp)' });
  const cast = ctx.cast;
  if (cast) {
    const effects = ctx.effects ?? {};
    for (const [name, role] of Object.entries(cast.roles))
      if (role.fx && role.fx !== 'none' && !(role.fx in effects))
        findings.push({ severity: 'error', message: `cast: role ${name}: unknown fx ${role.fx}` });
    if (cast.labels === 'hide') {
      const labels = new Set([...Object.keys(cast.labels_map), ...labelsSeen]);
      for (const e of lexicon) {
        const m = e.say.trim().match(/^(.+?)\s*:$/);
        if (m && labels.has(m[1]!.trim()))
          findings.push({ severity: 'warning', message: `lexicon say="${e.say}" is pointless with labels: hide (the label is not read)` });
      }
    }
  }
  return findings;
}

/** Build the render plan for one TMD work (v1 single voice; v2 with a cast). */
export function planAudio(source: string, profile: TmdProfile, options: AudioPlanOptions): AudioPlan {
  const model = options.model ?? 'eleven_v4';
  const language = options.language ?? 'cs';
  const stability = options.stability ?? null;
  const max = options.maxSegmentChars ?? 2500;
  const breakPause = options.sceneBreakPauseMs ?? 1500;
  const lexicon = options.lexicon ?? [];
  const cast = options.cast;
  const ctx: AudioCastOptions = { cast, effects: options.effects };
  const voice = options.voice && !cast ? options.voice : cast?.roles[cast.default_role]?.voice ?? options.voice;
  if (!voice) throw new Error('planAudio: no voice (pass voice, or a cast with a default_role)');
  const { paras, breaksAfter, work } = collectParagraphs(source, profile);
  const findings = checkAudio(source, profile, lexicon, ctx);
  const segments: AudioSegment[] = [];
  for (const p of paras) {
    const r = compileRuns(p.text, p.markers, lexicon, ctx);
    if (!r.runs.length || !r.runs.some((run) => run.text)) continue; // skip=true
    const parts = r.runs.flatMap((run) => {
      const ps = splitSentences(run.text, max);
      return ps.map((part, i) => ({
        run,
        part,
        plain: ps.length > 1
          ? `${i === 0 && run.labelPlain ? `${run.labelPlain} ` : ''}${part.replace(/\[[a-z][a-z ,]*\]\s*/g, '')}`
          : run.plain,
      }));
    });
    parts.forEach(({ run, part, plain }, i) => {
      const last = i === parts.length - 1;
      let pause = last ? r.pauseAfterMs : 0;
      if (last && breaksAfter.has(p.pid)) pause = Math.max(pause, breakPause);
      const pid = parts.length > 1 ? `${p.pid}#${i + 1}` : p.pid;
      if (!cast) {
        segments.push({
          pid,
          speaker: r.speaker,
          text: part,
          plain,
          pause_after_ms: pause,
          chars: part.length,
          hash: segHash(model, voice.id, stability, part),
          directed: r.directed,
        });
        return;
      }
      const role = cast.roles[run.role!];
      const segVoice = role?.voice ?? voice;
      const segStability = role?.stability ?? stability;
      segments.push({
        pid,
        speaker: run.role,
        role: run.role,
        voice: { key: segVoice.key, id: segVoice.id },
        stability: segStability,
        ...(run.fx ? { fx: run.fx } : {}),
        text: part,
        plain,
        pause_after_ms: pause,
        chars: part.length,
        hash: segHash(model, segVoice.id, segStability, part),
        directed: r.directed,
      });
    });
  }
  if (cast) {
    segments.forEach((s, i) => {
      const next = segments[i + 1];
      if (next && next.role !== s.role && s.pause_after_ms === 0) s.pause_after_ms = cast.turn_pause_ms;
    });
  }
  const tags = segments.reduce((a, s) => a + (s.text.match(/\[[a-z][a-z ,]*\]/g) ?? []).length, 0);
  const totals: AudioPlan['totals'] = {
    segments: segments.length,
    directed: new Set(segments.filter((s) => s.directed).map((s) => s.pid.split('#')[0])).size,
    chars: segments.reduce((a, s) => a + s.chars, 0),
    tags,
    silence_ms: segments.reduce((a, s) => a + s.pause_after_ms, 0),
  };
  if (!cast) return { version: 1, work, voice, model, language, stability, segments, totals, findings };
  const roleChars: Record<string, number> = {};
  for (const s of segments) roleChars[s.role!] = (roleChars[s.role!] ?? 0) + s.chars;
  const usedFx: Record<string, FxPreset> = {};
  for (const s of segments) if (s.fx && options.effects?.[s.fx]) usedFx[s.fx] = options.effects[s.fx]!;
  return {
    version: 2,
    work,
    voice,
    model,
    language,
    stability,
    cast: { labels: cast.labels, turn_pause_ms: cast.turn_pause_ms, roles: cast.roles },
    fx: usedFx,
    segments,
    totals: { ...totals, roles: roleChars },
    findings,
  };
}
