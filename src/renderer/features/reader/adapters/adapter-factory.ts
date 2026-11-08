import type { DocumentFormat } from '@shared/types/document';
import type { DocumentAdapter } from '../types';
import { LearningEpubAdapter, LearningMobiAdapter } from './learning-ebook-adapters';
import { PdfAdapter } from './pdf-adapter';
import { DocxAdapter } from './docx-adapter';
import { MarkdownAdapter } from './markdown-adapter';
import { PptxAdapter } from './pptx-adapter';
const ADAPTER_FACTORIES: Readonly<Record<DocumentFormat, () => DocumentAdapter>> = {
  pdf: () => new PdfAdapter(),
  epub: () => new LearningEpubAdapter(),
  mobi: () => new LearningMobiAdapter(),
  docx: () => new DocxAdapter(),
  pptx: () => new PptxAdapter(),
  markdown: () => new MarkdownAdapter(),
};

export function createDocumentAdapter(format: DocumentFormat): DocumentAdapter {
  if (!Object.hasOwn(ADAPTER_FACTORIES, format)) throw new Error(`Unsupported document format: ${format}`);
  return ADAPTER_FACTORIES[format]();
}
