import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { CancellationToken, ProgressInfo, UpdateCheckResult } from 'electron-updater';
import type { Logger } from '@main/logging/logger';
import { NoPublishedReleaseError, UpdateNetworkError } from '@main/updates/signed-release-provider';
import { UpdateVerificationError } from '@main/updates/update-manifest';
import {
  AUTOMATIC_CHECK_INTERVAL_MS,
  STARTUP_CHECK_DELAY_MS,
  UpdateService,
  type UpdateScheduler,
  type UpdateServiceDeps,
} from '@main/updates/update-service';
import { updateStateSchema, type UpdateState, type UpdateSupport } from '@shared/schemas/updates';

/**
 * The main-owned update state machine: checks are opt-out and coalesce,
 * nothing downloads without an explicit request, failures become fixed safe
 * states, and an install is only ever prepared from a finished download.
 */

const silentLog: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function checkResult(version: string, isUpdateAvailable: boolean): UpdateCheckResult {
  return {
    isUpdateAvailable,
    updateInfo: { version, releaseDate: '2026-10-01T12:00:00.000Z', files: [], path: 'x', sha512: 'y' },
    versionInfo: { version, releaseDate: '2026-10-01T12:00:00.000Z', files: [], path: 'x', sha512: 'y' },
  };
}

class FakeUpdater extends EventEmitter {
  checks: Deferred<UpdateCheckResult | null>[] = [];
  downloads: { token: CancellationToken; result: Deferred<string[]> }[] = [];
  readonly quitAndInstall = vi.fn();

  checkForUpdates(): Promise<UpdateCheckResult | null> {
    const next = deferred<UpdateCheckResult | null>();
    this.checks.push(next);
    return next.promise;
  }

  downloadUpdate(token?: CancellationToken): Promise<string[]> {
    const result = deferred<string[]>();
    if (token !== undefined) this.downloads.push({ token, result });
    return result.promise;
  }
}

type Timer = { readonly callback: () => void; readonly delayMs: number; cancelled: boolean };

/** Fires a scheduled timer the way setTimeout would: once, after which it is no longer pending. */
function fire(timer: Timer | undefined): void {
  if (timer === undefined) throw new Error('no timer');
  timer.cancelled = true;
  timer.callback();
}

function harness(overrides: Partial<UpdateServiceDeps> & { support?: UpdateSupport } = {}) {
  const updater = new FakeUpdater();
  const timers: Timer[] = [];
  const published: UpdateState[] = [];
  let nowMs = Date.parse('2026-10-09T00:00:00.000Z');
  const schedule: UpdateScheduler = (callback, delayMs) => {
    const timer: Timer = { callback, delayMs, cancelled: false };
    timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  };
  const createUpdater = vi.fn(() => updater);
  const service = new UpdateService({
    currentVersion: '1.2.2',
    support: 'self-update',
    trustConfigured: true,
    automaticChecks: true,
    createUpdater,
    stageInstall: () => Promise.resolve(),
    beforeInstall: () => undefined,
    publish: (state) => {
      expect(updateStateSchema.safeParse(state).success).toBe(true);
      published.push(state);
    },
    log: silentLog,
    now: () => new Date(nowMs),
    schedule,
    ...overrides,
  });
  const pending = (): Timer[] => timers.filter((timer) => !timer.cancelled);
  const advance = (ms: number): void => { nowMs += ms; };
  return { service, updater, createUpdater, timers, pending, published, advance };
}

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

async function availableHarness(overrides: Partial<UpdateServiceDeps> = {}) {
  const h = harness(overrides);
  const checking = h.service.check();
  h.updater.checks[0]?.resolve(checkResult('1.2.3', true));
  await checking;
  return h;
}

async function downloadedHarness(overrides: Partial<UpdateServiceDeps> = {}) {
  const h = await availableHarness(overrides);
  h.service.download();
  h.updater.downloads[0]?.result.resolve(['/tmp/update.zip']);
  await flush();
  return h;
}

