/**
 * @archetypal-cz/tmd — Translation Markdown reference library.
 * Spec: FORMAT.md in this repo (canonical home).
 */
export { parse } from './parse.js';
export { project, projectMany, readFrontmatter } from './project.js';
export type { ProjectOptions, ProjectFileInput } from './project.js';
export { validate } from './validate.js';
export type { ValidateFileInput, ValidateResult } from './validate.js';
export { stripComments } from './strip.js';
export { classifyComment, normalizeTimestamp } from './classify.js';
export { parseProfile, idRegex, GENERIC_PROFILE } from './profile.js';
export type {
  TmdProfile,
  ParagraphIdScheme,
  AuthorScheme,
  FootnoteScheme,
  TmdFeatures,
} from './profile.js';
export type {
  CommentType,
  TmdComment,
  TmdAnnotation,
  TmdMachineFlag,
  TmdVersionComment,
  TmdCluster,
  TmdStandalone,
  TmdDocument,
  TmdWarning,
  WarningCode,
} from './types.js';
