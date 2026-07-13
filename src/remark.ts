/**
 * Remark plugin that removes TMD `%% … %%` comments so they never render.
 *
 * It works on the RAW markdown (`file.value`) before it is turned into HTML:
 * stripping the source string is the only reliable way to remove long /
 * multi-line / markdown-bearing comment blocks (see strip.ts). When a document
 * actually contains comments the cleaned source is re-parsed and the resulting
 * tree swapped in; documents without comments are left completely untouched,
 * so the host pipeline's own parse result stands.
 *
 * The re-parser is pluggable so the swapped-in tree matches the host pipeline
 * exactly (e.g. Astro = remark-parse + remark-gfm + remark-smartypants). The
 * default uses this processor's own parser via `this.parse` — for a plain
 * `remark()` pipeline that is already correct; pass `reparse` when your
 * pipeline's parse stage has plugins that run *after* this one.
 *
 * Usage (Astro):
 * ```ts
 * import remarkTmd from '@archetypal-cz/tmd/remark';
 * export default defineConfig({ markdown: { remarkPlugins: [remarkTmd] } });
 * ```
 */
import type { Root } from 'mdast';
import type { Plugin, Processor } from 'unified';
import type { VFile } from 'vfile';
import { stripComments } from './strip.js';

export interface RemarkTmdOptions {
  /** Re-parse cleaned source into an mdast tree matching the host pipeline. */
  reparse?: (source: string) => Root;
}

const remarkTmd: Plugin<[RemarkTmdOptions?], Root> = function (
  this: Processor,
  options: RemarkTmdOptions = {}
) {
  const processor = this;
  return (tree: Root, file: VFile) => {
    const raw = String(file.value);
    const cleaned = stripComments(raw);
    if (cleaned === raw) return; // no comments here — do not disturb the pipeline
    const newTree = options.reparse
      ? options.reparse(cleaned)
      : (processor.parse(cleaned) as Root);
    tree.children = newTree.children;
  };
};

export default remarkTmd;
export { stripComments };
