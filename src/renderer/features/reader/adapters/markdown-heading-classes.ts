/**
 * Size classes for each Markdown heading level. Sizes are em so headings follow
 * the reader's text size, which is set on the content wrapper; rem would pin
 * them to the app's root size.
 */
export const MARKDOWN_HEADING_SIZE_CLASSES: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6, string>> = {
  1: 'text-[1.5em] leading-[1.333] font-bold tracking-tight mt-6 mb-4',
  2: 'text-[1.25em] leading-[1.4] font-bold tracking-tight mt-5 mb-3',
  3: 'text-[1.125em] leading-[1.556] font-semibold mt-4 mb-2',
  4: 'text-[1em] leading-[1.5] font-semibold mt-3 mb-2',
  5: 'text-[0.875em] leading-[1.429] font-semibold mt-2 mb-1',
  6: 'text-[0.75em] leading-[1.333] font-semibold uppercase tracking-wider mt-2 mb-1',
};
