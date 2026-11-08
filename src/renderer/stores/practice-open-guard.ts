import type { OpenedDocument } from '@shared/types/document';
import { bridge } from '../app/api-client';

export async function verifyPracticeRevision(opened: OpenedDocument, expectedHash: string | undefined): Promise<void> {
  if (expectedHash === undefined || opened.document.fileHash === expectedHash) return;
  await bridge.library.closeDocument(opened.document.id);
  throw new Error('The source document has changed.');
}

