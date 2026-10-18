import { readFileSync, statSync } from 'node:fs';
import type { UpdateReleasePageResult, UpdateRestartResult, UpdateState } from '@shared/schemas/updates';
import type { Logger } from '../logging/logger';
import { hasActiveWork, type ActiveWork } from '../app/active-work';
import { isDevelopmentRun, type RuntimePackagingSignals } from '../app/runtime-packaging';
import { detectInstallType, updateSupportFor, type InstallFacts, type InstallType } from './install-type';
import { createManifestFetcher, type FetchLike } from './manifest-fetch';
import { createPlatformUpdater, stageAppImageInstall, stageMacInstall, type NativeMacUpdater } from './platform-updater';
import { signedFeedOptions } from './signed-release-provider';
import { buildUpdateTrust, isSmokeBuild } from './smoke-trust';
import { releasePageUrl, type UpdateTrust } from './update-trust';
import { UpdateService } from './update-service';

/**
 * Composes the update feature for main: the install type read from this
 * process, the pinned trust anchor, the signed provider, the platform updater
 * and the restart rules. The IPC handlers reach only the `UpdateController`
 * this returns, so no renderer request can name a feed, a file or a command.
 */

export type UpdateController = {
  getState(): UpdateState;
  check(): Promise<UpdateState>;
  download(): UpdateState;
  restart(): Promise<UpdateRestartResult>;
  openReleasePage(): Promise<UpdateReleasePageResult>;
  setAutomaticChecks(enabled: boolean): void;
  start(): void;
  dispose(): void;
};

export type UpdateRuntimeDeps = {
  readonly currentVersion: string;
  /** A renamed development bundle reports `isPackaged`; `defaultApp` still marks it as development. */
  readonly packaging: RuntimePackagingSignals;
  readonly automaticChecks: boolean;
  readonly fetch: FetchLike;
  readonly nativeMacUpdater: NativeMacUpdater;
  /** The AppImage installer starts the new copy before this one exits; it must not find the single-instance lock held. */
  readonly releaseSingleInstanceLock: () => void;
  readonly activeWork: ActiveWork;
  /**
   * Reserves the shutdown barrier for this update, or returns false. On success
   * it has already called `closeAdmission` synchronously, before the renderer
   * handshake, and runs `install` in place of the final quit after the drain.
   */
  readonly requestQuitForUpdate: (install: () => void, closeAdmission: () => void) => boolean;
  readonly openExternal: (url: string) => Promise<void>;
  readonly publish: (state: UpdateState) => void;
  readonly log: Logger;
  readonly trust?: UpdateTrust;
  readonly facts?: InstallFacts;
};

const MAX_PACKAGE_TYPE_BYTES = 64;

function readSmallFile(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_PACKAGE_TYPE_BYTES) return '';
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

export function processInstallFacts(packaging: RuntimePackagingSignals): InstallFacts {
  return {
    platform: process.platform,
    arch: process.arch,
    isDevelopment: isDevelopmentRun(packaging),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    env: process.env,
    readSmallFile,
  };
}

function stagingFor(installType: InstallType, deps: UpdateRuntimeDeps): () => Promise<void> {
  if (installType.kind === 'mac') return () => stageMacInstall(deps.nativeMacUpdater);
  return () => stageAppImageInstall(process.env);
}

/**
 * Checks for running work before and after platform staging: Squirrel.Mac can
 * take a while, and work started meanwhile must not be cut off. The final
 * probe, the barrier reservation and the admission close happen in one
 * synchronous step, so no new work can be accepted between the last idle
 * reading and the drain.
 */
export async function restartToUpdate(
  service: Pick<UpdateService, 'prepareInstall' | 'cancelPreparedInstall'>,
  deps: Pick<UpdateRuntimeDeps, 'activeWork' | 'requestQuitForUpdate'>,
): Promise<UpdateRestartResult> {
  const before = deps.activeWork.probe();
  if (hasActiveWork(before)) return { outcome: 'blocked', activeWork: before };
  const prepared = await service.prepareInstall();
  if (!('install' in prepared)) return prepared;
  const after = deps.activeWork.probe();
  if (hasActiveWork(after)) {
    service.cancelPreparedInstall();
    return { outcome: 'blocked', activeWork: after };
  }
  if (!deps.requestQuitForUpdate(prepared.install, deps.activeWork.closeAdmission)) {
    service.cancelPreparedInstall();
    return { outcome: 'not-ready' };
  }
  return { outcome: 'restarting', version: prepared.version };
}

export function createUpdateRuntime(deps: UpdateRuntimeDeps): UpdateController {
  const trust = deps.trust ?? buildUpdateTrust();
  if (isSmokeBuild()) deps.log.warn('Update smoke build: updates are trusted only from a loopback test origin');
  const installType = detectInstallType(deps.facts ?? processInstallFacts(deps.packaging));
  const support = updateSupportFor(installType);
  const service = new UpdateService({
    currentVersion: deps.currentVersion,
    support,
    trustConfigured: trust.signingKeys.length > 0,
    automaticChecks: deps.automaticChecks,
    createUpdater: () => {
      const platform = installType.kind === 'mac' ? 'darwin' : 'linux';
      const arch = installType.kind === 'mac' ? installType.arch : 'x64';
      const feed = signedFeedOptions({ trust, platform, arch, fetchManifest: createManifestFetcher(deps.fetch) });
      return createPlatformUpdater(installType, feed, deps.log, !(isSmokeBuild() && platform === 'darwin'));
    },
    stageInstall: stagingFor(installType, deps),
    beforeInstall: installType.kind === 'appimage' ? deps.releaseSingleInstanceLock : () => undefined,
    publish: deps.publish,
    log: deps.log,
  });
  deps.log.info('Update support resolved', { installType: installType.kind, support });
  return {
    getState: () => service.getState(),
    check: () => service.check(),
    download: () => service.download(),
    restart: () => restartToUpdate(service, deps),
    openReleasePage: async () => {
      try {
        await deps.openExternal(releasePageUrl(trust));
        return { opened: true };
      } catch {
        return { opened: false };
      }
    },
    setAutomaticChecks: (enabled) => { service.setAutomaticChecks(enabled); },
    start: () => { service.start(); },
    dispose: () => { service.dispose(); },
  };
}
