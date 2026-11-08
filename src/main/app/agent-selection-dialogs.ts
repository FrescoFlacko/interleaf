import type { BrowserWindow, Dialog, OpenDialogOptions } from 'electron';

/** Native selections retain their paths in main and preserve the platform filters. */
export function agentSelectionDialogs(dialog: Pick<Dialog, 'showOpenDialog'>, parentWindow: () => BrowserWindow | null, platform: NodeJS.Platform) {
  async function choose(options: OpenDialogOptions): Promise<string | null> {
    const parent = parentWindow();
    const result = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  }
  return {
    chooseDirectory: () => choose({ properties: ['openDirectory', 'createDirectory'], title: 'Select an agent working directory' }),
    chooseExecutable: () => choose({ properties: ['openFile'], title: 'Select a custom agent executable',
      ...(platform === 'win32' ? { filters: [{ name: 'Executable files', extensions: ['exe', 'com'] }] } : {}) }),
  };
}
