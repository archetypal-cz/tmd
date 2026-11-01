#!/usr/bin/env node
/**
 * tmd — CLI for Translation Markdown files.
 *
 *   tmd validate [--profile format-profile.yaml] <file|dir>...
 *   tmd project  [--profile format-profile.yaml] [--out FILE] [--heading TPL] <file>...
 *   tmd align    --original EN.md --translation CS.md --prefix 002 [--step N]
 *                [--frontmatter FILE] [--scene-break '* * *'] [--profile FILE] [--out FILE]
 *   tmd stamp    --prefix 002 [--step N] [--profile FILE] [--out FILE | --in-place] <file>
 *
 * `align` builds a TMD file from an original and an existing translation and
 * REFUSES to write it unless its projection equals the translation (§2.2);
 * stats go to stderr as JSON. `stamp` gives a translation-only file permanent
 * IDs and refuses files that already have them.
 *
 * `validate` exits non-zero on any error-severity finding (CI-friendly).
 * `project` concatenates the given files into publishable markdown on stdout
 * (or --out). --heading is a template applied per file with {field} placeholders
 * resolved from frontmatter, e.g. --heading "## {chapter}. {title_cz}".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GENERIC_PROFILE, parseProfile, type TmdProfile } from './profile.js';
import { projectMany } from './project.js';
import { validate } from './validate.js';
import { alignToTmd } from './align.js';
import { stamp } from './stamp.js';

function fail(msg: string): never {
  console.error(`tmd: ${msg}`);
  process.exit(2);
}

function loadProfile(profilePath: string | undefined, inputs: string[]): TmdProfile {
  if (profilePath) return parseProfile(fs.readFileSync(profilePath, 'utf-8'));
  // walk up from the first input looking for format-profile.yaml (§9: repo root)
  let dir = path.resolve(inputs[0] ?? '.');
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  for (; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'format-profile.yaml');
    if (fs.existsSync(candidate)) {
      console.error(`tmd: using profile ${candidate}`);
      return parseProfile(fs.readFileSync(candidate, 'utf-8'));
    }
    if (dir === path.dirname(dir)) break;
  }
  console.error('tmd: no format-profile.yaml found — using the permissive generic profile');
  return GENERIC_PROFILE;
}

function collectFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) fail(`no such file or directory: ${input}`);
    if (fs.statSync(input).isDirectory()) {
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d).sort()) {
          const p = path.join(d, entry);
          if (fs.statSync(p).isDirectory()) walk(p);
          else if (p.endsWith('.md')) files.push(p);
        }
      };
      walk(input);
    } else {
      files.push(input);
    }
  }
  return files;
}

interface Args {
  command: string;
  profile?: string;
  out?: string;
  heading?: string;
  original?: string;
  translation?: string;
  prefix?: string;
  step?: number;
  frontmatter?: string;
  sceneBreak?: string;
  inPlace?: boolean;
  inputs: string[];
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.error('usage: tmd <validate|project|align|stamp> [options] <file|dir>...  (see README)');
    process.exit(command ? 0 : 2);
  }
  const args: Args = { command, inputs: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--profile') args.profile = rest[++i] ?? fail('--profile needs a value');
    else if (a === '--out') args.out = rest[++i] ?? fail('--out needs a value');
    else if (a === '--heading') args.heading = rest[++i] ?? fail('--heading needs a value');
    else if (a === '--original') args.original = rest[++i] ?? fail('--original needs a value');
    else if (a === '--translation') args.translation = rest[++i] ?? fail('--translation needs a value');
    else if (a === '--prefix') args.prefix = rest[++i] ?? fail('--prefix needs a value');
    else if (a === '--step') args.step = Number(rest[++i] ?? fail('--step needs a value'));
    else if (a === '--frontmatter') args.frontmatter = rest[++i] ?? fail('--frontmatter needs a value');
    else if (a === '--scene-break') args.sceneBreak = rest[++i] ?? fail('--scene-break needs a value');
    else if (a === '--in-place') args.inPlace = true;
    else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else args.inputs.push(a);
  }
  if (args.command === 'align') {
    if (!args.original || !args.translation) fail('align needs --original and --translation');
    if (!args.prefix) fail('align needs --prefix');
  } else if (args.inputs.length === 0) fail('no input files');
  if (args.command === 'stamp' && !args.prefix) fail('stamp needs --prefix');
  if (args.step !== undefined && !(Number.isInteger(args.step) && args.step > 0)) fail('--step must be a positive integer');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const files = args.command === 'align' ? [] : collectFiles(args.inputs);
const profile = loadProfile(args.profile, args.command === 'align' ? [args.translation!] : args.inputs);

if (args.command === 'align') {
  const result = alignToTmd(fs.readFileSync(args.original!, 'utf-8'), fs.readFileSync(args.translation!, 'utf-8'), {
    idPrefix: args.prefix!,
    idStep: args.step,
    profile,
    sceneBreak: args.sceneBreak,
    frontmatter: args.frontmatter ? fs.readFileSync(args.frontmatter, 'utf-8') : undefined,
  });
  console.error(JSON.stringify({ projectionOk: result.projectionOk, ...result.stats }));
  if (!result.projectionOk) {
    const d = result.projectionDiff!;
    console.error(`tmd: projection != translation at paragraph ${d.index}\n  expected: ${d.expected.slice(0, 200)}\n  actual:   ${d.actual.slice(0, 200)}`);
    process.exit(1);
  }
  if (args.out) fs.writeFileSync(args.out, result.source);
  else process.stdout.write(result.source);
} else if (args.command === 'stamp') {
  if (files.length !== 1) fail('stamp takes exactly one file');
  const file = files[0]!;
  let result;
  try {
    result = stamp(fs.readFileSync(file, 'utf-8'), { idPrefix: args.prefix!, idStep: args.step, profile });
  } catch (e) {
    fail((e as Error).message);
  }
  console.error(`tmd: stamped ${result.stamped} paragraph(s)`);
  if (args.inPlace) fs.writeFileSync(file, result.source);
  else if (args.out) fs.writeFileSync(args.out, result.source);
  else process.stdout.write(result.source);
} else if (args.command === 'validate') {
  const result = validate(
    files.map((f) => ({ source: fs.readFileSync(f, 'utf-8'), file: f })),
    profile
  );
  for (const w of result.warnings) {
    const where = [w.file, w.line].filter(Boolean).join(':');
    console.log(`${w.severity.toUpperCase()} ${w.code} ${where ? `[${where}] ` : ''}${w.message}`);
  }
  const errors = result.warnings.filter((w) => w.severity === 'error').length;
  console.error(
    `tmd: ${files.length} file(s), ${result.warnings.length} finding(s), ${errors} error(s)`
  );
  process.exit(result.ok ? 0 : 1);
} else if (args.command === 'project') {
  const heading = args.heading
    ? (fm: Record<string, unknown>) =>
        args.heading!.replace(/\{(\w+)\}/g, (_, key: string) => String(fm[key] ?? ''))
    : undefined;
  const output = projectMany(
    files.map((f) => ({ source: fs.readFileSync(f, 'utf-8'), heading }))
  );
  if (args.out) fs.writeFileSync(args.out, output);
  else process.stdout.write(output);
} else {
  fail(`unknown command ${args.command}`);
}
