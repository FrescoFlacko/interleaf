/**
 * Typed clipboard contract for secure native clipboard access.
 */

export type ClipboardWriteResult = {
  readonly copied: true;
  readonly characterCount: number;
};
