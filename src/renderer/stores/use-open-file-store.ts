import { create } from 'zustand';
import type { DocumentMetadata } from '@shared/types/document';
import type { FileCommand } from '@shared/types/files';
import { useLibraryStore } from './use-library-store';
import { useReaderStore } from './use-reader-store';
import { bridge } from '../app/api-client';

type OpenFileState = {
  /** The last file that could not be opened, shown until dismissed. */
  error: string | null;
  dismissError: () => void;
};

export const useOpenFileStore = create<OpenFileState>((set) => ({
  error: null,
  dismissError: () => { set({ error: null }); },
}));

/**
 * Each request takes a ticket when it starts. An outcome (a file or a failure)
 * reaches the reader only if no newer request has already produced one, so a
 * slow older open never replaces a newer file. A request that produced nothing
 * (a cancelled dialog, or a claim that found no pending file because a
 * duplicate claim took it) is not an outcome and cannot suppress one.
 */
let openSequence = 0;
let appliedTicket = 0;
let dialogOpen = false;

function describeFailure(caught: Error | null): string {
  return caught !== null && caught.message.length > 0 ? caught.message : 'The file could not be opened.';
}

/** Claims the reader for this outcome; false when a newer outcome already has it. */
function claimOutcome(ticket: number): boolean {
  if (ticket < appliedTicket) return false;
  appliedTicket = ticket;
  return true;
}

async function openWith(request: () => Promise<DocumentMetadata | null>): Promise<void> {
  const ticket = ++openSequence;
  try {
    const document = await request();
    if (document === null || !claimOutcome(ticket)) return;
    useOpenFileStore.setState({ error: null });
    await useReaderStore.getState().openDocument(document.id);
  } catch (caught) {
    if (claimOutcome(ticket)) useOpenFileStore.setState({ error: describeFailure(caught instanceof Error ? caught : null) });
  }
}

/**
 * Asks main to show its Open dialog and reads the chosen file where it is,
 * without adding it to the library. A second request while the dialog is up
 * is ignored rather than stacking dialogs, which also absorbs a shortcut that
 * both the menu and the window saw.
 */
export async function openFileFromDialog(): Promise<void> {
  if (dialogOpen) return;
  dialogOpen = true;
  try {
    await openWith(() => bridge.files.openDialog());
  } finally {
    dialogOpen = false;
  }
}

/** Opens the file the operating system most recently handed the application, if any. */
export async function openPendingFile(): Promise<void> {
  await openWith(() => bridge.files.openPending());
}

let importDialogOpen = false;

/** The library's import dialog, guarded the same way as the Open dialog. */
async function importToLibrary(): Promise<void> {
  if (importDialogOpen) return;
  importDialogOpen = true;
  try {
    await useLibraryStore.getState().openFileDialog();
  } finally {
    importDialogOpen = false;
  }
}

const FILE_COMMAND_HANDLERS: Readonly<Record<FileCommand, () => Promise<void>>> = {
  'open-dialog': openFileFromDialog,
  'import-dialog': importToLibrary,
  'open-pending': openPendingFile,
};

export function runFileCommand(command: FileCommand): void {
  void FILE_COMMAND_HANDLERS[command]();
}

/** Ctrl/Cmd+O opens a file; adding Shift imports to the library, as in the File menu. */
export function runFileShortcut(event: Pick<KeyboardEvent, 'shiftKey'>): void {
  runFileCommand(event.shiftKey ? 'import-dialog' : 'open-dialog');
}

/**
 * Follows the File menu and operating-system open requests. Subscribing comes
 * before claiming, so a request that arrives while this window loads is
 * delivered either by the claim or by the event, and main hands a pending
 * file to exactly one of them.
 */
export function followFileCommands(): () => void {
  const unsubscribe = bridge.files.onCommand(runFileCommand);
  void openPendingFile();
  return unsubscribe;
}
