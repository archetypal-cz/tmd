# tmd — Translation Markdown

**Spec and reference library for bilingual `%% … %%` translation files.**

Translation Markdown (TMD) is a Markdown-based format for long-form literary
translation: one file holds the original and the translation side by side. The
original sits in Obsidian-style `%% … %%` comments, the translation is the
visible prose — open the file in Obsidian and you read the book; strip the
comments and you *publish* the book. Paragraph-level IDs keep the two texts
aligned forever; dated annotations record why a phrase was translated the way
it was.

Built and battle-tested by [Archetypal](https://archetypal.cz) on two real
projects: *Harry Potter a Metody Racionality* (English→Czech, ~150 chapters)
and the complete uncensored diary of
[Marie Bashkirtseff](https://github.com/archetypal-cz/bashkirtseff)
(French→Czech, 105 notebooks).

## The format in 20 lines

```markdown
---
chapter: "001"
title_en: "A Day of Very Low Probability"
title_cz: "Velmi nepravděpodobný den"
---

%% 001.0005 %%
%% Every inch of wall space is covered by a bookcase. … %%
Každý centimetr místa na stěně zabírají knihovny. …
%% 2015-12-05T12:36:20 Pavel: krásná věta %%

%% 001.0006 %%
%% ALIGN? no English counterpart %%
Tohle je odstavec, který v originále chybí.
```

- `%% 001.0005 %%` — a **stable paragraph ID**: never changes, never reused.
- The unprefixed comment is the **original**; the visible prose is the
  **translation**.
- `%% <timestamp> <author>: … %%` — a dated, attributed **annotation**.
- `%% ALIGN? … %%` — a **machine flag**: a work item for a human.
- Removing every comment leaves a valid CommonMark document containing exactly
  the translation — the **projection invariant**, and the whole point.

The full specification lives in [FORMAT.md](FORMAT.md) (this repo is its
canonical home). Book-specific parts — the paragraph-ID scheme, author
vocabulary, footnote scheme — are declared per book in a
[`format-profile.yaml`](profiles/) (§9 of the spec), so tools plug in a book's
schemes instead of hardcoding them.

## The library

```
npm install @archetypal-cz/tmd
```

```ts
import { parse, project, validate, parseProfile } from '@archetypal-cz/tmd';
import * as fs from 'node:fs';

const profile = parseProfile(fs.readFileSync('format-profile.yaml', 'utf-8'));
const source = fs.readFileSync('content/1/001.md', 'utf-8');

// clusters: ID + original + translation + annotations + flags
const doc = parse(source, profile);

// publishable markdown: comments stripped, blank runs collapsed
const published = project(source);

// CI lint: ID uniqueness, footnote integrity, projection invariant, …
const { ok, warnings } = validate([{ source, file: 'content/1/001.md' }], profile);
```

Multi-file publishing (chapters → volume) with per-chapter headings and
footnote renumbering:

```ts
import { projectMany } from '@archetypal-cz/tmd';

const book = projectMany(chapterSources.map((source) => ({
  source,
  heading: (fm) => `## ${Number(fm.chapter)}. ${fm.title_cz}`,
})));
```

### Astro / remark

```ts
// astro.config.mjs — comments never reach rendered HTML
import remarkTmd from '@archetypal-cz/tmd/remark';
export default defineConfig({ markdown: { remarkPlugins: [remarkTmd] } });
```

The plugin strips comments at the **raw source** layer before parsing (a
comment block can contain arbitrary markdown that would scatter across the
AST), then re-parses; documents without comments are left completely
untouched. Comments never reaching output is a *licensing* requirement, not
just cosmetics: the original text inside the comments is usually someone
else's copyrighted work.

### CLI

```
tmd validate content/            # CI-friendly; exits 1 on errors
tmd project --heading "## {chapter}. {title_cz}" content/1/*.md > book1.md
```

`tmd validate` finds real defects: reused paragraph IDs, footnotes referenced
but never defined, annotations glued to translation text, `%%` residue that
would leak into publication.

```
tmd align --original en.md --translation cs.md --prefix 002 --out content/002-x/x.md
tmd stamp --prefix 003 --in-place cs-only.md
```

`tmd align` turns an independently sourced original plus an existing
translation into a TMD file: paragraph alignment by dynamic programming
(1-1, 1-0, 0-1, 2-1, 1-2 on length ratio, numbers, names and paragraph shape),
uncertain spots marked `%% ALIGN? … %%` for a human. It **refuses to write**
unless projecting the result gives back exactly the translation (§2.2). An
original paragraph that would classify as something else under §4 (starts
with `[`, or `WORD?`) is guarded with an invisible U+2060 so it stays
original text. Library: `alignToTmd`, `alignParagraphs`, `splitParagraphs`.

`tmd stamp` gives a translation-only file permanent paragraph IDs (no
original needed) and refuses a file that already has IDs.

## Related

- [`tmd-vscode`](https://github.com/archetypal-cz/tmd-vscode) — syntax
  highlighting for TMD files in VS Code.
- [FORMAT.md](FORMAT.md) — the specification (normative core + per-book
  profiles).

## License

[AGPL-3.0-only](LICENSE) © Archetypal, z.s.
