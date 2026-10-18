import { app } from 'electron';
import { readBrandEnv } from './brand-env';
import { defaultBrandIconPath } from './brand-icon';
import {
  legacyProfileAdoptionDecision,
  migrateLegacyUserDataProfile,
} from './legacy-profile-migration';
import { abortStartup, CONTINUE_STARTUP, type StartupDecision } from './startup-decision';
import { createLogger } from '../logging/logger';
import { isDevelopmentRun, type RuntimePackagingSignals } from './runtime-packaging';
import { APP_NAME } from '@shared/constants/brand';

/**
 * Brand-identity startup steps that must run in the main process, kept out of
 * the entry module so the bootstrap sequence there stays a flat list of calls.
 *
 * Everything here is main-owned: the renderer never supplies a path, a profile
 * location, or an icon, and nothing reads a caller-provided value.
 */

/**
 * Names the running process for everything Electron resolves from the app
 * name, the default `userData` location included.
 */
export function applyBrandIdentity(): void {
  app.setName(APP_NAME);
}

/**
 * Every identity step that has to run before `app.ready`, in order.
 *
 * The name comes first because it is what Electron's default `userData`
 * location is derived from: `<appData>/<app name>`. Naming the process only
 * once bootstrap is running would leave the profile decision below to whatever
 * name the process happened to start with, and macOS registers the process
 * before that point regardless.
 *
 * The OS-facing macOS identity is not set here and cannot be: `app.setName()`
 * overrides Electron's internal name only. A packaged run takes its Dock and
 * menu name from the Interleaf bundle, and a development run takes it from the
 * rebranded bundle prepared in `electron.dev-bundle.ts`.
 */
export function applyEarlyStartupIdentity(): StartupDecision {
  applyBrandIdentity();
  return applyUserDataProfileSelection();
}

/**
 * Chooses the profile directory this process will use, before `app.ready` and
 * therefore before anything opens a file under `userData`.
 *
 * With the isolation override set, that path is used verbatim and no migration
 * runs — an isolated test profile must stay empty and must never inherit real
 * user data. Otherwise a pre-rebrand `<appData>/MarginLab` profile is adopted
 * as `<appData>/Interleaf` so an existing user keeps their library,
 * annotations, chats, settings, credentials, and agent sessions.
 *
 * Durable logging is not configured this early, so the outcome reaches the
 * process log stream only. The returned decision is what makes the step fail
 * closed: an unsafe or half-applied profile stops bootstrap before any state
 * is created, instead of quietly starting on an empty profile that would look
 * to the user like their library had been erased.
 */
function applyUserDataProfileSelection(): StartupDecision {
  // Renderer processes cannot influence this env var; e2e suites set it so a
  // run never touches real user data.
  const isolatedUserData = readBrandEnv('USER_DATA');
  if (isolatedUserData !== undefined) {
    app.setPath('userData', isolatedUserData);
    return CONTINUE_STARTUP;
  }
  const log = createLogger('app');
  try {
    return legacyProfileAdoptionDecision(
      migrateLegacyUserDataProfile({ appDataRoot: app.getPath('appData'), log }),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    log.warn('legacy profile migration could not run', { reason });
    return abortStartup(`legacy profile adoption could not run: ${reason}`);
  }
}

/** This process's own signals; injected in tests, never caller-supplied. */
export function runtimePackagingSignals(): RuntimePackagingSignals {
  return { isPackaged: app.isPackaged, defaultApp: process.defaultApp };
}

/**
 * Gives an unpackaged macOS run the Interleaf Dock icon.
 *
 * A packaged bundle takes its Dock icon from the bundled `.icns` and must keep
 * it, so this is a development-only affordance. It covers both development
 * shapes: the stock-bundle fallback, which would otherwise show the Electron
 * icon, and the rebranded clone, whose own `.icns` this simply reasserts for
 * the running process. A missing raster is not an error — the platform default
 * applies.
 */
export function applyDevelopmentDockIcon(signals: RuntimePackagingSignals): void {
  if (!isDevelopmentRun(signals)) return;
  const iconPath = defaultBrandIconPath();
  if (iconPath === undefined) return;
  app.dock?.setIcon(iconPath);
}
