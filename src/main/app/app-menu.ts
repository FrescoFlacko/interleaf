import type { MenuItemConstructorOptions } from 'electron';

export type AppMenuCommands = {
  readonly openFile: () => void;
  readonly importToLibrary: () => void;
};

type MenuApi = {
  buildFromTemplate(template: MenuItemConstructorOptions[]): Electron.Menu;
  setApplicationMenu(menu: Electron.Menu | null): void;
};

/**
 * The application menu: Electron's standard menus, with a File menu that
 * offers Open (reading a file where it is) beside Import to Library.
 */
export function buildAppMenuTemplate(platform: NodeJS.Platform, commands: AppMenuCommands): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { id: 'file-open', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => { commands.openFile(); } },
      { id: 'file-import', label: 'Import to Library…', accelerator: 'CmdOrCtrl+Shift+O', click: () => { commands.importToLibrary(); } },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  };
  return [
    ...(isMac ? [{ role: 'appMenu' } satisfies MenuItemConstructorOptions] : []),
    fileMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}

export function installAppMenu(menu: MenuApi, platform: NodeJS.Platform, commands: AppMenuCommands): void {
  menu.setApplicationMenu(menu.buildFromTemplate(buildAppMenuTemplate(platform, commands)));
}