describe('UpdateService checks', () => {
  it.each<UpdateSupport>(['development', 'package-manager', 'unsupported'])('never creates an updater or schedules for a %s install', async (support) => {
    const h = harness({ support });
    h.service.start();
    await expect(h.service.check()).resolves.toMatchObject({ support, phase: { status: 'idle' } });
    expect(h.createUpdater).not.toHaveBeenCalled();
    expect(h.pending()).toEqual([]);
  });

  it('fails closed without a pinned key and never creates an updater', async () => {
    const h = harness({ trustConfigured: false });
    await expect(h.service.check()).resolves.toMatchObject({ phase: { status: 'error', code: 'not-configured' } });
    expect(h.createUpdater).not.toHaveBeenCalled();
  });

  it('coalesces concurrent checks onto one request', async () => {
    const h = harness();
    const first = h.service.check();
    const second = h.service.check();
    expect(h.updater.checks).toHaveLength(1);
    h.updater.checks[0]?.resolve(checkResult('1.2.3', true));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.phase).toEqual({ status: 'available', version: '1.2.3', releaseDate: '2026-10-01T12:00:00.000Z' });
    expect(a.lastCheckedAt).toBe('2026-10-09T00:00:00.000Z');
    expect(h.published.map((state) => state.phase.status)).toEqual(['checking', 'available']);
  });

  it('distinguishes up to date from an empty destination', async () => {
    const h = harness();
    const upToDate = h.service.check();
    h.updater.checks[0]?.resolve(checkResult('1.2.2', false));
    await expect(upToDate).resolves.toMatchObject({ phase: { status: 'up-to-date', latestVersion: '1.2.2' } });
    const empty = h.service.check();
    h.updater.checks[1]?.reject(new NoPublishedReleaseError());
    await expect(empty).resolves.toMatchObject({ phase: { status: 'no-release' } });
  });

  it('maps offline and tampered feeds to fixed error states', async () => {
    const h = harness();
    const offline = h.service.check();
    h.updater.checks[0]?.reject(new UpdateNetworkError());
    await expect(offline).resolves.toMatchObject({ phase: { status: 'error', code: 'offline' } });
    const tampered = h.service.check();
    h.updater.checks[1]?.reject(new UpdateVerificationError('signature does not verify'));
    const state = await tampered;
    expect(state.phase).toMatchObject({ status: 'error', code: 'verification-failed' });
    expect(JSON.stringify(state)).not.toContain('signature does not verify');
  });

  it('checks after startup, then at the interval, and stops when automatic checks are turned off', async () => {
    const h = harness();
    h.service.start();
    expect(h.pending().map((timer) => timer.delayMs)).toEqual([STARTUP_CHECK_DELAY_MS]);
    fire(h.pending()[0]);
    h.updater.checks[0]?.resolve(checkResult('1.2.2', false));
    await flush();
    expect(h.pending().map((timer) => timer.delayMs)).toEqual([AUTOMATIC_CHECK_INTERVAL_MS]);
    h.service.setAutomaticChecks(false);
    expect(h.pending()).toEqual([]);
    expect(h.service.getState().automaticChecks).toBe(false);
    h.service.setAutomaticChecks(true);
    expect(h.pending().map((timer) => timer.delayMs)).toEqual([STARTUP_CHECK_DELAY_MS]);
  });

  it('does not arm automatic checks when the user opted out', () => {
    const h = harness({ automaticChecks: false });
    h.service.start();
    expect(h.pending()).toEqual([]);
  });

  it('cancels its timer and stops publishing once disposed', async () => {
    const h = harness();
    h.service.start();
    h.service.dispose();
    expect(h.pending()).toEqual([]);
    const count = h.published.length;
    await h.service.check();
    expect(h.published).toHaveLength(count);
  });
});

