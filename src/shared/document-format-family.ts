/**
 * Word documents and PowerPoint decks share the paragraph location model
 * (`paragraphIndex`, optional character range and `renderedPageIndex`), so
 * code that handles one handles both with the format carried through.
 */
export type ParagraphFormat = 'docx' | 'pptx';

const PARAGRAPH_FORMATS: ReadonlySet<string> = new Set<ParagraphFormat>(['docx', 'pptx']);

export function isParagraphFormat(format: string): format is ParagraphFormat {
  return PARAGRAPH_FORMATS.has(format);
}

/** Narrows any `{ format }` union member to its paragraph-format variants. */
export function hasParagraphFormat<T extends { readonly format: string }>(
  value: T
): value is Extract<T, { readonly format: ParagraphFormat }> {
  return isParagraphFormat(value.format);
}
