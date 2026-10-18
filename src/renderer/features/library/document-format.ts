import type { DocumentFormat } from '@shared/types/document';

/**
 * Pure presentation formatting for library document metadata.
 *
 * These helpers carry no React, DOM or icon dependency on purpose: the E2E
 * specs assert against the exact strings the library renders, so they import
 * this module directly rather than pulling a component graph (and its icon
 * package) into Node-side test collection.
 */

/** Human-readable file size, matching the size shown on a card footer. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FORMAT_BADGE_CLASSES: Readonly<Record<DocumentFormat, string>> = {
  pdf: 'border border-danger/40 bg-danger/10 text-danger',
  epub: 'border border-accent/40 bg-accent/10 text-accent',
  mobi: 'border border-warning/40 bg-warning/10 text-warning',
  docx: 'border border-text-primary/30 bg-bg-surface text-text-primary',
  pptx: 'border border-text-primary/30 bg-bg-surface text-text-primary',
  markdown: 'border border-accent/40 bg-bg-surface text-accent',
};

/** Tailwind chrome for the format badge of a given document format. */
export function formatBadgeClass(format: DocumentFormat): string {
  return Object.hasOwn(FORMAT_BADGE_CLASSES, format)
    ? FORMAT_BADGE_CLASSES[format]
    : 'border border-border-subtle bg-bg-surface text-text-secondary';
}
