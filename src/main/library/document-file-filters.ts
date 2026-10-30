import type { FileFilter } from 'electron';
import { DOCUMENT_EXTENSIONS, documentExtensionsFor } from '@shared/constants/document-formats';

/**
 * Native dialog filters shared by library import and Open File. The names are
 * the dialog's own wording; the extensions come from the format registry.
 */
export const DOCUMENT_FILE_FILTERS: FileFilter[] = [
  {
    name: 'Supported Documents (PDF, EPUB, MOBI, DOCX, PPTX, Markdown)',
    extensions: [...DOCUMENT_EXTENSIONS],
  },
  { name: 'PDF Documents (*.pdf)', extensions: [...documentExtensionsFor('pdf')] },
  { name: 'EPUB eBooks (*.epub)', extensions: [...documentExtensionsFor('epub')] },
  { name: 'MOBI & Kindle eBooks (*.mobi, *.azw3)', extensions: [...documentExtensionsFor('mobi')] },
  { name: 'Word Documents (*.docx)', extensions: [...documentExtensionsFor('docx')] },
  { name: 'PowerPoint Presentations (*.pptx)', extensions: [...documentExtensionsFor('pptx')] },
  { name: 'Markdown Documents (*.md, *.markdown)', extensions: [...documentExtensionsFor('markdown')] },
];
