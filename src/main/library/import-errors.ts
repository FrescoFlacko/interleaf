import { InterleafError } from '@shared/errors/interleaf-error';

/** Whether an insert lost the race on the documents' unique file-hash constraint. */
export function isUniqueFileHashConstraintError(error: Error | null): boolean {
  if (error === null) return false;
  return error.message.includes('UNIQUE constraint failed: documents.file_hash');
}

/** The reader-safe message for a failed import: validation text, or a fixed fallback. */
export function safeImportError(error: Error | null): string {
  if (error instanceof InterleafError && error.code === 'validation') {
    return error.message;
  }
  return 'Interleaf could not import this file safely.';
}
