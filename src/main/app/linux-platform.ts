import { APP_NAME } from '@shared/constants/brand';

/**
 * Linux/Wayland runtime switches, decided as data so the decision itself is
 * unit-testable without Electron.
 *
 * Nothing here imports `electron`: the module is loaded by `src/main/index.ts`
 * before `app.whenReady()`, and Chromium only honours these switches when they
 * are appended that early. The caller supplies the platform, an environment
 * snapshot, and whatever `enable-features` value is already on the command
 * line; this module reads no ambient state and never takes a renderer-supplied
 * value.
 *
 * Why each switch:
 * - `ozone-platform-hint=auto` lets Electron pick native Wayland on a Wayland
 *   session (Omarchy/Hyprland) and fall back to X11 elsewhere.
 * - `WaylandWindowDecorations` gives client-side decorations on compositors
 *   such as Hyprland, which draw no server-side frame.
 * - `enable-wayland-ime` routes input-method text (fcitx5/ibus) into Chromium.
 * - `class=Interleaf` pins the X11 `WM_CLASS` (XWayland fallback) to the same
 *   value as the desktop entry's `StartupWMClass`. The Wayland `app_id` is not
 *   set by this switch: Electron derives it from its desktop name, which
 *   package.json pins as `desktopName` (`Interleaf.desktop`), and
 *   electron-builder installs the entry under that same file name
 *   (`linux.executableName`), so all three identities agree.
 */

/** X11 `WM_CLASS` this process presents on Linux; equals the Wayland app_id Electron derives from package.json `desktopName`. */
export const LINUX_WINDOW_CLASS: string = APP_NAME;

/** Chromium feature required for client-side decorations under Wayland. */
const WAYLAND_WINDOW_DECORATIONS_FEATURE = 'WaylandWindowDecorations' as const;

/** A switch to append verbatim; `value` absent means a boolean switch. */
export type CommandLineSwitch = {
  readonly name: string;
  readonly value?: string | undefined;
};

/** Process environment snapshot; only read, never mutated. */
export type PlatformEnvironment = Readonly<Record<string, string | undefined>>;

export type LinuxSwitchInputs = {
  readonly platform: NodeJS.Platform;
  readonly env: PlatformEnvironment;
  /**
   * `enable-features` already present on the command line, if any. Merged with
   * the Wayland feature so an existing value is never clobbered.
   */
  readonly existingEnableFeatures?: string | undefined;
};

/**
 * The Chromium switches this process should append on Linux, in order.
 *
 * Returns an empty list on every other platform, so darwin and win32 startup
 * is unchanged. An explicit `ELECTRON_OZONE_PLATFORM_HINT` in the environment
 * is a deliberate user override and suppresses the platform hint switch.
 */
export function linuxRuntimeSwitches(inputs: LinuxSwitchInputs): readonly CommandLineSwitch[] {
  if (inputs.platform !== 'linux') return [];

  const switches: CommandLineSwitch[] = [];
  if (!hasUserOzoneOverride(inputs.env)) {
    switches.push({ name: 'ozone-platform-hint', value: 'auto' });
  }
  switches.push({
    name: 'enable-features',
    value: mergeEnableFeatures(inputs.existingEnableFeatures),
  });
  switches.push({ name: 'enable-wayland-ime' });
  switches.push({ name: 'class', value: LINUX_WINDOW_CLASS });
  return switches;
}

function hasUserOzoneOverride(env: PlatformEnvironment): boolean {
  const hint = env.ELECTRON_OZONE_PLATFORM_HINT;
  return hint !== undefined && hint.trim() !== '';
}

/**
 * Adds the Wayland decoration feature to an existing comma-separated
 * `enable-features` list, preserving order and dropping duplicates.
 */
export function mergeEnableFeatures(existing: string | undefined): string {
  const features = (existing ?? '')
    .split(',')
    .map((feature) => feature.trim())
    .filter((feature) => feature !== '');
  if (!features.includes(WAYLAND_WINDOW_DECORATIONS_FEATURE)) {
    features.push(WAYLAND_WINDOW_DECORATIONS_FEATURE);
  }
  return features.join(',');
}

/**
 * The slice of `app.commandLine` this module needs. Structural, so the module
 * still imports nothing from Electron.
 */
export type CommandLineSwitches = {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value?: string): void;
};

/**
 * Appends the Linux switches to the running process, reading the current
 * `enable-features` value first so an existing one is merged, not replaced.
 *
 * Must be called at module load, before `app.whenReady()`: Chromium reads
 * these once during initialization. Returns what was appended, for logging
 * and tests.
 */
export function applyLinuxRuntimeSwitches(
  commandLine: CommandLineSwitches,
  platform: NodeJS.Platform,
  env: PlatformEnvironment,
): readonly CommandLineSwitch[] {
  if (platform !== 'linux') return [];
  const applied = linuxRuntimeSwitches({
    platform,
    env,
    existingEnableFeatures: commandLine.getSwitchValue('enable-features'),
  });
  for (const entry of applied) {
    if (entry.value === undefined) {
      commandLine.appendSwitch(entry.name);
    } else {
      commandLine.appendSwitch(entry.name, entry.value);
    }
  }
  return applied;
}
