import type { DocumentMetadata, OpenedDocument } from '@shared/types/document';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { DocumentServices } from './open-file-store';
import type { OpenFileManager } from './open-file-manager';

/**
 * What IPC needs from the open-file runtime: ownership lookups for routing,
 * and the two ways a renderer may ask main to open a file. The renderer never
 * names a path; main chooses it through its own dialog or its request queue.
 */
export type OpenFilesRuntime = Pick<
  OpenFileManager,
  'forDocument' | 'forSession' | 'owns' | 'close' | 'closeAll' | 'cancel' | 'open' | 'chooseFile' | 'takePendingPath'
>;

type RoutingDeps = DocumentServices & { readonly openFiles: OpenFilesRuntime };

/** The store that owns `documentId`: an open file's, or else the library's. */
export function servicesForDocument(deps: RoutingDeps, documentId: string): DocumentServices {
  return deps.openFiles.forDocument(documentId) ?? deps;
}

/** The store whose chat database holds `sessionId`: an open file's, or else the library's. */
export function servicesForSession(deps: RoutingDeps, sessionId: string): DocumentServices {
  return deps.openFiles.forSession(sessionId) ?? deps;
}

export function isOpenFileDocument(deps: RoutingDeps, documentId: string): boolean {
  return deps.openFiles.owns(documentId);
}

/** Agent sessions are durable library records, so an open file never starts one. */
export function assertLibraryDocument(deps: RoutingDeps, documentId: string): void {
  if (isOpenFileDocument(deps, documentId)) {
    throw new InterleafError('validation', 'Agent Mode works with documents in your library.');
  }
}

async function openChosen(runtime: OpenFilesRuntime, filePath: string | null): Promise<DocumentMetadata | null> {
  return filePath === null ? null : runtime.open(filePath);
}

export function openFromDialog(deps: RoutingDeps): Promise<DocumentMetadata | null> {
  const runtime = deps.openFiles;
  return runtime.chooseFile().then((filePath) => openChosen(runtime, filePath));
}

export function openPending(deps: RoutingDeps): Promise<DocumentMetadata | null> {
  const runtime = deps.openFiles;
  return openChosen(runtime, runtime.takePendingPath());
}

/**
 * Opening a library document ends any open file, and closing an open file
 * discards it: the reader shows one document, and an open file has no life
 * outside the reader.
 */
export async function openDocumentRouted(deps: RoutingDeps, documentId: string): Promise<OpenedDocument> {
  const services = servicesForDocument(deps, documentId);
  if (services === deps) {
    await deps.openFiles.closeAll();
    return deps.library.openDocument(documentId);
  }
  return services.library.openDocument(documentId);
}

export async function closeDocumentRouted(deps: RoutingDeps, documentId: string): Promise<void> {
  if (deps.openFiles.owns(documentId)) {
    // Disposal cancels the file's chat work before anything is revoked.
    await deps.openFiles.close(documentId);
    return;
  }
  await deps.chat.cancelForDocument(documentId);
  await deps.library.closeDocument(documentId);
}

export async function cancelChatRouted(deps: RoutingDeps, requestId: string, ownerId: number): Promise<void> {
  await deps.chat.cancel(requestId, ownerId);
  await deps.openFiles.cancel(requestId, ownerId);
}
