import type { DocumentLocation, OpenedDocument } from '@shared/types/document';

export function verifyOpenedPassage(opened: OpenedDocument, expectedHash: string | undefined): void {
  if (expectedHash !== undefined && opened.document.fileHash !== expectedHash) {
    throw new Error('This passage is unavailable because the document changed.');
  }
}

export function failedPassageState(documentId: string, location: DocumentLocation | null, expectedHash: string | undefined) {
  return expectedHash === undefined
    ? { failedDocumentId: documentId, failedInitialLocation: location }
    : { failedDocumentId: null, failedInitialLocation: null };
}
