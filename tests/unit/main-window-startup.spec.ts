import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';
import type { WindowRevealMode } from '@main/windows/window-reveal-mode';
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
    showInactive(): void { calls.push('showInactive'); }
    setAlwaysOnTop(flag: boolean, level: string, relativeLevel: number): void {
      calls.push(`setAlwaysOnTop:${String(flag)}:${level}:${String(relativeLevel)}`);
    }
    focus(): void { calls.push('focus'); }
    setFullScreen(): void { calls.push('setFullScreen'); }
    setSimpleFullScreen(): void { calls.push('setSimpleFullScreen'); }
    loadURL(): Promise<void> { calls.push('loadURL'); return Promise.resolve(); }
    loadFile(): Promise<void> { calls.push('loadFile'); return Promise.resolve(); }
  }

  return { calls, once, constructed, FakeBrowserWindow };
});

vi.mock('electron', () => ({ BrowserWindow: electron.FakeBrowserWindow }));

const { createMainWindow, createSecureWebPreferences } = await import('@main/windows/main-window');

function create(revealMode?: WindowRevealMode): void {
  createMainWindow({
    indexHtmlPath: '/app/renderer/index.html',
    preloadPath: '/app/preload/index.js',
    iconPath: '/app/icon.png',
    log: silentLogger,
    ...(revealMode === undefined ? {} : { revealMode }),
  });
}

const BELOW_ORDINARY = 'setAlwaysOnTop:true:normal:-1';
const REVEAL_CALLS = new Set(['maximize', 'show', 'showInactive', 'focus', BELOW_ORDINARY]);

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

    const reveal = electron.calls.filter((call) => REVEAL_CALLS.has(call));
    expect(reveal).toEqual(['maximize', 'show']);
  });

  it('keeps the activating maximize-then-show reveal when the foreground mode is explicit', () => {
    create('foreground');
    electron.once.get('ready-to-show')?.();
    expect(electron.calls.filter((call) => REVEAL_CALLS.has(call))).toEqual(['maximize', 'show']);
  });

  it('reveals the same maximized window without activating it in the E2E background mode', () => {
    create('background');
    expect(electron.constructed[0]?.show).toBe(false);
    expect(electron.calls.filter((call) => REVEAL_CALLS.has(call))).toEqual([]);

    electron.once.get('ready-to-show')?.();

    // On macOS the window drops below ordinary windows before anything orders it in.
    const lowered = process.platform === 'darwin' ? [BELOW_ORDINARY] : [];
    expect(electron.calls.filter((call) => REVEAL_CALLS.has(call))).toEqual([...lowered, 'maximize', 'showInactive']);
    expect(electron.calls).not.toContain('setFullScreen');
    // Geometry and security are the foreground window's.
    expect(electron.constructed[0]).toMatchObject({ width: 1400, height: 900, minWidth: 960, minHeight: 600 });
    expect(electron.constructed[0]?.webPreferences).toEqual(createSecureWebPreferences('/app/preload/index.js'));
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
