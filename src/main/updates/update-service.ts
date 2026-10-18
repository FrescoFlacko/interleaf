import { CancellationToken, type ProgressInfo, type UpdateCheckResult } from 'electron-updater';
import type { Logger } from '../logging/logger';
import { RETRYABLE_DOWNLOAD_ERRORS, type UpdatePhase, type UpdateRestartResult, type UpdateState, type UpdateSupport } from '@shared/schemas/updates';
import { classifyUpdateError, errorLogMeta, updateErrorMessage } from './update-errors';
import { NoPublishedReleaseError } from './signed-release-provider';

/**
 * The main-owned application-update state machine.
 *
 * It wraps one electron-updater updater (created lazily, only for a
 * self-updating install with a pinned signing key) and projects its progress
 * into the bounded `UpdateState` the renderer reads. Policy lives here:
 *
 * - automatic checks run after startup and then at a restrained interval, only
 *   while enabled, and never overlap a manual check;
 * - downloads start only from an explicit request, and concurrent requests
 *   coalesce onto the one in flight;
 * - installing is a separate, main-validated step (`prepareInstall`) that the
 *   shutdown barrier runs only after it has drained the window and services.
 *
 * A development run, a package-manager install or an unsupported install
 * never creates an updater, so it never contacts the feed.
 */

/** The part of an electron-updater `AppUpdater` this service drives. */
export type UpdaterPort = {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(cancellationToken?: CancellationToken): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  removeListener(event: 'download-progress', listener: (progress: ProgressInfo) => void): void;
  removeListener(event: 'error', listener: (error: Error) => void): void;
};

export type TimerHandle = { readonly cancel: () => void };
export type UpdateScheduler = (callback: () => void, delayMs: number) => TimerHandle;

export type UpdateServiceDeps = {
  readonly currentVersion: string;
  readonly support: UpdateSupport;
  /** False when the build pins no signing key: checks fail closed without any network request. */
  readonly trustConfigured: boolean;
  readonly automaticChecks: boolean;
  readonly createUpdater: () => UpdaterPort;
  /** Platform preparation that must succeed before the app drains (Squirrel.Mac staging, AppImage writability). */
  readonly stageInstall: () => Promise<void>;
  /** Runs synchronously right before the updater's own quit-and-install. */
  readonly beforeInstall: () => void;
  readonly publish: (state: UpdateState) => void;
  readonly log: Logger;
  readonly now?: () => Date;
  readonly schedule?: UpdateScheduler;
};

export type PreparedInstall = { readonly version: string; readonly install: () => void };

export const STARTUP_CHECK_DELAY_MS = 60_000;
export const AUTOMATIC_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PROGRESS_PUBLISH_INTERVAL_MS = 250;

const defaultSchedule: UpdateScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return { cancel: () => { clearTimeout(timer); } };
};

const BUSY_STATUSES: ReadonlySet<UpdatePhase['status']> = new Set(['checking', 'downloading', 'downloaded', 'installing']);

export class UpdateService {
  private phase: UpdatePhase = { status: 'idle' };
  private lastCheckedAt: string | null = null;
  private automaticChecks: boolean;
  private updater: UpdaterPort | undefined;
  private checkInFlight: Promise<UpdateState> | undefined;
  private downloadToken: CancellationToken | undefined;
  private timer: TimerHandle | undefined;
  private lastProgressAt = 0;
  private disposed = false;
  private readonly now: () => Date;
  private readonly schedule: UpdateScheduler;
  private readonly onProgress = (progress: ProgressInfo): void => {
    this.handleProgress(progress);
  };
  private readonly onUpdaterError = (error: Error): void => {
    this.deps.log.debug('Updater reported an error', errorLogMeta(error));
  };

  constructor(private readonly deps: UpdateServiceDeps) {
    this.automaticChecks = deps.automaticChecks;
    this.now = deps.now ?? (() => new Date());
    this.schedule = deps.schedule ?? defaultSchedule;
  }

  getState(): UpdateState {
    return {
      currentVersion: this.deps.currentVersion,
      channel: 'stable',
      support: this.deps.support,
      automaticChecks: this.automaticChecks,
      lastCheckedAt: this.lastCheckedAt,
      phase: this.phase,
    };
  }

  /** Arms the first automatic check; a no-op unless this install updates itself and checks are on. */
  start(): void {
    this.rescheduleAutomaticCheck(STARTUP_CHECK_DELAY_MS);
  }

  setAutomaticChecks(enabled: boolean): void {
    if (enabled === this.automaticChecks) return;
    this.automaticChecks = enabled;
    this.rescheduleAutomaticCheck(enabled ? STARTUP_CHECK_DELAY_MS : null);
    this.publish();
  }

  check(): Promise<UpdateState> {
    if (this.deps.support !== 'self-update' || this.disposed) return Promise.resolve(this.getState());
    if (this.checkInFlight !== undefined) return this.checkInFlight;
    if (BUSY_STATUSES.has(this.phase.status)) return Promise.resolve(this.getState());
    if (!this.deps.trustConfigured) {
      this.setError('not-configured');
      return Promise.resolve(this.getState());
    }
    this.setPhase({ status: 'checking' });
    const inFlight = this.runCheck().finally(() => {
      this.checkInFlight = undefined;
    });
    this.checkInFlight = inFlight;
    return inFlight;
  }

