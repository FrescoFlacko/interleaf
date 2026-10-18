import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppImageUpdater, MacUpdater, type AppUpdater, type Logger as UpdaterLogger } from 'electron-updater';
import type { Logger } from '../logging/logger';
import type { InstallType } from './install-type';
import type { SignedFeedOptions } from './signed-release-provider';

/**
 * The platform half of the updater: which electron-updater class runs this
 * install, with which fixed policy, and what has to be true before the app
 * may drain for an install.
 */

/** Native Squirrel.Mac events this module waits on; Electron's `autoUpdater` satisfies it. */
export type NativeMacUpdater = {
  checkForUpdates(): void;
  once(event: 'update-downloaded', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  removeListener(event: 'update-downloaded', listener: () => void): void;
  removeListener(event: 'error', listener: (error: Error) => void): void;
};

const MAC_STAGE_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATER_LOG_LIMIT = 300;

/**
 * Fixed updater policy. No setting, environment variable or renderer request
 * changes it: no automatic download, no install on quit, no downgrade, no
 * pre-release, no development feed. `channel` is never assigned because that
 * setter silently enables downgrades.
 *
 * `relaunchAfterInstall` is false only in a macOS update smoke build:
 * Squirrel.Mac relaunches through LaunchServices, which drops the isolated
 * profile the smoke run launched with, so the harness relaunches the installed
 * copy itself. (The AppImage installer relaunches with this process's own
 * environment, so the Linux smoke run keeps the real relaunch.)
 */
export function applyUpdaterPolicy(updater: AppUpdater, log: Logger, relaunchAfterInstall = true): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.forceDevUpdateConfig = false;
  updater.autoRunAppAfterInstall = relaunchAfterInstall;
  updater.logger = boundedUpdaterLogger(log);
}

/** electron-updater's own diagnostics, truncated and kept at debug level in the redacted app log. */
function boundedUpdaterLogger(log: Logger): UpdaterLogger {
  const write = (message?: string | Error): void => {
    const text = message instanceof Error ? `${message.name}: ${message.message}` : (message ?? '');
    log.debug(`[updater] ${text.split('\n', 1)[0]?.slice(0, UPDATER_LOG_LIMIT) ?? ''}`);
  };
  return { info: write, warn: write, error: write, debug: write };
}

export function createPlatformUpdater(installType: InstallType, feed: SignedFeedOptions, log: Logger, relaunchAfterInstall = true): AppUpdater {
  let updater: AppUpdater;
  if (installType.kind === 'mac') {
    updater = new MacUpdater(feed);
  } else if (installType.kind === 'appimage') {
    updater = new AppImageUpdater(feed);
  } else {
    throw new Error(`No updater for a ${installType.kind} install.`);
  }
  applyUpdaterPolicy(updater, log, relaunchAfterInstall);
  return updater;
}

/**
 * Has Squirrel.Mac fetch the verified ZIP from electron-updater's loopback
 * proxy and check its code signature against this app's designated
 * requirement. Only once it reports the update ready may the app drain, so a
 * rejected bundle leaves the user's work running untouched.
 */
export function stageMacInstall(native: NativeMacUpdater, timeoutMs = MAC_STAGE_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      native.removeListener('update-downloaded', onReady);
      native.removeListener('error', onError);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Squirrel.Mac did not stage the update in time.'));
    }, timeoutMs);
    native.once('update-downloaded', onReady);
    native.once('error', onError);
    native.checkForUpdates();
  });
}

/** electron-updater replaces `$APPIMAGE` in place, so its directory must be writable before anything drains. */
export async function stageAppImageInstall(env: Readonly<Record<string, string | undefined>>): Promise<void> {
  const appImage = env.APPIMAGE;
  if (appImage === undefined) throw new Error('Not running from an AppImage.');
  await access(appImage, fsConstants.F_OK);
  await access(dirname(appImage), fsConstants.W_OK);
}
