export type AppLifecycleState =
  | 'uninitialized'
  | 'bootstrapping'
  | 'ready'
  | 'failed'
  | 'shutting_down'
  | 'terminated'
  | 'rejected_secondary';

export type WindowTarget = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
};

export type LifecycleCoordinatorDeps<TWindow extends WindowTarget> = {
  readonly createWindow: () => TWindow;
  readonly onQuit: () => void;
  /**
   * Brings an existing window back. Defaults to restoring a minimized window
   * and focusing it; the E2E background mode supplies a reveal that never
   * makes the window key (`window-reveal-mode.ts`).
   */
  readonly revealExisting?: ((window: TWindow) => void) | undefined;
};

export type WindowEnsureResult<TWindow extends WindowTarget> = {
  readonly window: TWindow | null;
  readonly created: boolean;
};

export type ActivateResult<TWindow extends WindowTarget> = {
  readonly handled: boolean;
  readonly reason?: AppLifecycleState | undefined;
  readonly created?: boolean | undefined;
  readonly window?: TWindow | null | undefined;
};

export type SecondInstanceResult = {
  readonly handled: boolean;
  readonly created?: boolean | undefined;
};

function restoreAndFocus(window: WindowTarget): void {
  if (window.isMinimized()) {
    window.restore();
  }
  window.focus();
}

export class LifecycleCoordinator<TWindow extends WindowTarget = WindowTarget> {
  private _state: AppLifecycleState = 'uninitialized';
  private _mainWindow: TWindow | null = null;
  private readonly deps: LifecycleCoordinatorDeps<TWindow>;
  private readonly revealExisting: (window: TWindow) => void;

  constructor(deps: LifecycleCoordinatorDeps<TWindow>) {
    this.deps = deps;
    this.revealExisting = deps.revealExisting ?? restoreAndFocus;
  }

  get state(): AppLifecycleState {
    return this._state;
  }

  get isReady(): boolean {
    return this._state === 'ready';
  }

  get isBootstrapping(): boolean {
    return this._state === 'bootstrapping';
  }

  get mainWindow(): TWindow | null {
    if (this._mainWindow?.isDestroyed()) {
      this._mainWindow = null;
    }
    return this._mainWindow;
  }

  /**
   * Evaluates single instance lock result.
   * If lock acquisition failed, transitions to 'rejected_secondary', calls onQuit,
   * and returns false so the caller can abort further startup immediately.
   */
  handleSingleInstanceLock(hasLock: boolean): boolean {
    if (!hasLock) {
      this._state = 'rejected_secondary';
      this.deps.onQuit();
      return false;
    }
    return true;
  }

  /**
   * Starts the bootstrap phase.
   */
  startBootstrap(): void {
    if (this._state === 'rejected_secondary') {
      throw new Error('Cannot bootstrap secondary instance without single instance lock');
    }
    if (this._state === 'bootstrapping' || this._state === 'ready') {
      return;
    }
    this._state = 'bootstrapping';
  }

  /**
   * Marks bootstrap as completed. Transitions state to 'ready'.
   */
  markBootstrapReady(): void {
    if (this._state !== 'bootstrapping') {
      return;
    }
    this._state = 'ready';
  }

  /**
   * Marks bootstrap as failed due to a fatal error.
   */
  markBootstrapFailed(): void {
    this._state = 'failed';
  }

  /**
   * Idempotently ensures that the main window is open, restored, and focused.
   * - If an active, non-destroyed main window exists: restores if minimized, focuses, and returns it (created = false).
   * - If no main window exists and bootstrap is 'ready': creates a new window via deps.createWindow(), tracks it, and returns it (created = true).
   * - If called while not ready (e.g. during bootstrapping or shutting down): returns null.
   */
  ensureMainWindow(): WindowEnsureResult<TWindow> {
    if (this._mainWindow !== null && !this._mainWindow.isDestroyed()) {
      this.revealExisting(this._mainWindow);
      return { window: this._mainWindow, created: false };
    }

    this._mainWindow = null;

    if (this._state !== 'ready') {
      return { window: null, created: false };
    }

    const newWindow = this.deps.createWindow();
    this._mainWindow = newWindow;
    return { window: newWindow, created: true };
  }

  /**
   * Handles macOS dock icon click / app activation.
   * - If bootstrap is still in progress or app is not ready: does NOT create a window (gated).
   * - If app is ready: idempotently ensures the window is restored/focused or recreated if closed.
   */
  handleActivate(): ActivateResult<TWindow> {
    if (this._state !== 'ready') {
      return { handled: false, reason: this._state };
    }

    const result = this.ensureMainWindow();
    return {
      handled: true,
      created: result.created,
      window: result.window,
    };
  }

  /**
   * Handles second instance launch when single instance lock is already held.
   * - If app is ready: ensures the main window is visible, restored, and focused.
   */
  handleSecondInstance(): SecondInstanceResult {
    if (this._state !== 'ready') {
      return { handled: false };
    }

    const result = this.ensureMainWindow();
    return { handled: true, created: result.created };
  }

  /**
   * Handles window closed event.
   */
  handleWindowClosed(window: TWindow): void {
    if (this._mainWindow === window) {
      this._mainWindow = null;
    }
  }

  /**
   * Transitions to shutting down state.
   */
  startShutdown(): void {
    this._state = 'shutting_down';
  }

  /**
   * Transitions to terminated state.
   */
  markTerminated(): void {
    this._state = 'terminated';
  }
}
