/**
 * Raw-layer `%% … %%` comment stripper — the baseline projection primitive
 * (FORMAT.md §2.2, §8): drop every comment, get the translation as valid
 * CommonMark.
 *
 * This operates on the RAW markdown string BEFORE any markdown parser sees it.
 * That is the safe layer: a `%%` block can be long, multi-line, and contain
 * arbitrary markdown/HTML/quotes/`%` that would otherwise be parsed into
 * emphasis / blockquotes / headings / lists / raw HTML nodes scattered across
 * the AST — impossible to strip reliably after parsing. Stripping the source
 * removes the whole region atomically. Nothing in a comment may EVER reach
 * rendered output: it is translator working material and licensed source text.
 *
 * Rules:
 *  - Inline comment mid-line: `text %%c%% more` → `text more` (surrounding
 *    whitespace collapsed to a single space; no space invented where there was
 *    none: `a%%c%%b` → `ab`).
 *  - Whole-line comment: the entire line is removed including its newline, so
 *    no blank line is left to split the surrounding paragraph.
 *  - Multi-line block comment: removed atomically.
 *  - Closing delimiter is the NEAREST following `%%`.
 *  - Unterminated `%%`: fail safe — strip to end of document rather than risk
 *    rendering the note.
 *  - Code is verbatim: `%%` inside fenced code blocks and inline code spans is
 *    NOT treated as a comment.
 *
 * (Lifted from archetypal-web `src/utils/strip-comments.ts`, the projection
 * stripper written against real HPaMR/Bashkirtseff content.)
 */
export function stripComments(input: string): string {
  const src = input.replace(/\r\n?/g, '\n'); // normalize newlines for scanning
  const n = src.length;
  const out: string[] = []; // committed, completed lines (each followed by its newline)
  let line = ''; // current line buffer (visible text + inline-code spans)
  let lineHadComment = false; // a comment was removed on this line
  let lineHasCode = false; // an inline-code span contributed content to this line
  let atLineStart = true;
  let i = 0;

  const flushLine = (newline: string) => {
    // A line that became whitespace-only *because* a comment was removed from it
    // is dropped entirely (newline included). Lines that only ever held
    // whitespace, or that still hold real text / code, are kept as-is.
    if (lineHadComment && !lineHasCode && line.trim() === '') {
      // drop the line and swallow its newline
    } else {
      // A comment removed from the end of a line can leave trailing whitespace;
      // trim it (only on comment-affected lines, so legitimate content — incl.
      // hard-break trailing spaces — is kept).
      out.push(lineHadComment ? line.replace(/[ \t]+$/, '') : line, newline);
    }
    line = '';
    lineHadComment = false;
    lineHasCode = false;
  };

  const fenceOpenRe = /^[ \t]{0,3}(`{3,}|~{3,})/;

  while (i < n) {
    if (atLineStart) {
      let le = src.indexOf('\n', i);
      if (le === -1) le = n;
      const cur = src.slice(i, le);
      const fm = fenceOpenRe.exec(cur);
      if (fm) {
        // Fenced code block: emit everything verbatim until the matching fence.
        const marker = fm[1]![0]!;
        const markerLen = fm[1]!.length;
        out.push(cur);
        i = le;
        if (i < n) {
          out.push('\n');
          i++;
        }
        const closeRe = new RegExp(`^[ \\t]{0,3}\\${marker}{${markerLen},}[ \\t]*$`);
        while (i < n) {
          let le2 = src.indexOf('\n', i);
          if (le2 === -1) le2 = n;
          const l2 = src.slice(i, le2);
          out.push(l2);
          i = le2;
          if (i < n) {
            out.push('\n');
            i++;
          }
          if (closeRe.test(l2)) break;
        }
        atLineStart = true;
        continue;
      }
      atLineStart = false; // not a fence — process the line character by character
    }

    const c = src[i];

    if (c === '\n') {
      flushLine('\n');
      i++;
      atLineStart = true;
      continue;
    }

    if (c === '`') {
      // Inline code span: verbatim. Closing run must match the opening run length.
      let run = 0;
      while (src[i + run] === '`') run++;
      const close = findClosingBackticks(src, i + run, run);
      if (close === -1) {
        line += '`'.repeat(run);
        i += run;
      } else {
        line += src.slice(i, close + run);
        i = close + run;
        lineHasCode = true;
      }
      continue;
    }

    if (c === '%' && src[i + 1] === '%') {
      lineHadComment = true;
      const close = src.indexOf('%%', i + 2);
      if (close === -1) {
        // Unterminated comment — fail safe: drop everything to EOF.
        i = n;
        break;
      }
      i = close + 2;
      // Collapse whitespace around the removed comment to a single space.
      const last = line[line.length - 1];
      if (line.length === 0 || last === ' ' || last === '\t') {
        while (src[i] === ' ' || src[i] === '\t') i++;
      }
      continue;
    }

    line += c;
    i++;
  }

  // Flush any trailing line without a closing newline (or pending unterminated comment).
  if (line.length || lineHadComment) flushLine('');

  return out.join('');
}

/**
 * From `from`, find the index of a run of exactly `run` backticks (CommonMark:
 * the closing run of an inline code span must match the opening run length and
 * not be part of a longer run).
 */
function findClosingBackticks(src: string, from: number, run: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === '`') {
      let r = 0;
      while (src[i + r] === '`') r++;
      if (r === run) return i;
      i += r;
    } else {
      i++;
    }
  }
  return -1;
}
