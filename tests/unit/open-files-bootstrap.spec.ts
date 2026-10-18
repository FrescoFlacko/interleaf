import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow, Dialog, OpenDialogReturnValue } from 'electron';
import { IPC_EVENTS } from '../../src/shared/constants/ipc';
import { createOpenFiles, sendFileCommand } from '../../src/main/open-files/open-files-bootstrap';
import { OpenFileRequestQueue } from '../../src/main/open-files/open-file-requests';
import type { OpenFileStoreDeps } from '../../src/main/open-files/open-file-store';
import { unstubbed } from '../helpers/unstubbed';

function fakeWindow(destroyed = false): { window: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const window = { isDestroyed: () => destroyed, webContents: { send } } as object as BrowserWindow;
  return { window, send };
}

describe('open-file bootstrap', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('discards staged leftovers and chooses files through main\'s own dialog', async () => {
    root = mkdtempSync(join(tmpdir(), 'open-bootstrap-'));
    mkdirSync(join(root, 'crashed-run'));
    writeFileSync(join(root, 'crashed-run', 'copy.pdf'), '%PDF-1.4');
    const results: OpenDialogReturnValue[] = [
      { canceled: false, filePaths: ['/docs/chosen.pdf'] },
      { canceled: true, filePaths: [] },
    ];
    const showOpenDialog = vi.fn(() => Promise.resolve(results.shift()!));
    const parent = fakeWindow().window;
    let parentWindow: BrowserWindow | null = parent;
    const requests = new OpenFileRequestQueue();
    const manager = await createOpenFiles({
      root,
      store: unstubbed<Omit<OpenFileStoreDeps, 'root'>>('store'),
      requests,
      dialog: { showOpenDialog } as object as Pick<Dialog, 'showOpenDialog'>,
      parentWindow: () => parentWindow,
    });
    expect(readdirSync(root)).toEqual([]);
    await expect(manager.chooseFile()).resolves.toBe('/docs/chosen.pdf');
    expect(showOpenDialog).toHaveBeenLastCalledWith(parent, expect.objectContaining({ properties: ['openFile'] }));
    parentWindow = null;
    await expect(manager.chooseFile()).resolves.toBeNull();
    expect(showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ buttonLabel: 'Open' }));

    requests.enqueue(['/docs/from-finder.epub']);
    expect(manager.takePendingPath()).toBe('/docs/from-finder.epub');
    expect(manager.takePendingPath()).toBeNull();
  });

  it('sends a file command only to a live window that has already loaded', () => {
    const live = fakeWindow();
    sendFileCommand(() => ({ window: live.window, created: false }), 'open-dialog');
    expect(live.send).toHaveBeenCalledWith(IPC_EVENTS.filesCommand, 'open-dialog');

    const fresh = fakeWindow();
    sendFileCommand(() => ({ window: fresh.window, created: true }), 'open-pending');
    expect(fresh.send).not.toHaveBeenCalled();

    const gone = fakeWindow(true);
    sendFileCommand(() => ({ window: gone.window, created: false }), 'import-dialog');
    expect(gone.send).not.toHaveBeenCalled();
    expect(() => { sendFileCommand(() => ({ window: null, created: false }), 'open-dialog'); }).not.toThrow();
  });
});
