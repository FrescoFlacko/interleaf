import { brandEnvFlagEnabled } from '../app/brand-env';
import { isDevelopmentRun, type RuntimePackagingSignals } from '../app/runtime-packaging';

/**
 * How the main window appears on screen.
 *
 * `foreground` is the application's only real behaviour: the window is shown
 * and the app is activated, so the reader's keyboard lands in it.
 *
 * `background` exists for the Electron end-to-end suite alone. A suite that
 * launches the app a few hundred times would otherwise take the keyboard and
 * the front of the desktop from whoever is working on the machine at every
 * launch. The window is still revealed, rendered and maximized to the same
 * work area — screenshots and layout assertions see exactly what a reader
 * sees — but it is ordered in without activating the app and, on macOS, at a
 * native level below every ordinary window, so it stays behind the user's
 * work; the test Dock icon is withdrawn too. It is not headless, and other
 * platforms get the non-activating reveal only (unverified there).
 *
 * Main decides this from its own environment and packaging signals. Nothing in
 * the renderer can see or change it.
 */
export type WindowRevealMode = 'foreground' | 'background';

/**
 * `background` only when every gate holds: an explicit `INTERLEAF_E2E_BACKGROUND=1`,
 * `NODE_ENV=test`, and a development run. A packaged build never honours it,
 * whatever its environment; a renamed development bundle reports
 * `isPackaged` but still counts as development (see `runtime-packaging.ts`).
 */
export function windowRevealMode(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly signals: RuntimePackagingSignals;
}): WindowRevealMode {
  if (input.env.NODE_ENV !== 'test') return 'foreground';
  if (!isDevelopmentRun(input.signals)) return 'foreground';
  return brandEnvFlagEnabled('E2E_BACKGROUND', input.env) ? 'background' : 'foreground';
}

/** The window-level call a background reveal uses; a `BrowserWindow` satisfies it. */
type LevelledWindow = {
  setAlwaysOnTop(flag: boolean, level: 'normal', relativeLevel: number): void;
};

/**
 * On macOS, puts the window one native level below every ordinary window
 * (`NSNormalWindowLevel - 1`), so it sits behind whatever the user has open
 * however it is ordered. Despite the method's name this is the opposite of
 * always-on-top: `'normal'` with a relative level of `-1` is a level *below*
 * normal. It must precede the first `maximize()` or reveal, because both order
 * a hidden window in, and a later lowering would let it flash in front. Other
 * platforms have no such level and are left untouched (unverified there).
 */
function keepBelowOrdinaryWindows(window: LevelledWindow, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin') window.setAlwaysOnTop(true, 'normal', -1);
}

/** The window operations a background reveal uses; a `BrowserWindow` satisfies it. */
export type BackgroundRevealWindow = LevelledWindow & {
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  showInactive(): void;
};

/**
 * Brings an existing main window back for a Dock click, a second launch or an
 * operating-system open request without activating the app: the window is
 * kept below ordinary windows, made sure to be on screen and never made key.
 * The foreground route keeps the coordinator's own restore-and-focus.
 */
export function revealInBackground(window: BackgroundRevealWindow, platform: NodeJS.Platform = process.platform): void {
  keepBelowOrdinaryWindows(window, platform);
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.showInactive();
}

/**
 * The reveal the lifecycle coordinator uses for an existing window:
 * `undefined` keeps its own restore-and-focus.
 */
export function existingWindowReveal(mode: WindowRevealMode): typeof revealInBackground | undefined {
  return mode === 'background' ? revealInBackground : undefined;
}

/** The window operations a new window's first reveal uses. */
export type NewRevealWindow = LevelledWindow & {
  maximize(): void;
  show(): void;
  showInactive(): void;
};

/**
 * A new window's first reveal, once its content is ready: maximized to the
 * work area, then shown. The foreground reveal activates the app. The
 * background reveal first drops the window below ordinary windows (macOS),
 * then orders the same maximized window in without activating the app;
 * `maximize()` itself never activates it.
 */
export function revealNewWindow(
  window: NewRevealWindow,
  mode: WindowRevealMode = 'foreground',
  platform: NodeJS.Platform = process.platform,
): void {
  if (mode === 'foreground') {
    window.maximize();
    window.show();
    return;
  }
  keepBelowOrdinaryWindows(window, platform);
  window.maximize();
  window.showInactive();
}
