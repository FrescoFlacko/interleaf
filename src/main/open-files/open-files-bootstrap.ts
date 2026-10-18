import type { BrowserWindow, Dialog, OpenDialogOptions } from 'electron';
import { IPC_EVENTS } from '@shared/constants/ipc';
import type { FileCommand } from '@shared/types/files';
import { DOCUMENT_FILE_FILTERS } from '../library/document-file-filters';
import { OpenFileManager } from './open-file-manager';
import { OpenFileStore, type OpenFileStoreDeps } from './open-file-store';
import type { OpenFileRequestQueue } from './open-file-requests';

export type OpenFilesBootstrapDeps = {
  /** `AppPaths.openFiles`: private, main-owned, and emptied at every start. */
  readonly root: string;
  /** Shared by every store; each store is given its own staging root. */
  readonly store: Omit<OpenFileStoreDeps, 'root'>;
  readonly requests: OpenFileRequestQueue;
  readonly dialog: Pick<Dialog, 'showOpenDialog'>;
  readonly parentWindow: () => BrowserWindow | null;
};

const OPEN_DIALOG_OPTIONS: OpenDialogOptions = {
  title: 'Open',
  buttonLabel: 'Open',
  properties: ['openFile'],
  filters: DOCUMENT_FILE_FILTERS,
};

async function chooseDocumentFile(deps: OpenFilesBootstrapDeps): Promise<string | null> {
  const parent = deps.parentWindow();
  const result = parent === null
    ? await deps.dialog.showOpenDialog(OPEN_DIALOG_OPTIONS)
    : await deps.dialog.showOpenDialog(parent, OPEN_DIALOG_OPTIONS);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * Builds the open-file runtime. Anything a previous process left staged is
 * removed first, so a crash can never leave an opened file behind for longer
 * than one launch.
 */
export async function createOpenFiles(deps: OpenFilesBootstrapDeps): Promise<OpenFileManager> {
  await OpenFileManager.discardLeftovers(deps.root);
  return new OpenFileManager({
    root: deps.root,
    createStore: ({ root }) => OpenFileStore.create({ ...deps.store, root }),
    chooseFile: () => chooseDocumentFile(deps),
    takePendingPath: () => deps.requests.take(),
  });
}

/**
 * Delivers a file command to the renderer, bringing the window forward (or
 * back, on macOS after it was closed). A window that is still loading claims
 * any pending request itself once it mounts.
 */
export function sendFileCommand(
  ensureWindow: () => { readonly window: BrowserWindow | null; readonly created: boolean },
  command: FileCommand,
): void {
  const { window, created } = ensureWindow();
  if (window === null || created || window.isDestroyed()) return;
  window.webContents.send(IPC_EVENTS.filesCommand, command);
}
