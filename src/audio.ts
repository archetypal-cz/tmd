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
 *   checkAudio(source, profile)          → findings (unknown keys/tones, `at` not unique…)
 *   planAudio(source, profile, options)  → AudioPlan (segments with engine text, pauses, hashes)
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
  'skip', 'read_as', 'note', 'at', 'none',
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

export interface AudioSegment {
  /** Paragraph ID, `#n` suffix when a long paragraph was split. */
  pid: string;
  speaker?: string;
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

export interface AudioPlanOptions {
  voice: { key: string; id: string; name?: string };
  model?: string;
  language?: string;
  stability?: number | null;
  lexicon?: LexiconEntry[];
  /** Segments longer than this are split at sentence ends. Default 2500. */
  maxSegmentChars?: number;
  /** Silence after a scene break, ms. Default 1500. */
  sceneBreakPauseMs?: number;
}

export interface AudioPlan {
  version: 1;
  work: Record<string, unknown>;
  voice: AudioPlanOptions['voice'];
  model: string;
  language: string;
  stability: number | null;
  segments: AudioSegment[];
  totals: { segments: number; directed: number; chars: number; tags: number; silence_ms: number };
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

/**
 * Compile one paragraph: projection → skip/read_as → inline `at` → say/as
 * (paragraph markers over the work lexicon) → leading tone/pace tag.
 */
export function compileParagraph(
  text: string,
  markers: AudioMarker[],
  lexicon: LexiconEntry[] = []
): { text: string; errors: string[]; pauseAfterMs: number; speaker?: string; directed: boolean } {
  const errors: string[] = [];
  let t = projectForListening(text);
  const para = markers.filter((m) => !('at' in m) && !('none' in m));
  const inline = markers.filter((m) => 'at' in m);
  const speaker = markers.find((m) => m.speaker)?.speaker;
  let pauseAfterMs = 0;
  for (const m of para) {
    if (m.pause_after) {
      const ms = Number(m.pause_after);
      if (!Number.isFinite(ms) || ms < 200 || ms > 3000) errors.push(`pause_after=${m.pause_after} out of 200-3000`);
      else pauseAfterMs = ms;
    }
  }
  const directed = markers.some((m) => Object.keys(m).some((k) => !['speaker', 'note', 'manner', 'none'].includes(k)));
  if (para.some((m) => m.skip === 'true')) return { text: '', errors, pauseAfterMs, speaker, directed };
  for (const m of para) if (m.read_as) t = m.read_as;

  const inserts: [number, string][] = [];
  for (const m of inline) {
    const at = projectForListening(m.at!);
    const count = at ? t.split(at).length - 1 : 0;
    if (count !== 1) {
      errors.push(`at="${m.at}" found ${count}x`);
      continue;
    }
    const start = t.indexOf(at);
    let end = start + at.length;
    while (end < t.length && '.,;:!?…“”"\'–—)'.includes(t[end]!)) end++;
    if (m.tone) {
      const tag = AUDIO_TONES[m.tone];
      if (tag) inserts.push([start, `${tag} `]);
      else errors.push(`unknown tone ${m.tone}`);
    }
    for (const [key, pos] of [['pause_before', start], ['pause_after', end]] as const) {
      if (!(key in m)) continue;
      const ms = Number(m[key]);
      if (!Number.isFinite(ms) || ms < 200 || ms > 3000) {
        errors.push(`${key}=${m[key]} out of 200-3000`);
        continue;
      }
      inserts.push([pos, `${key === 'pause_after' ? ' ' : ''}${pauseTag(ms)} `]);
    }
  }
  inserts.sort((a, b) => b[0] - a[0]);
  for (const [pos, s] of inserts) t = t.slice(0, pos) + s + t.slice(pos);

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
    if (!new RegExp(`(?<!\\p{L})${escapeRe(m.say)}`, 'u').test(t)) errors.push(`say="${m.say}" not in text`);
  }
  for (const [say, as] of [...subs].sort((a, b) => b[0].length - a[0].length)) {
    t = t.replace(new RegExp(`(?<!\\p{L})${escapeRe(say)}`, 'gu'), as);
  }

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
  if (lead.length) t = `${lead.join(' ')} ${t}`;
  return { text: t.replace(/[ \t]{2,}/g, ' ').trim(), errors, pauseAfterMs, speaker, directed };
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

/** Validate audio markers of a TMD file (no plan, no hashing). */
export function checkAudio(source: string, profile: TmdProfile, lexicon: LexiconEntry[] = []): AudioFinding[] {
  const findings: AudioFinding[] = [];
  const { paras } = collectParagraphs(source, profile);
  for (const p of paras) {
    for (const e of p.markerErrors) findings.push({ pid: p.pid, line: p.line, severity: 'error', message: e });
    const r = compileParagraph(p.text, p.markers, lexicon);
    for (const e of r.errors) findings.push({ pid: p.pid, line: p.line, severity: 'error', message: e });
    if (/\[[a-z][a-z ,]*\]\s*$/.test(r.text))
      findings.push({ pid: p.pid, line: p.line, severity: 'warning', message: 'paragraph ends with an engine tag - use a paragraph-level pause_after (player silence) instead' });
  }
  if (!paras.length) findings.push({ severity: 'warning', message: 'no paragraph clusters - stamp IDs first (tmd stamp)' });
  return findings;
}

/** Build the render plan for one TMD work. */
export function planAudio(source: string, profile: TmdProfile, options: AudioPlanOptions): AudioPlan {
  const model = options.model ?? 'eleven_v4';
  const language = options.language ?? 'cs';
  const stability = options.stability ?? null;
  const max = options.maxSegmentChars ?? 2500;
  const breakPause = options.sceneBreakPauseMs ?? 1500;
  const lexicon = options.lexicon ?? [];
  const { paras, breaksAfter, work } = collectParagraphs(source, profile);
  const findings = checkAudio(source, profile, lexicon);
  const segments: AudioSegment[] = [];
  for (const p of paras) {
    const r = compileParagraph(p.text, p.markers, lexicon);
    if (!r.text) continue; // skip=true
    const plain = projectForListening(p.text);
    const parts = splitSentences(r.text, max);
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      let pause = last ? r.pauseAfterMs : 0;
      if (last && breaksAfter.has(p.pid)) pause = Math.max(pause, breakPause);
      segments.push({
        pid: parts.length > 1 ? `${p.pid}#${i + 1}` : p.pid,
        speaker: r.speaker,
        text: part,
        plain: parts.length > 1 ? part.replace(/\[[a-z][a-z ,]*\]\s*/g, '') : plain,
        pause_after_ms: pause,
        chars: part.length,
        hash: segHash(model, options.voice.id, stability, part),
        directed: r.directed,
      });
    });
  }
  const tags = segments.reduce((a, s) => a + (s.text.match(/\[[a-z][a-z ,]*\]/g) ?? []).length, 0);
  return {
    version: 1,
    work,
    voice: options.voice,
    model,
    language,
    stability,
    segments,
    totals: {
      segments: segments.length,
      directed: new Set(segments.filter((s) => s.directed).map((s) => s.pid.split('#')[0])).size,
      chars: segments.reduce((a, s) => a + s.chars, 0),
      tags,
      silence_ms: segments.reduce((a, s) => a + s.pause_after_ms, 0),
    },
    findings,
  };
}
