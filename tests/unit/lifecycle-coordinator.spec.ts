import { describe, expect, it, vi } from 'vitest';
import {
  LifecycleCoordinator,
  type WindowTarget,
} from '@main/app/lifecycle-coordinator';

type MockWindow = WindowTarget & {
  minimized: boolean;
  destroyed: boolean;
  focused: boolean;
  restoreCount: number;
  focusCount: number;
};

function createMockWindow(initialState: { minimized?: boolean; destroyed?: boolean } = {}): MockWindow {
  return {
    minimized: initialState.minimized ?? false,
    destroyed: initialState.destroyed ?? false,
    focused: false,
    restoreCount: 0,
    focusCount: 0,
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    restore() {
      this.restoreCount += 1;
      this.minimized = false;
    },
    focus() {
      this.focusCount += 1;
      this.focused = true;
    },
  };
}

describe('LifecycleCoordinator', () => {
  describe('Startup activation timing & duplicate window prevention', () => {
    it('gates app activate while bootstrap is in progress and creates exactly one window at completion', () => {
      let windowCreationCount = 0;
      const mockWindow = createMockWindow();

      const coordinator = new LifecycleCoordinator({
        createWindow: () => {
          windowCreationCount += 1;
          return mockWindow;
        },
        onQuit: () => undefined,
      });

      // App starts uninitialized
      expect(coordinator.state).toBe('uninitialized');
      expect(coordinator.isReady).toBe(false);
      expect(coordinator.isBootstrapping).toBe(false);

      // Early activate before bootstrap does not create a window
      const preActivateResult = coordinator.handleActivate();
      expect(preActivateResult).toEqual({
        handled: false,
        reason: 'uninitialized',
      });
      expect(windowCreationCount).toBe(0);
      expect(coordinator.mainWindow).toBeNull();

      // Bootstrap begins (async operations running)
      coordinator.startBootstrap();
      expect(coordinator.state).toBe('bootstrapping');
      expect(coordinator.isBootstrapping).toBe(true);
      expect(coordinator.isReady).toBe(false);

      // User clicks dock icon / app activates while database/storage/IPC are initializing
      const inFlightActivateResult = coordinator.handleActivate();
      expect(inFlightActivateResult).toEqual({
        handled: false,
        reason: 'bootstrapping',
      });
      expect(windowCreationCount).toBe(0);
      expect(coordinator.mainWindow).toBeNull();

      // Bootstrap completes successfully
      coordinator.markBootstrapReady();
      expect(coordinator.state).toBe('ready');
      expect(coordinator.isReady).toBe(true);
      expect(coordinator.isBootstrapping).toBe(false);

      // Bootstrap creates initial window
      const bootstrapWindowResult = coordinator.ensureMainWindow();
      expect(bootstrapWindowResult.created).toBe(true);
      expect(bootstrapWindowResult.window).toBe(mockWindow);
      expect(windowCreationCount).toBe(1);
      expect(coordinator.mainWindow).toBe(mockWindow);
    });

    it('makes window creation idempotent when ensureMainWindow is called multiple times', () => {
      let windowCreationCount = 0;
      const mockWindow = createMockWindow({ minimized: true });

      const coordinator = new LifecycleCoordinator({
        createWindow: () => {
          windowCreationCount += 1;
          return mockWindow;
        },
        onQuit: () => undefined,
      });

      coordinator.startBootstrap();
      coordinator.markBootstrapReady();

      // First call creates the window
      const first = coordinator.ensureMainWindow();
      expect(first.created).toBe(true);
      expect(windowCreationCount).toBe(1);

      // Second call restores, focuses, and reuses the existing window without creating a second one
      const second = coordinator.ensureMainWindow();
      expect(second.created).toBe(false);
      expect(second.window).toBe(first.window);
      expect(windowCreationCount).toBe(1);
      expect(mockWindow.restoreCount).toBe(1);
      expect(mockWindow.focusCount).toBe(1);
    });

    it('focuses and restores existing window on activate when already open', () => {
      let windowCreationCount = 0;
      const mockWindow = createMockWindow({ minimized: true });

      const coordinator = new LifecycleCoordinator({
        createWindow: () => {
          windowCreationCount += 1;
          return mockWindow;
        },
        onQuit: () => undefined,
      });

      coordinator.startBootstrap();
      coordinator.markBootstrapReady();
      coordinator.ensureMainWindow();
      expect(windowCreationCount).toBe(1);

      // Activate event arrives while window is minimized
      const activateResult = coordinator.handleActivate();
      expect(activateResult).toEqual({
        handled: true,
        created: false,
        window: mockWindow,
      });
      expect(windowCreationCount).toBe(1);
      expect(mockWindow.restoreCount).toBe(1);
      expect(mockWindow.focusCount).toBe(1);
    });
  });

  describe('macOS reopen behavior after all windows close', () => {
    it('re-creates a new window on activate after the main window is closed', () => {
      let windowCreationCount = 0;
      const createdWindows: MockWindow[] = [];

      const coordinator = new LifecycleCoordinator({
        createWindow: () => {
          windowCreationCount += 1;
          const win = createMockWindow();
          createdWindows.push(win);
          return win;
        },
        onQuit: () => undefined,
      });

      coordinator.startBootstrap();
      coordinator.markBootstrapReady();
      const initial = coordinator.ensureMainWindow();
      expect(initial.created).toBe(true);
      expect(windowCreationCount).toBe(1);
      expect(coordinator.mainWindow).toBe(createdWindows[0]);

      // Window closes on macOS (window-all-closed does not quit app)
      coordinator.handleWindowClosed(createdWindows[0]!);
      expect(coordinator.mainWindow).toBeNull();
      expect(coordinator.state).toBe('ready');

      // User clicks dock icon / activates macOS app
      const reopenResult = coordinator.handleActivate();
      expect(reopenResult.handled).toBe(true);
      expect(reopenResult.created).toBe(true);
      expect(reopenResult.window).toBe(createdWindows[1]);
      expect(windowCreationCount).toBe(2);
      expect(coordinator.mainWindow).toBe(createdWindows[1]);
    });
  });

  describe('Single-instance failure & lifecycle prevention', () => {
    it('prevents secondary instance from bootstrapping or opening windows when lock fails', () => {
      const createWindow = vi.fn();
      const onQuit = vi.fn();

      const coordinator = new LifecycleCoordinator({
        createWindow,
        onQuit,
      });

      const lockAcquired = coordinator.handleSingleInstanceLock(false);
      expect(lockAcquired).toBe(false);
      expect(coordinator.state).toBe('rejected_secondary');
      expect(onQuit).toHaveBeenCalledTimes(1);

      // Attempting bootstrap throws error and blocks execution
      expect(() => {
        coordinator.startBootstrap();
      }).toThrow('Cannot bootstrap secondary instance without single instance lock');

      // Window creation is rejected
      const ensureResult = coordinator.ensureMainWindow();
      expect(ensureResult).toEqual({ window: null, created: false });
      expect(createWindow).not.toHaveBeenCalled();

      // Activate is ignored
      const activateResult = coordinator.handleActivate();
      expect(activateResult).toEqual({
        handled: false,
        reason: 'rejected_secondary',
      });
      expect(createWindow).not.toHaveBeenCalled();

      // Second instance handler is rejected
      const secondInstanceResult = coordinator.handleSecondInstance();
      expect(secondInstanceResult).toEqual({ handled: false });
    });

    it('proceeds normally when single instance lock is acquired', () => {
      const createWindow = vi.fn(() => createMockWindow());
      const onQuit = vi.fn();

      const coordinator = new LifecycleCoordinator({
        createWindow,
        onQuit,
      });

      const lockAcquired = coordinator.handleSingleInstanceLock(true);
      expect(lockAcquired).toBe(true);
      expect(coordinator.state).toBe('uninitialized');
      expect(onQuit).not.toHaveBeenCalled();

      coordinator.startBootstrap();
      expect(coordinator.state).toBe('bootstrapping');
      coordinator.markBootstrapReady();
      expect(coordinator.state).toBe('ready');

      coordinator.ensureMainWindow();
      expect(createWindow).toHaveBeenCalledTimes(1);
    });

    it('restores and focuses existing window when primary instance receives second-instance event', () => {
      const mockWindow = createMockWindow({ minimized: true });

      const coordinator = new LifecycleCoordinator({
        createWindow: () => mockWindow,
        onQuit: () => undefined,
      });

      coordinator.startBootstrap();
      coordinator.markBootstrapReady();
      coordinator.ensureMainWindow();

      const result = coordinator.handleSecondInstance();
      expect(result).toEqual({ handled: true, created: false });
      expect(mockWindow.restoreCount).toBe(1);
      expect(mockWindow.focusCount).toBe(1);
    });
  });

  describe('Bootstrap failure & shutdown states', () => {
    it('blocks window creation and activation when bootstrap fails fatally', () => {
      const createWindow = vi.fn();
      const coordinator = new LifecycleCoordinator({ createWindow, onQuit: () => undefined });

      coordinator.startBootstrap();
      coordinator.markBootstrapFailed();
      expect(coordinator.state).toBe('failed');
      expect(coordinator.isReady).toBe(false);

      const ensureResult = coordinator.ensureMainWindow();
      expect(ensureResult).toEqual({ window: null, created: false });
      expect(createWindow).not.toHaveBeenCalled();

      const activateResult = coordinator.handleActivate();
      expect(activateResult).toEqual({ handled: false, reason: 'failed' });
      expect(createWindow).not.toHaveBeenCalled();
    });

    it('blocks window creation and activation during shutdown', () => {
      const mockWindow = createMockWindow();
      let windowCreationCount = 0;

      const coordinator = new LifecycleCoordinator({
        createWindow: () => {
          windowCreationCount += 1;
          return mockWindow;
        },
        onQuit: () => undefined,
      });

      coordinator.startBootstrap();
      coordinator.markBootstrapReady();
      coordinator.ensureMainWindow();
      expect(windowCreationCount).toBe(1);

      coordinator.startShutdown();
      expect(coordinator.state).toBe('shutting_down');

      coordinator.handleWindowClosed(mockWindow);
      expect(coordinator.mainWindow).toBeNull();

      const activateResult = coordinator.handleActivate();
      expect(activateResult).toEqual({ handled: false, reason: 'shutting_down' });
      expect(windowCreationCount).toBe(1);

      coordinator.markTerminated();
      expect(coordinator.state).toBe('terminated');
    });

    it('handles destroyed window references gracefully in mainWindow getter and ensureMainWindow', () => {
      const mockWindow = createMockWindow();
      let windowCreationCount = 0;
      let targetWindow = mockWindow;

      const coordinator = new LifecycleCoordinator({
        createWindow: () => {
          windowCreationCount += 1;
          return targetWindow;
        },
        onQuit: () => undefined,
      });

      coordinator.startBootstrap();
      coordinator.markBootstrapReady();
      coordinator.ensureMainWindow();
      expect(coordinator.mainWindow).toBe(mockWindow);

      // Window is destroyed externally
      mockWindow.destroyed = true;
      expect(coordinator.mainWindow).toBeNull();

      // ensureMainWindow detects destroyed window and creates a fresh one
      const nextWindow = createMockWindow();
      targetWindow = nextWindow;

      const result = coordinator.ensureMainWindow();
      expect(result.created).toBe(true);
      expect(result.window).toBe(nextWindow);
      expect(coordinator.mainWindow).toBe(nextWindow);
      expect(windowCreationCount).toBe(2);
    });
  });

  describe('Injected reveal for existing windows', () => {
    it('uses the supplied reveal instead of restore-and-focus on activate and second instance', () => {
      const mockWindow = createMockWindow({ minimized: true });
      const revealed: MockWindow[] = [];
      const coordinator = new LifecycleCoordinator({
        createWindow: () => mockWindow,
        onQuit: () => undefined,
        revealExisting: (window) => { revealed.push(window); },
      });
      coordinator.startBootstrap();
      coordinator.markBootstrapReady();
      expect(coordinator.ensureMainWindow().created).toBe(true);

      expect(coordinator.handleActivate()).toMatchObject({ handled: true, created: false });
      expect(coordinator.handleSecondInstance()).toEqual({ handled: true, created: false });

      expect(revealed).toEqual([mockWindow, mockWindow]);
      expect(mockWindow.focusCount).toBe(0);
      expect(mockWindow.restoreCount).toBe(0);
    });
  });
});