describe('UpdateService downloads', () => {
  it('downloads only on request, coalesces, and reports throttled progress', async () => {
    const h = await availableHarness();
    expect(h.updater.downloads).toHaveLength(0);
    h.service.download();
    expect(h.service.download().phase).toMatchObject({ status: 'downloading' });
    expect(h.updater.downloads).toHaveLength(1);
    const progress = (percent: number): ProgressInfo => ({ percent, total: 100, delta: 1, transferred: percent, bytesPerSecond: 1 });
    h.advance(300);
    h.updater.emit('download-progress', progress(12.345));
    h.updater.emit('download-progress', progress(50));
    expect(h.service.getState().phase).toEqual({ status: 'downloading', version: '1.2.3', percent: 12.3 });
    h.updater.downloads[0]?.result.resolve([]);
    await flush();
    expect(h.service.getState().phase).toEqual({ status: 'downloaded', version: '1.2.3' });
  });

  it('allows a retry after a transfer failure but needs a fresh check after an integrity failure', async () => {
    const h = await availableHarness();
    h.service.download();
    h.updater.downloads[0]?.result.reject(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await flush();
    expect(h.service.getState().phase).toMatchObject({ status: 'error', code: 'offline', version: '1.2.3' });
    h.updater.emit('error', new Error('reported separately'));
    h.service.download();
    expect(h.updater.downloads).toHaveLength(2);
    h.updater.downloads[1]?.result.reject(new Error('sha512 checksum mismatch'));
    await flush();
    expect(h.service.getState().phase).toMatchObject({ status: 'error', code: 'verification-failed', version: '1.2.3' });
    h.service.download();
    expect(h.updater.downloads).toHaveLength(2);
    const recheck = h.service.check();
    h.updater.checks[1]?.resolve(checkResult('1.2.3', true));
    await recheck;
    h.service.download();
    h.updater.downloads[2]?.result.resolve([]);
    await flush();
    expect(h.service.getState().phase).toEqual({ status: 'downloaded', version: '1.2.3' });
  });

  it('ignores download requests with nothing verified to download', () => {
    const h = harness();
    expect(h.service.download().phase).toEqual({ status: 'idle' });
    expect(h.createUpdater).not.toHaveBeenCalled();
  });

  it('cancels an in-flight download on dispose without publishing its outcome', async () => {
    const h = await availableHarness();
    h.service.download();
    h.service.dispose();
    expect(h.updater.downloads[0]?.token.cancelled).toBe(true);
    const count = h.published.length;
    h.updater.downloads[0]?.result.reject(new Error('cancelled'));
    await flush();
    expect(h.published).toHaveLength(count);
  });
});

describe('UpdateService install preparation', () => {
  it('is not ready before a download finishes', async () => {
    const h = await availableHarness();
    await expect(h.service.prepareInstall()).resolves.toEqual({ outcome: 'not-ready' });
  });

  it('stages, then installs without forcing a silent or deferred install', async () => {
    const order: string[] = [];
    const h = await downloadedHarness({
      stageInstall: () => { order.push('stage'); return Promise.resolve(); },
      beforeInstall: () => { order.push('before'); },
    });
    h.updater.quitAndInstall.mockImplementation(() => { order.push('quitAndInstall'); });
    const prepared = await h.service.prepareInstall();
    if (!('install' in prepared)) throw new Error('not prepared');
    expect(prepared.version).toBe('1.2.3');
    expect(h.service.getState().phase).toEqual({ status: 'installing', version: '1.2.3' });
    expect(order).toEqual(['stage']);
    prepared.install();
    expect(order).toEqual(['stage', 'before', 'quitAndInstall']);
    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('keeps running this version when staging fails', async () => {
    const h = await downloadedHarness({ stageInstall: () => Promise.reject(new Error('/private/path denied')) });
    const result = await h.service.prepareInstall();
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(JSON.stringify(result)).not.toContain('/private/path');
    expect(h.service.getState().phase).toMatchObject({ status: 'error', code: 'install-failed', version: '1.2.3' });
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('returns to downloaded when a prepared install is cancelled', async () => {
    const h = await downloadedHarness();
    await h.service.prepareInstall();
    h.service.cancelPreparedInstall();
    expect(h.service.getState().phase).toEqual({ status: 'downloaded', version: '1.2.3' });
  });
});
