import type { FileFilter } from 'electron';

/** Native dialog filters shared by library import and Open File. */
export const DOCUMENT_FILE_FILTERS: FileFilter[] = [
  {
    name: 'Supported Documents (PDF, EPUB, MOBI, DOCX, PPTX, Markdown)',
    extensions: ['pdf', 'epub', 'mobi', 'azw', 'azw3', 'docx', 'pptx', 'md', 'markdown'],
  },
  { name: 'PDF Documents (*.pdf)', extensions: ['pdf'] },
  { name: 'EPUB eBooks (*.epub)', extensions: ['epub'] },
  { name: 'MOBI & Kindle eBooks (*.mobi, *.azw3)', extensions: ['mobi', 'azw', 'azw3'] },
  { name: 'Word Documents (*.docx)', extensions: ['docx'] },
  { name: 'PowerPoint Presentations (*.pptx)', extensions: ['pptx'] },
  { name: 'Markdown Documents (*.md, *.markdown)', extensions: ['md', 'markdown'] },
];
