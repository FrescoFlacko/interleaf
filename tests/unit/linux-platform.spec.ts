import { describe, expect, it } from 'vitest';
import { APP_NAME } from '@shared/constants/brand';
import {
  applyLinuxRuntimeSwitches,
  linuxRuntimeSwitches,
  LINUX_WINDOW_CLASS,
  mergeEnableFeatures,
  type CommandLineSwitch,
} from '@main/app/linux-platform';

/**
 * Omarchy runs Hyprland on native Wayland, where Electron needs the platform
 * hint, client-side decorations, and the Wayland input method explicitly
 * enabled. These switches only take effect when they are appended before
 * `app.whenReady()`, and they must not change darwin or win32 startup.
 */

function names(switches: readonly CommandLineSwitch[]): readonly string[] {
  return switches.map((entry) => entry.name);
}

function valueOf(switches: readonly CommandLineSwitch[], name: string): string | undefined {
  return switches.find((entry) => entry.name === name)?.value;
}

describe('linux runtime switches', () => {
  it('enables Wayland platform detection, decorations, and IME on Linux', () => {
    const applied = linuxRuntimeSwitches({ platform: 'linux', env: {} });

    expect(names(applied)).toEqual([
      'ozone-platform-hint',
      'enable-features',
      'enable-wayland-ime',
      'class',
    ]);
    expect(valueOf(applied, 'ozone-platform-hint')).toBe('auto');
    expect(valueOf(applied, 'enable-features')).toBe('WaylandWindowDecorations');
    // Boolean switch: appended with no value.
    expect(applied.find((entry) => entry.name === 'enable-wayland-ime')?.value).toBeUndefined();
  });

  it('honours an explicit ELECTRON_OZONE_PLATFORM_HINT override', () => {
    const applied = linuxRuntimeSwitches({
      platform: 'linux',
      env: { ELECTRON_OZONE_PLATFORM_HINT: 'x11' },
    });

    expect(names(applied)).toEqual(['enable-features', 'enable-wayland-ime', 'class']);
  });

  it('treats a blank override as unset', () => {
    const applied = linuxRuntimeSwitches({
      platform: 'linux',
      env: { ELECTRON_OZONE_PLATFORM_HINT: '  ' },
    });

    expect(names(applied)).toContain('ozone-platform-hint');
  });

  it('sets the window class the desktop entry StartupWMClass must match', () => {
    const applied = linuxRuntimeSwitches({ platform: 'linux', env: {} });

    expect(LINUX_WINDOW_CLASS).toBe(APP_NAME);
    expect(valueOf(applied, 'class')).toBe('Interleaf');
  });

  it('appends nothing on darwin or win32', () => {
    expect(linuxRuntimeSwitches({ platform: 'darwin', env: {} })).toEqual([]);
    expect(linuxRuntimeSwitches({ platform: 'win32', env: {} })).toEqual([]);
    expect(
      linuxRuntimeSwitches({ platform: 'darwin', env: { ELECTRON_OZONE_PLATFORM_HINT: 'wayland' } }),
    ).toEqual([]);
  });
});

describe('enable-features merging', () => {
  it('keeps features another switch already requested', () => {
    expect(mergeEnableFeatures('SomeOtherFeature')).toBe(
      'SomeOtherFeature,WaylandWindowDecorations',
    );
    expect(mergeEnableFeatures('A, B ,')).toBe('A,B,WaylandWindowDecorations');
  });

  it('does not duplicate the Wayland feature', () => {
    expect(mergeEnableFeatures('WaylandWindowDecorations')).toBe('WaylandWindowDecorations');
  });

  it('handles an absent or empty existing value', () => {
    expect(mergeEnableFeatures(undefined)).toBe('WaylandWindowDecorations');
    expect(mergeEnableFeatures('')).toBe('WaylandWindowDecorations');
  });
});

describe('applying switches to the command line', () => {
  function recorder(existingEnableFeatures = ''): {
    readonly calls: string[];
    readonly commandLine: {
      getSwitchValue(name: string): string;
      appendSwitch(name: string, value?: string): void;
    };
  } {
    const calls: string[] = [];
    return {
      calls,
      commandLine: {
        getSwitchValue: (name: string) =>
          name === 'enable-features' ? existingEnableFeatures : '',
        appendSwitch: (name: string, value?: string) => {
          calls.push(value === undefined ? name : `${name}=${value}`);
        },
      },
    };
  }

  it('merges with an enable-features value already on the command line', () => {
    const { calls, commandLine } = recorder('ExistingFeature');

    applyLinuxRuntimeSwitches(commandLine, 'linux', {});

    expect(calls).toEqual([
      'ozone-platform-hint=auto',
      'enable-features=ExistingFeature,WaylandWindowDecorations',
      'enable-wayland-ime',
      `class=${APP_NAME}`,
    ]);
  });

  it('touches the command line on no other platform', () => {
    const darwin = recorder();
    applyLinuxRuntimeSwitches(darwin.commandLine, 'darwin', {});
    const windows = recorder();
    applyLinuxRuntimeSwitches(windows.commandLine, 'win32', {});

    expect(darwin.calls).toEqual([]);
    expect(windows.calls).toEqual([]);
  });
});
