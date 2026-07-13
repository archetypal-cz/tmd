#!/usr/bin/env node
/**
 * tmd — CLI for Translation Markdown files.
 *
 *   tmd validate [--profile format-profile.yaml] <file|dir>...
 *   tmd project  [--profile format-profile.yaml] [--out FILE] [--heading TPL] <file>...
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
  inputs: string[];
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.error('usage: tmd <validate|project> [--profile FILE] [--out FILE] [--heading TPL] <file|dir>...');
    process.exit(command ? 0 : 2);
  }
  const args: Args = { command, inputs: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--profile') args.profile = rest[++i] ?? fail('--profile needs a value');
    else if (a === '--out') args.out = rest[++i] ?? fail('--out needs a value');
    else if (a === '--heading') args.heading = rest[++i] ?? fail('--heading needs a value');
    else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else args.inputs.push(a);
  }
  if (args.inputs.length === 0) fail('no input files');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const files = collectFiles(args.inputs);
const profile = loadProfile(args.profile, args.inputs);

if (args.command === 'validate') {
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