  /** Starts (or joins) the download of the verified available update and returns at once. */
  download(): UpdateState {
    const version = this.downloadableVersion();
    if (version === undefined || this.updater === undefined || this.disposed) return this.getState();
    const token = new CancellationToken();
    this.downloadToken = token;
    this.lastProgressAt = 0;
    this.setPhase({ status: 'downloading', version, percent: 0 });
    void this.runDownload(this.updater, token, version);
    return this.getState();
  }

  /**
   * Main-side validation and platform staging for an explicit restart. The
   * caller has already confirmed no agent, chat or import work is running.
   */
  async prepareInstall(): Promise<PreparedInstall | UpdateRestartResult> {
    const { phase, updater } = this;
    if (phase.status !== 'downloaded' || updater === undefined || this.disposed) return { outcome: 'not-ready' };
    this.setPhase({ status: 'installing', version: phase.version });
    try {
      await this.deps.stageInstall();
    } catch (error) {
      this.deps.log.warn('Update could not be staged for installation', errorLogMeta(error instanceof Error ? error : null));
      this.setError('install-failed', phase.version);
      return { outcome: 'failed', message: updateErrorMessage('install-failed') };
    }
    return {
      version: phase.version,
      install: () => {
        this.deps.beforeInstall();
        updater.quitAndInstall(false, true);
      },
    };
  }

  /** Returns a staged restart to the downloaded state, for example when the drain was refused. */
  cancelPreparedInstall(): void {
    if (this.phase.status === 'installing') this.setPhase({ status: 'downloaded', version: this.phase.version });
  }

  dispose(): void {
    this.disposed = true;
    this.timer?.cancel();
    this.timer = undefined;
    this.downloadToken?.cancel();
    this.updater?.removeListener('download-progress', this.onProgress);
    this.updater?.removeListener('error', this.onUpdaterError);
  }

  private downloadableVersion(): string | undefined {
    const { phase } = this;
    if (phase.status === 'available') return phase.version;
    if (phase.status === 'error' && RETRYABLE_DOWNLOAD_ERRORS.has(phase.code)) return phase.version;
    return undefined;
  }

  private ensureUpdater(): UpdaterPort {
    if (this.updater === undefined) {
      const updater = this.deps.createUpdater();
      updater.on('download-progress', this.onProgress);
      updater.on('error', this.onUpdaterError);
      this.updater = updater;
    }
    return this.updater;
  }

  private async runCheck(): Promise<UpdateState> {
    try {
      const result = await this.ensureUpdater().checkForUpdates();
      this.lastCheckedAt = this.now().toISOString();
      this.setPhase(phaseForCheckResult(result));
    } catch (error) {
      this.handleCheckFailure(error instanceof Error ? error : null);
    }
    return this.getState();
  }

  private handleCheckFailure(error: Error | null): void {
    if (error instanceof NoPublishedReleaseError) {
      this.lastCheckedAt = this.now().toISOString();
      this.setPhase({ status: 'no-release' });
      return;
    }
    this.deps.log.info('Update check failed', errorLogMeta(error));
    this.setError(classifyUpdateError(error, 'check'));
  }

  private async runDownload(updater: UpdaterPort, token: CancellationToken, version: string): Promise<void> {
    try {
      await updater.downloadUpdate(token);
      if (this.downloadToken === token && !this.disposed) this.setPhase({ status: 'downloaded', version });
    } catch (error) {
      if (this.downloadToken !== token || this.disposed) return;
      const caught = error instanceof Error ? error : null;
      this.deps.log.warn('Update download failed', errorLogMeta(caught));
      this.setError(classifyUpdateError(caught, 'download'), version);
    }
  }

  private handleProgress(progress: ProgressInfo): void {
    const { phase } = this;
    if (phase.status !== 'downloading') return;
    const nowMs = this.now().getTime();
    if (nowMs - this.lastProgressAt < PROGRESS_PUBLISH_INTERVAL_MS) return;
    this.lastProgressAt = nowMs;
    const percent = Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, Math.round(progress.percent * 10) / 10)) : 0;
    this.setPhase({ status: 'downloading', version: phase.version, percent });
  }

  private rescheduleAutomaticCheck(delayMs: number | null): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (delayMs === null || !this.automaticChecks || this.deps.support !== 'self-update' || this.disposed) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.check().finally(() => {
        this.rescheduleAutomaticCheck(AUTOMATIC_CHECK_INTERVAL_MS);
      });
    }, delayMs);
  }

  private setError(code: Parameters<typeof updateErrorMessage>[0], version?: string): void {
    const message = updateErrorMessage(code);
    this.setPhase(version === undefined ? { status: 'error', code, message } : { status: 'error', code, message, version });
  }

  private setPhase(phase: UpdatePhase): void {
    this.phase = phase;
    this.publish();
  }

  private publish(): void {
    if (!this.disposed) this.deps.publish(this.getState());
  }
}

function phaseForCheckResult(result: UpdateCheckResult | null): UpdatePhase {
  if (result === null) return { status: 'idle' };
  const { updateInfo } = result;
  if (result.isUpdateAvailable) return { status: 'available', version: updateInfo.version, releaseDate: updateInfo.releaseDate };
  return { status: 'up-to-date', latestVersion: updateInfo.version };
}
