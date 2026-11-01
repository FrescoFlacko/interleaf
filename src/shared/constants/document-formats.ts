import type { DocumentFormat } from '../types/document';

/**
 * Every file extension Interleaf reads, in display order, with the reader
 * format that reads it. The one list import validation, the native dialogs,
 * operating-system hand-off and title derivation all take their extensions
 * from, so supporting a new extension is one entry here.
 *
 * Lowercase and without the dot; callers compare case-insensitively.
 */
const DOCUMENT_EXTENSION_FORMATS = [
  ['pdf', 'pdf'],
  ['epub', 'epub'],
  ['mobi', 'mobi'],
  ['azw', 'mobi'],
  ['azw3', 'mobi'],
  ['docx', 'docx'],
  ['pptx', 'pptx'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
] as const satisfies readonly (readonly [string, DocumentFormat])[];

const FORMAT_BY_EXTENSION: ReadonlyMap<string, DocumentFormat> = new Map(DOCUMENT_EXTENSION_FORMATS);

/** Every supported extension, without the dot, in display order. */
export const DOCUMENT_EXTENSIONS: readonly string[] = DOCUMENT_EXTENSION_FORMATS.map(([extension]) => extension);

/** The extensions, without the dot, that a single format is read from. */
export function documentExtensionsFor(format: DocumentFormat): readonly string[] {
  return DOCUMENT_EXTENSION_FORMATS.filter(([, owner]) => owner === format).map(([extension]) => extension);
}

/**
 * The format a file extension is read as, or `null` when Interleaf does not
 * read it. Accepts the extension with or without its leading dot, in any case.
 */
export function documentFormatForExtension(extension: string): DocumentFormat | null {
  const bare = extension.startsWith('.') ? extension.slice(1) : extension;
  return FORMAT_BY_EXTENSION.get(bare.toLowerCase()) ?? null;
}

/**
 * Formats whose text reflows to the reader's typography. PDF keeps its fixed
 * page layout, so reflow controls never apply to it.
 */
export const REFLOWABLE_DOCUMENT_FORMATS: ReadonlySet<DocumentFormat> = new Set<DocumentFormat>([
  'epub',
  'mobi',
  'docx',
  'pptx',
  'markdown',
]);
