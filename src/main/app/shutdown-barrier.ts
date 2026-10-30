import { randomUUID } from 'node:crypto';
import { IPC_EVENTS } from '@shared/constants/ipc';
import type { CloneableValue } from '@shared/models/portable';
import { closeHandshakePayloadSchema } from '@shared/schemas/app-lifecycle';
import type { Logger } from '../logging/logger';

/**
 * The one barrier every application quit passes through: the renderer is asked
 * to flush transient state, then main drains its services (chat streams, agent
 * processes, open files, timers, the database, the durable log), and only then
 * does the process quit.
 *
 * The same handshake serves a native window close and app.quit(), since
 * Electron may emit before-quit without first dispatching BrowserWindow's
 * close event (notably in automated Electron shutdowns), and it may emit
 * before-quit more than once when an earlier quit was requested while the
 * handshake was pending.
 *
 * An update restart uses this barrier too. `requestQuitForUpdate` queues the
 * updater's install step in place of the final quit, so the install runs only
 * after the window has flushed and every service has stopped, and a fallback
 * quit still ends the drained process if the platform installer never does.
 */

export type BarrierWindow = {
  isDestroyed(): boolean;
  close(): void;
  readonly webContents: { send(channel: string, payload: CloneableValue): void };
};

type QuitEvent = { preventDefault(): void };

export type ShutdownBarrierDeps<TWindow extends BarrierWindow> = {
  readonly mainWindow: () => TWindow | null;
  /** Stops every service. Called at most once; must release resources even when a step throws. */
  readonly drain: () => Promise<void>;
  /** True while main still holds a service or the database that `drain` would release. */
  readonly hasLiveServices: () => boolean;
  readonly quit: () => void;
  readonly log: Logger;
  readonly handshakeTimeoutMs?: number;
  readonly installFallbackQuitMs?: number;
};

const CLOSE_HANDSHAKE_TIMEOUT_MS = 2_000;
const INSTALL_FALLBACK_QUIT_MS = 10_000;

export class ShutdownBarrier<TWindow extends BarrierWindow> {
  private pendingCloseRequestId: string | null = null;
  private closeHandshakeComplete = false;
  private closeHandshakeTimer: NodeJS.Timeout | null = null;
  private appQuitRequested = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private complete = false;
  private pendingInstall: (() => void) | null = null;

  constructor(private readonly deps: ShutdownBarrierDeps<TWindow>) {}

  get isComplete(): boolean {
    return this.complete;
  }

  /** `before-quit`: hold every quit attempt until the renderer has flushed and services have drained. */
  handleBeforeQuit(event: QuitEvent): void {
    if (this.complete) return;
    event.preventDefault();
    this.appQuitRequested = true;
    if (this.shuttingDown) return;
    this.startQuit();
  }

  /** `will-quit`: returns true when the quit may proceed (and the caller may close what is left). */
  handleWillQuit(event: QuitEvent): boolean {
    if (this.complete || !this.deps.hasLiveServices()) return true;
    event.preventDefault();
    this.appQuitRequested = true;
    if (!this.shuttingDown) void this.shutdown().then(() => { this.quitAfterShutdown(); });
    return false;
  }

  /** BrowserWindow `close`: a native close flushes the renderer before the window goes. */
  handleWindowClose(window: TWindow, event: QuitEvent): void {
    if (this.closeHandshakeComplete) return;
    event.preventDefault();
    this.beginCloseHandshake(window);
  }

  /** BrowserWindow `closed`: the next window starts a fresh handshake. */
  handleWindowClosed(): void {
    this.pendingCloseRequestId = null;
    this.closeHandshakeComplete = false;
    this.clearHandshakeTimer();
  }

  /** The renderer's `app:close-ready` reply; anything but the active window answering the pending request is ignored. */
  handleCloseReady(sender: object, payload: CloneableValue): void {
    const activeWindow = this.deps.mainWindow();
    if (activeWindow === null) return;
    if (sender !== activeWindow.webContents) return;
    const reply = closeHandshakePayloadSchema.safeParse(payload);
    if (!reply.success || reply.data.requestId !== this.pendingCloseRequestId) return;
    this.finishCloseHandshake(activeWindow);
  }

  /**
   * Quits through the barrier and runs `install` in place of the final quit.
   * Returns false, leaving nothing queued, when any quit is already under way.
   *
   * The reservation is synchronous: the install is queued and `closeAdmission`
   * has refused new service work before the renderer is asked to flush, so
   * nothing new can start during the handshake. Flush writes, which are not
   * new work, still reach their services.
   */
  requestQuitForUpdate(install: () => void, closeAdmission: () => void): boolean {
    if (this.appQuitRequested || this.shuttingDown || this.complete || this.pendingInstall !== null) return false;
    this.pendingInstall = install;
    this.appQuitRequested = true;
    closeAdmission();
    this.startQuit();
    return true;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.deps.drain().finally(() => {
      this.complete = true;
    });
    return this.shutdownPromise;
  }

  private startQuit(): void {
    const activeWindow = this.deps.mainWindow();
    if (activeWindow !== null && !activeWindow.isDestroyed() && !this.closeHandshakeComplete) {
      this.beginCloseHandshake(activeWindow);
    } else {
      void this.shutdown().then(() => { this.quitAfterShutdown(); });
    }
  }

  private beginCloseHandshake(window: TWindow): void {
    if (this.pendingCloseRequestId !== null || window.isDestroyed()) return;
    this.pendingCloseRequestId = randomUUID();
    window.webContents.send(IPC_EVENTS.appBeforeClose, { requestId: this.pendingCloseRequestId });
    this.closeHandshakeTimer = setTimeout(() => {
      if (!window.isDestroyed()) this.finishCloseHandshake(window);
    }, this.deps.handshakeTimeoutMs ?? CLOSE_HANDSHAKE_TIMEOUT_MS);
  }

  private finishCloseHandshake(window: TWindow): void {
    this.closeHandshakeComplete = true;
    this.pendingCloseRequestId = null;
    this.clearHandshakeTimer();
    const shutdownAction = async (): Promise<void> => {
      if (this.appQuitRequested) await this.shutdown();
      if (!window.isDestroyed()) window.close();
      if (this.appQuitRequested) this.quitAfterShutdown();
    };
    void shutdownAction();
  }

  private quitAfterShutdown(): void {
    const install = this.pendingInstall;
    this.pendingInstall = null;
    if (install === null) {
      this.deps.quit();
      return;
    }
    // Everything has drained, so this process must end whatever the installer does.
    setTimeout(() => {
      this.deps.quit();
    }, this.deps.installFallbackQuitMs ?? INSTALL_FALLBACK_QUIT_MS).unref();
    try {
      install();
    } catch (error) {
      this.deps.log.warn('Update install did not start; quitting', { name: error instanceof Error ? error.name : 'unknown' });
      this.deps.quit();
    }
  }

  private clearHandshakeTimer(): void {
    if (this.closeHandshakeTimer !== null) {
      clearTimeout(this.closeHandshakeTimer);
      this.closeHandshakeTimer = null;
    }
  }
}
