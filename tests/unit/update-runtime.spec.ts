import { describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_EVENTS } from '@shared/constants/ipc';
import type { CloneableValue } from '@shared/models/portable';
import type { ActiveWorkSummary } from '@shared/schemas/updates';
import { closeHandshakePayloadSchema } from '@shared/schemas/app-lifecycle';
import type { Logger } from '@main/logging/logger';
import { createActiveWork, hasActiveWork, type ActiveWork } from '@main/app/active-work';
import { ShutdownBarrier, type BarrierWindow } from '@main/app/shutdown-barrier';
import { WorkAdmission } from '@main/app/work-admission';
import { detectInstallType, updateSupportFor, type InstallFacts } from '@main/updates/install-type';
import { applyUpdaterPolicy, createPlatformUpdater, stageMacInstall, type NativeMacUpdater } from '@main/updates/platform-updater';
import { createUpdateRuntime, processInstallFacts, restartToUpdate, type UpdateRuntimeDeps } from '@main/updates/update-runtime';
import { UPDATE_TRUST } from '@main/updates/update-trust';
import type { PreparedInstall } from '@main/updates/update-service';
import type { AppUpdater } from 'electron-updater';

/**
 * How main decides whether this copy may update itself, refuses to restart
 * over running work, and installs only after the shutdown barrier has flushed
 * the window and drained every service.
 */

vi.mock('@main/updates/platform-updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/updates/platform-updater')>();
  return { ...actual, createPlatformUpdater: vi.fn(actual.createPlatformUpdater) };
});

const silentLog: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const IDLE: ActiveWorkSummary = { agentSessions: 0, chatStreams: 0, imports: 0 };

function work(...summaries: ActiveWorkSummary[]): ActiveWork & { readonly closeAdmission: Mock<() => void> } {
  const probe = vi.fn(() => summaries.length > 1 ? summaries.shift() ?? IDLE : summaries[0] ?? IDLE);
  return { probe, closeAdmission: vi.fn<() => void>() };
}

function facts(overrides: Partial<InstallFacts>): InstallFacts {
  return {
    platform: 'darwin',
    arch: 'arm64',
    isDevelopment: false,
    execPath: '/Applications/Interleaf.app/Contents/MacOS/Interleaf',
    resourcesPath: '/Applications/Interleaf.app/Contents/Resources',
    env: {},
    readSmallFile: () => undefined,
    ...overrides,
  };
}

const appImage = (overrides: Partial<InstallFacts> = {}): InstallFacts =>
  facts({
    platform: 'linux',
    arch: 'x64',
    execPath: '/tmp/.mount_Interl/interleaf',
    resourcesPath: '/tmp/.mount_Interl/resources',
    env: { APPIMAGE: '/home/u/Apps/Interleaf.AppImage', APPDIR: '/tmp/.mount_Interl' },
    ...overrides,
  });

