import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildAppMenuTemplate, installAppMenu } from '../../src/main/app/app-menu';

function fileItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const file = template.find((item) => item.label === 'File');
  expect(file).toBeDefined();
  return Array.isArray(file?.submenu) ? file.submenu : [];
}

function click(item: MenuItemConstructorOptions | undefined): void {
  const handler = item?.click as (() => void) | undefined;
  handler?.();
}

describe('application menu', () => {
  it('offers Open and Import to Library with distinct accelerators', () => {
    const openFile = vi.fn();
    const importToLibrary = vi.fn();
    const items = fileItems(buildAppMenuTemplate('linux', { openFile, importToLibrary }));
    const open = items.find((item) => item.id === 'file-open');
    const imported = items.find((item) => item.id === 'file-import');
    expect(open).toMatchObject({ label: 'Open…', accelerator: 'CmdOrCtrl+O' });
    expect(imported).toMatchObject({ label: 'Import to Library…', accelerator: 'CmdOrCtrl+Shift+O' });
    click(open);
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(importToLibrary).not.toHaveBeenCalled();
    click(imported);
    expect(importToLibrary).toHaveBeenCalledTimes(1);
  });

  it('adds the macOS application menu and closes windows instead of quitting from File', () => {
    const commands = { openFile: vi.fn(), importToLibrary: vi.fn() };
    const mac = buildAppMenuTemplate('darwin', commands);
    expect(mac[0]).toEqual({ role: 'appMenu' });
    expect(fileItems(mac).at(-1)).toEqual({ role: 'close' });
    const windows = buildAppMenuTemplate('win32', commands);
    expect(windows.some((item) => item.role === 'appMenu')).toBe(false);
    expect(fileItems(windows).at(-1)).toEqual({ role: 'quit' });
    expect(windows.map((item) => item.role ?? item.label)).toEqual(['File', 'editMenu', 'viewMenu', 'windowMenu']);
  });

  it('installs the built template as the application menu', () => {
    const built = {} as Electron.Menu;
    const menu = { buildFromTemplate: vi.fn(() => built), setApplicationMenu: vi.fn() };
    installAppMenu(menu, 'linux', { openFile: vi.fn(), importToLibrary: vi.fn() });
    expect(menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(menu.setApplicationMenu).toHaveBeenCalledWith(built);
  });
});
