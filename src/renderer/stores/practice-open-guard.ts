import type { DocumentLocation, OpenedDocument } from '@shared/types/document';
import { bridge } from '../app/api-client';

export async function verifyPracticeRevision(opened: OpenedDocument, expectedHash: string | undefined): Promise<void> {
  if (expectedHash === undefined || opened.document.fileHash === expectedHash) return;
  await bridge.library.closeDocument(opened.document.id);
  throw new Error('The source document has changed.');
}

export function practiceOpenFailure(documentId: string, initialLocation: DocumentLocation | null, expectedHash: string | undefined) {
  return expectedHash === undefined
    ? { failedDocumentId: documentId, failedInitialLocation: initialLocation }
    : { failedDocumentId: null, failedInitialLocation: null };
}
