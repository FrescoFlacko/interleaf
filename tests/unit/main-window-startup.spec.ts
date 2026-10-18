import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';
import { silentLogger } from '../helpers/silent-logger';

/**
 * The main window opens maximized to the display's work area — a normal,
 * restorable desktop window, not OS fullscreen — and is already maximized when
 * it is first shown, so the reader never sees the smaller default size first.
 */
const electron = vi.hoisted(() => {
  type Handler = () => void;
  const calls: string[] = [];
  const once = new Map<string, Handler>();
  const constructed: BrowserWindowConstructorOptions[] = [];

  class FakeBrowserWindow {
    readonly webContents = {
      on: (): undefined => undefined,
      setWindowOpenHandler: (): undefined => undefined,
    };

    constructor(options: BrowserWindowConstructorOptions) {
      constructed.push(options);
    }

    once(event: string, handler: Handler): void {
      once.set(event, handler);
    }

    maximize(): void { calls.push('maximize'); }
    show(): void { calls.push('show'); }
    setFullScreen(): void { calls.push('setFullScreen'); }
    setSimpleFullScreen(): void { calls.push('setSimpleFullScreen'); }
    loadURL(): Promise<void> { calls.push('loadURL'); return Promise.resolve(); }
    loadFile(): Promise<void> { calls.push('loadFile'); return Promise.resolve(); }
  }

  return { calls, once, constructed, FakeBrowserWindow };
});

vi.mock('electron', () => ({ BrowserWindow: electron.FakeBrowserWindow }));

const { createMainWindow, createSecureWebPreferences } = await import('@main/windows/main-window');

function create(): void {
  createMainWindow({
    indexHtmlPath: '/app/renderer/index.html',
    preloadPath: '/app/preload/index.js',
    iconPath: '/app/icon.png',
    log: silentLogger,
  });
}

describe('main window launch geometry', () => {
  beforeEach(() => {
    electron.calls.length = 0;
    electron.once.clear();
    electron.constructed.length = 0;
  });

  it('stays hidden until ready and maximizes before it is first shown', () => {
    create();
    expect(electron.constructed[0]?.show).toBe(false);
    expect(electron.calls).not.toContain('maximize');
    expect(electron.calls).not.toContain('show');

    electron.once.get('ready-to-show')?.();

    const reveal = electron.calls.filter((call) => call === 'maximize' || call === 'show');
    expect(reveal).toEqual(['maximize', 'show']);
  });

  it('remains a normal resizable window rather than entering fullscreen', () => {
    create();
    electron.once.get('ready-to-show')?.();

    const options = electron.constructed[0];
    expect(options).toBeDefined();
    expect(electron.calls).not.toContain('setFullScreen');
    expect(electron.calls).not.toContain('setSimpleFullScreen');
    expect(options?.fullscreen).toBeUndefined();
    expect(options?.simpleFullscreen).toBeUndefined();
    expect(options?.frame).toBeUndefined();
    expect(options?.resizable).toBeUndefined();
    expect(options?.maximizable).toBeUndefined();
    // The restored size and minimums are unchanged.
    expect(options).toMatchObject({ width: 1400, height: 900, minWidth: 960, minHeight: 600 });
    // The secure web preferences are unchanged.
    expect(options?.webPreferences).toEqual(createSecureWebPreferences('/app/preload/index.js'));
  });
});