describe('detectInstallType', () => {
  it('lets only a packaged macOS bundle or an x64 AppImage update itself', () => {
    expect(detectInstallType(facts({}))).toEqual({ kind: 'mac', arch: 'arm64' });
    expect(detectInstallType(facts({ arch: 'x64' }))).toEqual({ kind: 'mac', arch: 'x64' });
    expect(detectInstallType(appImage())).toEqual({ kind: 'appimage', arch: 'x64' });
    expect(updateSupportFor({ kind: 'mac', arch: 'arm64' })).toBe('self-update');
  });

  it('never self-updates a development run, a disk image, a translocated copy or another platform', () => {
    expect(detectInstallType(facts({ isDevelopment: true }))).toEqual({ kind: 'development' });
    expect(detectInstallType(facts({ execPath: '/Volumes/Interleaf/Interleaf.app/Contents/MacOS/Interleaf' }))).toEqual({ kind: 'unsupported' });
    expect(detectInstallType(facts({ execPath: '/private/var/folders/x/AppTranslocation/y/Interleaf.app/Contents/MacOS/Interleaf' }))).toEqual({
      kind: 'unsupported',
    });
    expect(detectInstallType(facts({ platform: 'win32' }))).toEqual({ kind: 'unsupported' });
    expect(detectInstallType(appImage({ arch: 'arm64' }))).toEqual({ kind: 'unsupported' });
  });

  it('hands deb and pacman installs to the package manager', () => {
    const deb = appImage({ env: {}, execPath: '/opt/Interleaf/Interleaf', resourcesPath: '/opt/Interleaf/resources', readSmallFile: () => 'deb' });
    expect(detectInstallType(deb)).toEqual({ kind: 'package-manager', packageType: 'deb' });
    expect(updateSupportFor({ kind: 'package-manager', packageType: 'pacman' })).toBe('package-manager');
    expect(detectInstallType({ ...deb, readSmallFile: () => '../../etc' })).toEqual({ kind: 'unsupported' });
  });

  it('does not treat a relative or unrelated APPIMAGE environment as an AppImage', () => {
    expect(detectInstallType(appImage({ env: { APPIMAGE: 'Interleaf.AppImage', APPDIR: '/tmp/.mount_Interl' } }))).toEqual({ kind: 'unsupported' });
    expect(detectInstallType(appImage({ execPath: '/usr/bin/interleaf' }))).toEqual({ kind: 'unsupported' });
    expect(detectInstallType(appImage({ env: { APPIMAGE: '/a.AppImage', APPDIR: '/tmp/.mount_Inter' } }))).toEqual({ kind: 'unsupported' });
  });
});

