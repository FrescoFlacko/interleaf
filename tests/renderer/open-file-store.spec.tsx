// @vitest-environment jsdom
import { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { DocumentMetadata } from '@shared/types/document';
import type { FileCommand } from '@shared/types/files';
import { stubBridge } from '../helpers/interleaf-api';
import {
  followFileCommands,
  openFileFromDialog,
  openPendingFile,
  runFileCommand,
  useOpenFileStore,
} from '../../src/renderer/stores/use-open-file-store';
import { useReaderStore } from '../../src/renderer/stores/use-reader-store';
import { useLibraryStore } from '../../src/renderer/stores/use-library-store';
import { useShortcuts } from '../../src/renderer/hooks/use-shortcuts';
import { AppHeader } from '../../src/renderer/components/AppHeader';
import { OpenFileNotice } from '../../src/renderer/components/OpenFileNotice';
import { LibrarySidebar } from '../../src/renderer/components/LibrarySidebar';
import { useUiStore } from '../../src/renderer/stores/use-ui-store';

function metadata(id: string): DocumentMetadata {
  return {
    id,
    title: id,
    author: null,
    format: 'markdown',
    storageMode: 'managed',
    fileSize: 1,
    fileMtimeMs: 1,
    fileHash: 'hash',
    pageCount: null,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: null,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    source: null,
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const INITIAL_READER = useReaderStore.getState();
const INITIAL_LIBRARY = useLibraryStore.getState();
const INITIAL_UI = useUiStore.getState();

describe('opening files from the renderer', () => {
  const openDocument = vi.fn(() => Promise.resolve());
  const openFileDialog = vi.fn(() => Promise.resolve(null));

  beforeEach(() => {
    openDocument.mockClear();
    openFileDialog.mockClear();
    useReaderStore.setState({ openDocument });
    useLibraryStore.setState({ openFileDialog });
    useOpenFileStore.setState({ error: null });
  });

  afterEach(() => {
    cleanup();
    useReaderStore.setState(INITIAL_READER, true);
    useLibraryStore.setState(INITIAL_LIBRARY, true);
    useUiStore.setState(INITIAL_UI, true);
  });

  it('reads the chosen file and does nothing when the dialog is cancelled', async () => {
    const openDialog = vi.fn()
      .mockResolvedValueOnce(metadata('chosen'))
      .mockResolvedValueOnce(null);
    stubBridge({ files: { openDialog } });
    await openFileFromDialog();
    expect(openDocument).toHaveBeenCalledWith('chosen');
    await openFileFromDialog();
    expect(openDocument).toHaveBeenCalledTimes(1);
  });

  it('shows one dialog at a time, even when the menu and the window both see the shortcut', async () => {
    const pending = deferred<DocumentMetadata | null>();
    const openDialog = vi.fn(() => pending.promise);
    stubBridge({ files: { openDialog } });
    const first = openFileFromDialog();
    runFileCommand('open-dialog');
    await openFileFromDialog();
    expect(openDialog).toHaveBeenCalledTimes(1);
    pending.resolve(metadata('only'));
    await first;
    expect(openDocument).toHaveBeenCalledWith('only');
    expect(openDocument).toHaveBeenCalledTimes(1);
  });

  it('lets only the newest request reach the reader', async () => {
    const slow = deferred<DocumentMetadata | null>();
    const openPending = vi.fn(() => slow.promise);
    const openDialog = vi.fn(() => Promise.resolve(metadata('newer')));
    stubBridge({ files: { openPending, openDialog } });
    const stale = openPendingFile();
    await openFileFromDialog();
    slow.resolve(metadata('older'));
    await stale;
    expect(openDocument.mock.calls).toEqual([['newer']]);
  });

  it('keeps a claimed file when a duplicate claim finds nothing pending', async () => {
    // Main hands the pending path to the first claim only; the second gets null.
    const staging = deferred<DocumentMetadata | null>();
    const openPending = vi.fn()
      .mockReturnValueOnce(staging.promise)
      .mockResolvedValueOnce(null);
    stubBridge({ files: { openPending } });
    const first = openPendingFile();
    await openPendingFile();
    staging.resolve(metadata('launch'));
    await first;
    expect(openDocument.mock.calls).toEqual([['launch']]);
  });

  it('keeps an older file when a newer dialog is cancelled', async () => {
    const staging = deferred<DocumentMetadata | null>();
    stubBridge({
      files: { openPending: () => staging.promise, openDialog: () => Promise.resolve(null) },
    });
    const pending = openPendingFile();
    await openFileFromDialog();
    staging.resolve(metadata('delivered'));
    await pending;
    expect(openDocument.mock.calls).toEqual([['delivered']]);
  });

  it('opens a file delivered at launch once under StrictMode, whose startup effect runs twice', async () => {
    const staging = deferred<DocumentMetadata | null>();
    let delivered = false;
    const openPending = vi.fn(() => {
      if (delivered) return Promise.resolve(null);
      delivered = true;
      return staging.promise;
    });
    const unsubscribe = vi.fn();
    stubBridge({
      files: { openPending, onCommand: () => unsubscribe, openDialog: () => Promise.resolve(null) },
    });
    // The same effect App mounts, inside the StrictMode root main.tsx renders.
    function Shell() {
      useEffect(() => followFileCommands(), []);
      return null;
    }
    render(<StrictMode><Shell /></StrictMode>);
    await vi.waitFor(() => { expect(openPending).toHaveBeenCalledTimes(2); });
    staging.resolve(metadata('launch'));
    await vi.waitFor(() => { expect(openDocument).toHaveBeenCalledWith('launch'); });
    expect(openDocument).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('reports a refused file without leaving the current document, and ignores a stale refusal', async () => {
    const openDialog = vi.fn(() => Promise.reject(new Error('This file is not a valid PowerPoint presentation.')));
    stubBridge({ files: { openDialog } });
    await openFileFromDialog();
    expect(useOpenFileStore.getState().error).toBe('This file is not a valid PowerPoint presentation.');
    expect(openDocument).not.toHaveBeenCalled();
    useOpenFileStore.getState().dismissError();
    expect(useOpenFileStore.getState().error).toBeNull();

    const late = deferred<DocumentMetadata | null>();
    stubBridge({
      files: { openPending: () => late.promise, openDialog: () => Promise.resolve(metadata('current')) },
    });
    const stale = openPendingFile();
    await openFileFromDialog();
    late.reject(new Error('late failure'));
    await stale;
    expect(useOpenFileStore.getState().error).toBeNull();
    expect(openDocument).toHaveBeenCalledWith('current');
  });

  it('routes menu commands to Open, Import to Library and pending requests', async () => {
    const openPending = vi.fn(() => Promise.resolve(metadata('pending')));
    stubBridge({ files: { openPending } });
    runFileCommand('import-dialog');
    runFileCommand('open-pending');
    await vi.waitFor(() => { expect(openDocument).toHaveBeenCalledWith('pending'); });
    expect(openFileDialog).toHaveBeenCalledTimes(1);
  });

  it('subscribes before claiming a request that arrived while the window loaded', async () => {
    const order: string[] = [];
    let listener: ((command: FileCommand) => void) | null = null;
    const unsubscribe = vi.fn();
    stubBridge({
      files: {
        onCommand: (callback) => { order.push('subscribe'); listener = callback; return unsubscribe; },
        openPending: () => { order.push('claim'); return Promise.resolve(metadata('launch')); },
        openDialog: () => Promise.resolve(null),
      },
    });
    const stop = followFileCommands();
    expect(order).toEqual(['subscribe', 'claim']);
    await vi.waitFor(() => { expect(openDocument).toHaveBeenCalledWith('launch'); });
    listener!('import-dialog');
    expect(openFileDialog).toHaveBeenCalledTimes(1);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('opens with Ctrl/Cmd+O and imports with Ctrl/Cmd+Shift+O, but not from a text field', async () => {
    const openDialog = vi.fn(() => Promise.resolve(null));
    stubBridge({ files: { openDialog } });
    renderHook(() => { useShortcuts(); });
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    await vi.waitFor(() => { expect(openDialog).toHaveBeenCalledTimes(1); });
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => { expect(openFileDialog).toHaveBeenCalledTimes(1); });
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: 'o', metaKey: true });
    input.remove();
    expect(openDialog).toHaveBeenCalledTimes(1);
  });

  it('keeps Open out of the header and offers it in the Library rail, which reads without importing', async () => {
    const openDialog = vi.fn(() => Promise.resolve(metadata('chosen')));
    stubBridge({ files: { openDialog } });
    useLibraryStore.setState({ loadFolders: () => Promise.resolve(), loadSummary: () => Promise.resolve() });
    useUiStore.setState({ compactActivePanel: 'left' });
    render(<><AppHeader compact /><LibrarySidebar /></>);
    const header = screen.getByTestId('app-header');
    expect(header.querySelector('[data-testid="open-file"]')).toBeNull();
    for (const id of ['theme-menu-trigger', 'open-settings', 'open-shortcuts']) {
      expect(header.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }

    const control = screen.getByTestId('library-open-file');
    expect(control).toBe(screen.getByRole('button', { name: 'Open file' }));
    expect(control.title).toContain('without adding it to your library');
    fireEvent.click(control);
    await vi.waitFor(() => { expect(openDocument).toHaveBeenCalledWith('chosen'); });
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(openFileDialog).not.toHaveBeenCalled();
    expect(useUiStore.getState().compactActivePanel).toBeNull();
  });

  it('reports a refusal from the Library rail control in the shell', async () => {
    const openDialog = vi.fn(() => Promise.reject(new Error('This file could not be read.')));
    stubBridge({ files: { openDialog } });
    useLibraryStore.setState({ loadFolders: () => Promise.resolve(), loadSummary: () => Promise.resolve() });
    render(<><LibrarySidebar /><OpenFileNotice /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This file could not be read.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
