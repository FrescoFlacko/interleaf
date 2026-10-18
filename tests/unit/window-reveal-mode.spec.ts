import { describe, expect, it } from 'vitest';
import {
  existingWindowReveal,
  revealInBackground,
  revealNewWindow,
  windowRevealMode,
} from '@main/windows/window-reveal-mode';

/**
 * The E2E background window mode is a main-owned test switch: it needs the
 * explicit flag, `NODE_ENV=test` and a development run together, and every
 * other launch keeps the activating foreground reveal.
 */
const DEVELOPMENT = { isPackaged: false, defaultApp: true } as const;
const RENAMED_DEVELOPMENT_BUNDLE = { isPackaged: true, defaultApp: true } as const;
const PACKAGED = { isPackaged: true, defaultApp: undefined } as const;
/** `setAlwaysOnTop(true, 'normal', -1)`: one native level below ordinary windows. */
const BELOW_ORDINARY = 'setAlwaysOnTop:true:normal:-1';

describe('window reveal mode', () => {
  it('is background only for an explicit flag under NODE_ENV=test in a development run', () => {
    const env = { NODE_ENV: 'test', INTERLEAF_E2E_BACKGROUND: '1' };
    expect(windowRevealMode({ env, signals: DEVELOPMENT })).toBe('background');
    expect(windowRevealMode({ env, signals: { isPackaged: false, defaultApp: undefined } })).toBe('background');
    expect(windowRevealMode({ env, signals: RENAMED_DEVELOPMENT_BUNDLE })).toBe('background');
  });

  it('stays foreground for a packaged build whatever its environment', () => {
    const env = { NODE_ENV: 'test', INTERLEAF_E2E_BACKGROUND: '1' };
    expect(windowRevealMode({ env, signals: PACKAGED })).toBe('foreground');
    expect(windowRevealMode({ env, signals: { isPackaged: true, defaultApp: false } })).toBe('foreground');
  });

  it('stays foreground outside NODE_ENV=test', () => {
    for (const NODE_ENV of [undefined, 'development', 'production', 'TEST']) {
      const env = { INTERLEAF_E2E_BACKGROUND: '1', ...(NODE_ENV === undefined ? {} : { NODE_ENV }) };
      expect(windowRevealMode({ env, signals: DEVELOPMENT })).toBe('foreground');
    }
  });

  it('stays foreground unless the flag is exactly 1, which is how the suite asks for foreground', () => {
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      const env = { NODE_ENV: 'test', ...(value === undefined ? {} : { INTERLEAF_E2E_BACKGROUND: value }) };
      expect(windowRevealMode({ env, signals: DEVELOPMENT })).toBe('foreground');
    }
  });
});

describe('background reveal of an existing window', () => {
  function fakeWindow(state: { visible: boolean; minimized: boolean }): { calls: string[]; window: Parameters<typeof revealInBackground>[0] } {
    const calls: string[] = [];
    return {
      calls,
      window: {
        isVisible: () => state.visible,
        isMinimized: () => state.minimized,
        restore: () => { calls.push('restore'); state.minimized = false; },
        showInactive: () => { calls.push('showInactive'); state.visible = true; },
        setAlwaysOnTop: (flag: boolean, level: string, relativeLevel: number) => {
          calls.push(`setAlwaysOnTop:${String(flag)}:${level}:${String(relativeLevel)}`);
        },
      },
    };
  }

  it('keeps a visible window below ordinary windows and otherwise where it is', () => {
    const { calls, window } = fakeWindow({ visible: true, minimized: false });
    revealInBackground(window, 'darwin');
    expect(calls).toEqual([BELOW_ORDINARY]);
  });

  it('lowers a hidden window before ordering it in without activating it', () => {
    const { calls, window } = fakeWindow({ visible: false, minimized: false });
    revealInBackground(window, 'darwin');
    expect(calls).toEqual([BELOW_ORDINARY, 'showInactive']);
  });

  it('lowers a minimized window before restoring it', () => {
    const { calls, window } = fakeWindow({ visible: true, minimized: true });
    revealInBackground(window, 'darwin');
    expect(calls).toEqual([BELOW_ORDINARY, 'restore']);
  });

  it('changes no window level off macOS', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const { calls, window } = fakeWindow({ visible: false, minimized: true });
      revealInBackground(window, platform);
      expect(calls).toEqual(['restore', 'showInactive']);
    }
  });
});

describe('reveal routes', () => {
  it('replaces the coordinator restore-and-focus only in background mode', () => {
    expect(existingWindowReveal('background')).toBe(revealInBackground);
    expect(existingWindowReveal('foreground')).toBeUndefined();
  });

  const record = (calls: string[]) => ({
    maximize: () => { calls.push('maximize'); },
    show: () => { calls.push('show'); },
    showInactive: () => { calls.push('showInactive'); },
    setAlwaysOnTop: (flag: boolean, level: string, relativeLevel: number) => {
      calls.push(`setAlwaysOnTop:${String(flag)}:${level}:${String(relativeLevel)}`);
    },
  });

  it('keeps the activating maximize-then-show foreground reveal on every platform, never changing the level', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const defaulted: string[] = [];
      const foreground: string[] = [];
      revealNewWindow(record(defaulted), undefined, platform);
      revealNewWindow(record(foreground), 'foreground', platform);
      expect(defaulted).toEqual(['maximize', 'show']);
      expect(foreground).toEqual(['maximize', 'show']);
    }
  });

  it('lowers a new background window on macOS before it is maximized or ordered in', () => {
    const calls: string[] = [];
    revealNewWindow(record(calls), 'background', 'darwin');
    expect(calls).toEqual([BELOW_ORDINARY, 'maximize', 'showInactive']);
  });

  it('reveals a new background window without activating it or changing its level off macOS', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const calls: string[] = [];
      revealNewWindow(record(calls), 'background', platform);
      expect(calls).toEqual(['maximize', 'showInactive']);
    }
  });
});
