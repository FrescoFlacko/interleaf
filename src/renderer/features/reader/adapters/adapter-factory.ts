import type { DocumentFormat } from '@shared/types/document';
import type { DocumentAdapter } from '../types';
import { EpubAdapter } from './epub-adapter';
import { MobiAdapter } from './mobi-adapter';
import { PdfAdapter } from './pdf-adapter';
import { DocxAdapter } from './docx-adapter';
import { MarkdownAdapter } from './markdown-adapter';
import { PptxAdapter } from './pptx-adapter';
const ADAPTER_FACTORIES: Readonly<Record<DocumentFormat, () => DocumentAdapter>> = {
  pdf: () => new PdfAdapter(),
  epub: () => new EpubAdapter(),
  mobi: () => new MobiAdapter(),
  docx: () => new DocxAdapter(),
  pptx: () => new PptxAdapter(),
  markdown: () => new MarkdownAdapter(),
};

export function createDocumentAdapter(format: DocumentFormat): DocumentAdapter {
  if (!Object.hasOwn(ADAPTER_FACTORIES, format)) throw new Error(`Unsupported document format: ${format}`);
  return ADAPTER_FACTORIES[format]();
}