function runtimeDeps(overrides: Partial<UpdateRuntimeDeps> = {}): UpdateRuntimeDeps {
  return {
    currentVersion: '1.2.2',
    packaging: { isPackaged: true, defaultApp: undefined },
    automaticChecks: true,
    fetch: vi.fn(() => Promise.reject(new Error('the feed must not be contacted'))),
    nativeMacUpdater: { checkForUpdates: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
    releaseSingleInstanceLock: vi.fn(),
    activeWork: work(),
    requestQuitForUpdate: vi.fn(() => true),
    openExternal: vi.fn(() => Promise.resolve()),
    publish: vi.fn(),
    log: silentLog,
    facts: facts({ isDevelopment: true }),
    ...overrides,
  };
}

describe('createUpdateRuntime', () => {
  it('never contacts the feed from a development run or a package-manager install', async () => {
    for (const installFacts of [facts({ isDevelopment: true }), appImage({ env: {}, readSmallFile: () => 'pacman' })]) {
      const deps = runtimeDeps({ facts: installFacts });
      const runtime = createUpdateRuntime(deps);
      runtime.start();
      const state = await runtime.check();
      expect(state.phase).toEqual({ status: 'idle' });
      expect(runtime.download().phase).toEqual({ status: 'idle' });
      await expect(runtime.restart()).resolves.toEqual({ outcome: 'not-ready' });
      expect(deps.fetch).not.toHaveBeenCalled();
      runtime.dispose();
    }
  });

  it('treats a renamed development bundle as development: no updater and no request', async () => {
    // electron.dev-bundle renames the executable, so Electron reports it packaged.
    const signals = { isPackaged: true, defaultApp: true };
    expect(processInstallFacts(signals).isDevelopment).toBe(true);
    expect(processInstallFacts({ isPackaged: true, defaultApp: undefined }).isDevelopment).toBe(false);
    expect(processInstallFacts({ isPackaged: false, defaultApp: undefined }).isDevelopment).toBe(true);
    vi.mocked(createPlatformUpdater).mockClear();
    // No injected facts: the runtime reads this process through processInstallFacts.
    const deps: UpdateRuntimeDeps = { ...runtimeDeps({ packaging: signals }) };
    delete (deps as { facts?: InstallFacts }).facts;
    const runtime = createUpdateRuntime(deps);
    runtime.start();
    await expect(runtime.check()).resolves.toMatchObject({ support: 'development', phase: { status: 'idle' } });
    expect(runtime.download().phase).toEqual({ status: 'idle' });
    await expect(runtime.restart()).resolves.toEqual({ outcome: 'not-ready' });
    expect(createPlatformUpdater).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('fails closed in a self-updating install when the build pins no key', async () => {
    const deps = runtimeDeps({ facts: facts({}), trust: { ...UPDATE_TRUST, signingKeys: [] } });
    const runtime = createUpdateRuntime(deps);
    await expect(runtime.check()).resolves.toMatchObject({ support: 'self-update', phase: { status: 'error', code: 'not-configured' } });
    expect(deps.fetch).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('opens only the pinned release page', async () => {
    const deps = runtimeDeps();
    await expect(createUpdateRuntime(deps).openReleasePage()).resolves.toEqual({ opened: true });
    expect(deps.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/FrescoFlacko/interleaf-releases/releases');
    const failing = runtimeDeps({ openExternal: () => Promise.reject(new Error('no browser')) });
    await expect(createUpdateRuntime(failing).openReleasePage()).resolves.toEqual({ opened: false });
  });
});

describe('restartToUpdate', () => {
  const busy: ActiveWorkSummary = { agentSessions: 1, chatStreams: 0, imports: 0 };

  function service(prepared: PreparedInstall | { outcome: 'not-ready' } = { version: '1.2.3', install: vi.fn() }) {
    return { prepareInstall: vi.fn(() => Promise.resolve(prepared)), cancelPreparedInstall: vi.fn() };
  }

  it('refuses before staging while agent, chat or import work runs', async () => {
    const svc = service();
    const activeWork = work(busy);
    const requestQuitForUpdate = vi.fn(() => true);
    await expect(restartToUpdate(svc, { activeWork, requestQuitForUpdate })).resolves.toEqual({ outcome: 'blocked', activeWork: busy });
    expect(svc.prepareInstall).not.toHaveBeenCalled();
    expect(requestQuitForUpdate).not.toHaveBeenCalled();
    expect(activeWork.closeAdmission).not.toHaveBeenCalled();
  });

  it('refuses and unstages when work started while the update was staging', async () => {
    const svc = service();
    const activeWork = work(IDLE, busy);
    const requestQuitForUpdate = vi.fn(() => true);
    await expect(restartToUpdate(svc, { activeWork, requestQuitForUpdate })).resolves.toEqual({ outcome: 'blocked', activeWork: busy });
    expect(svc.cancelPreparedInstall).toHaveBeenCalledOnce();
    expect(requestQuitForUpdate).not.toHaveBeenCalled();
    expect(activeWork.closeAdmission).not.toHaveBeenCalled();
  });

  it('hands the install and the admission close to the shutdown barrier, and unstages if it is busy', async () => {
    const prepared = { version: '1.2.3', install: vi.fn() };
    const svc = service(prepared);
    const activeWork = work();
    const requestQuitForUpdate = vi.fn(() => true);
    await expect(restartToUpdate(svc, { activeWork, requestQuitForUpdate })).resolves.toEqual({ outcome: 'restarting', version: '1.2.3' });
    expect(requestQuitForUpdate).toHaveBeenCalledWith(prepared.install, activeWork.closeAdmission);
    expect(prepared.install).not.toHaveBeenCalled();
    const refused = service();
    await expect(restartToUpdate(refused, { activeWork: work(), requestQuitForUpdate: () => false })).resolves.toEqual({ outcome: 'not-ready' });
    expect(refused.cancelPreparedInstall).toHaveBeenCalledOnce();
  });

  it('passes through a not-ready preparation', async () => {
    const svc = service({ outcome: 'not-ready' });
    await expect(restartToUpdate(svc, { activeWork: work(), requestQuitForUpdate: () => true })).resolves.toEqual({ outcome: 'not-ready' });
  });
});

describe('active work', () => {
  it('sums every service counter and blocks a restart until admitted work settles', async () => {
    const imports = new WorkAdmission();
    const opens = new WorkAdmission();
    let chats = 2;
    let agents = 1;
    const closed: string[] = [];
    const activeWork = createActiveWork({
      agentSessions: [() => agents],
      chatStreams: [() => chats, () => 0],
      imports: [() => imports.liveWork(), () => opens.liveWork()],
      closeAdmission: [() => { closed.push('chat'); }, () => { imports.close(); }, () => { opens.close(); }],
    });
    let release: () => void = () => undefined;
    const running = imports.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const opening = opens.run(() => Promise.resolve('opened'));
    expect(activeWork.probe()).toEqual({ agentSessions: 1, chatStreams: 2, imports: 2 });

    const svc = { prepareInstall: vi.fn(() => Promise.resolve({ version: '1.2.3', install: vi.fn() })), cancelPreparedInstall: vi.fn() };
    const requestQuitForUpdate = vi.fn((_install: () => void, closeAdmission: () => void) => { closeAdmission(); return true; });
    await expect(restartToUpdate(svc, { activeWork, requestQuitForUpdate })).resolves.toMatchObject({ outcome: 'blocked' });

    await opening;
    release();
    await running;
    chats = 0;
    agents = 0;
    expect(hasActiveWork(activeWork.probe())).toBe(false);
    await expect(restartToUpdate(svc, { activeWork, requestQuitForUpdate })).resolves.toEqual({ outcome: 'restarting', version: '1.2.3' });
    expect(closed).toEqual(['chat']);
    const refused = vi.fn(() => Promise.resolve());
    await expect(imports.run(refused)).rejects.toThrow('Application is shutting down.');
    await expect(opens.run(refused)).rejects.toThrow('Application is shutting down.');
    expect(refused).not.toHaveBeenCalled();
  });

  it('stops counting admitted work that fails, synchronously or not', async () => {
    const admission = new WorkAdmission();
    await expect(admission.run(() => Promise.reject(new Error('import failed')))).rejects.toThrow('import failed');
    await expect(admission.run(() => { throw new Error('bad input'); })).rejects.toThrow('bad input');
    expect(admission.liveWork()).toBe(0);
    expect(admission.isClosed()).toBe(false);
  });
});

type FakeWindow = BarrierWindow & { sent: { channel: string; payload: CloneableValue }[]; closed: boolean };

function fakeWindow(): FakeWindow {
  const window: FakeWindow = {
    sent: [],
    closed: false,
    isDestroyed: () => window.closed,
    close: () => { window.closed = true; },
    webContents: { send: (channel, payload) => { window.sent.push({ channel, payload }); } },
  };
  return window;
}

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

describe('ShutdownBarrier update restart', () => {
  function barrier(window: FakeWindow | null, order: string[]) {
    return new ShutdownBarrier<FakeWindow>({
      mainWindow: () => window,
      drain: () => { order.push('drain'); return Promise.resolve(); },
      hasLiveServices: () => true,
      quit: () => { order.push('quit'); },
      log: silentLog,
      handshakeTimeoutMs: 60_000,
      installFallbackQuitMs: 5,
    });
  }

  it('finishes the handshake only on an exact, schema-valid reply to the pending request', async () => {
    const order: string[] = [];
    const window = fakeWindow();
    const shutdown = barrier(window, order);
    expect(shutdown.requestQuitForUpdate(() => { order.push('install'); }, () => undefined)).toBe(true);
    const { requestId } = closeHandshakePayloadSchema.parse(window.sent[0]?.payload);
    const malformed: CloneableValue[] = [
      null,
      requestId,
      { requestId: 42 },
      { requestId, extra: 'x' },
      { requestId: '550e8400-e29b-41d4-a716-446655440000' },
      { requestId: 'not-a-uuid' },
    ];
    for (const reply of malformed) shutdown.handleCloseReady(window.webContents, reply);
    await flush();
    expect(order).toEqual([]);
    expect(window.closed).toBe(false);
    shutdown.handleCloseReady(window.webContents, { requestId });
    await flush();
    expect(order).toEqual(['drain', 'install']);
  });

  it('installs only after the renderer flushed and services drained, with a fallback quit', async () => {
    const order: string[] = [];
    const window = fakeWindow();
    const shutdown = barrier(window, order);
    let sentAtClose = -1;
    expect(shutdown.requestQuitForUpdate(() => { order.push('install'); }, () => { sentAtClose = window.sent.length; order.push('close-admission'); })).toBe(true);
    // Admission closed before the renderer was asked to flush.
    expect(sentAtClose).toBe(0);
    expect(order).toEqual(['close-admission']);
    order.length = 0;
    const [request] = window.sent;
    expect(request?.channel).toBe(IPC_EVENTS.appBeforeClose);
    shutdown.handleCloseReady({}, request?.payload ?? null);
    await flush();
    expect(order).toEqual([]);
    shutdown.handleCloseReady(window.webContents, request?.payload ?? null);
    await flush();
    expect(order).toEqual(['drain', 'install']);
    expect(window.closed).toBe(true);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(order).toEqual(['drain', 'install', 'quit']);
  });

  it('refuses a second request and any request once a quit is under way, leaving admission open', () => {
    const shutdown = barrier(fakeWindow(), []);
    const closeAdmission = vi.fn();
    expect(shutdown.requestQuitForUpdate(() => undefined, closeAdmission)).toBe(true);
    expect(shutdown.requestQuitForUpdate(() => undefined, closeAdmission)).toBe(false);
    expect(closeAdmission).toHaveBeenCalledOnce();
    const userQuit = barrier(fakeWindow(), []);
    userQuit.handleBeforeQuit({ preventDefault: () => undefined });
    const refusedClose = vi.fn();
    expect(userQuit.requestQuitForUpdate(() => undefined, refusedClose)).toBe(false);
    expect(refusedClose).not.toHaveBeenCalled();
  });

  it('still quits the drained process when the installer throws', async () => {
    const order: string[] = [];
    const shutdown = barrier(null, order);
    shutdown.requestQuitForUpdate(() => { throw new Error('no installer'); }, () => undefined);
    await flush();
    expect(order).toEqual(['drain', 'quit']);
  });
});

describe('platform updater policy', () => {
  it('fixes no automatic download, no install on quit, no downgrade and no pre-release', () => {
    const updater = { autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, allowPrerelease: true, forceDevUpdateConfig: true } as AppUpdater;
    applyUpdaterPolicy(updater, silentLog);
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false, forceDevUpdateConfig: false, autoRunAppAfterInstall: true });
    applyUpdaterPolicy(updater, silentLog, false);
    expect(updater.autoRunAppAfterInstall).toBe(false);
  });

  it('waits for Squirrel.Mac to stage the verified bundle, and rejects on its error or a timeout', async () => {
    const listeners = new Map<string, (error?: Error) => void>();
    const native: NativeMacUpdater = {
      checkForUpdates: vi.fn(),
      once: (event: string, listener: (error?: Error) => void) => { listeners.set(event, listener); },
      removeListener: (event: string) => { listeners.delete(event); },
    } as NativeMacUpdater;
    const ready = stageMacInstall(native, 1_000);
    listeners.get('update-downloaded')?.();
    await expect(ready).resolves.toBeUndefined();
    expect(listeners.size).toBe(0);
    const failed = stageMacInstall(native, 1_000);
    listeners.get('error')?.(new Error('code signature mismatch'));
    await expect(failed).rejects.toThrow('code signature mismatch');
    await expect(stageMacInstall(native, 5)).rejects.toThrow(/in time/);
  });
});
