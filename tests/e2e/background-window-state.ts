import { expect, type ElectronApplication } from '@playwright/test';

/**
 * Native window state for the background-window cases, read back from
 * Electron's own window and app APIs (not a mock). Shared by the portable case
 * and the macOS- and Linux-native cases that add each OS's own evidence.
 */
export type FocusState = {
  readonly windowCount: number;
  readonly focusedWindowExists: boolean;
  readonly windowFocused: boolean;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly fullScreen: boolean;
  readonly dockVisible: boolean | null;
  /** The CoreGraphics window number, from `window:<number>:0` (macOS). */
  readonly windowNumber: number | null;
};

export type FocusCounters = { browserWindowFocus: number; becameActive: number };
type CounterScope = typeof globalThis & { __interleafFocusCounters?: FocusCounters };

export async function focusState(electronApp: ElectronApplication): Promise<FocusState> {
  return electronApp.evaluate(({ app, BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const [win] = windows;
    if (win === undefined) throw new Error('no main window');
    const mediaSource = /^window:(\d+):/u.exec(win.getMediaSourceId());
    return {
      windowCount: windows.length,
      focusedWindowExists: BrowserWindow.getFocusedWindow() !== null,
      windowFocused: win.isFocused(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      fullScreen: win.isFullScreen(),
      dockVisible: app.dock === undefined ? null : app.dock.isVisible(),
      windowNumber: mediaSource?.[1] === undefined ? null : Number(mediaSource[1]),
    };
  });
}

/** Counts every activation main observes from here on. */
export async function countActivations(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ app }) => {
    const counters: FocusCounters = { browserWindowFocus: 0, becameActive: 0 };
    (globalThis as CounterScope).__interleafFocusCounters = counters;
    app.on('browser-window-focus', () => { counters.browserWindowFocus += 1; });
    app.on('did-become-active', () => { counters.becameActive += 1; });
  });
}

export async function activations(electronApp: ElectronApplication): Promise<FocusCounters | undefined> {
  return electronApp.evaluate(() => (globalThis as CounterScope).__interleafFocusCounters);
}

/** One visible, unfocused, ordinary window: the portable background contract. */
export function expectBackgroundWindow(state: FocusState): void {
  expect(state).toMatchObject({
    windowCount: 1,
    focusedWindowExists: false,
    windowFocused: false,
    visible: true,
    minimized: false,
    fullScreen: false,
  });
}
