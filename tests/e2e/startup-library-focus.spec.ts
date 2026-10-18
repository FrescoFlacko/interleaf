import { expect, test, type Locator, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { captureWindowPng, launchInterleaf, type AppHandle } from './helpers';

/**
 * Every launch opens on the Library in a window maximized to the display's
 * work area (a normal, restorable window, not fullscreen). The AI drawer opens
 * at launch so it is discoverable, unless Settings → General → "Open AI drawer
 * on startup" is off. That preference applies on the next launch and wins over
 * whatever open/closed state the drawer was last left in.
 */

type NativeWindowState = {
  readonly maximized: boolean;
  readonly fullScreen: boolean;
  readonly simpleFullScreen: boolean;
  readonly resizable: boolean;
  readonly maximizable: boolean;
  readonly visible: boolean;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly workArea: { x: number; y: number; width: number; height: number };
};

async function nativeWindowState(app: AppHandle): Promise<NativeWindowState> {
  // Look the window up in main by the page it hosts, so every value comes back
  // through Electron's typed API.
  return app.electronApp.evaluate(({ BrowserWindow, screen }, pageUrl) => {
    const matches = BrowserWindow.getAllWindows().filter((candidate) => candidate.webContents.getURL() === pageUrl);
    const [win] = matches;
    if (win === undefined || matches.length !== 1) throw new Error('main window not found');
    const bounds = win.getBounds();
    return {
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
      simpleFullScreen: win.isSimpleFullScreen(),
      resizable: win.isResizable(),
      maximizable: win.isMaximizable(),
      visible: win.isVisible(),
      bounds,
      workArea: screen.getDisplayMatching(bounds).workArea,
    };
  }, app.window.url());
}

type DrawerAtLaunch = 'open' | 'collapsed';

async function persistedLayout(app: AppHandle): Promise<{ rightOpen: boolean; openRightPanelOnStartup: boolean }> {
  return app.window.evaluate(async () => {
    const { layout } = await window.interleafAPI.settings.get();
    return { rightOpen: layout.rightOpen, openRightPanelOnStartup: layout.openRightPanelOnStartup };
  });
}

type Rect = { x: number; y: number; width: number; height: number };

async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  });
}

/** What a launch shows for each drawer state, once settings have hydrated. */
const EXPECT_DRAWER: Readonly<Record<DrawerAtLaunch, (app: AppHandle) => Promise<void>>> = {
  open: async (app) => {
    const rightPanel = app.window.getByTestId('resizable-panel-right');
    await expect(app.window.getByTestId('toggle-right-panel')).toHaveAttribute('aria-pressed', 'true');
    await expect(rightPanel).not.toHaveAttribute('aria-hidden');
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();
    await expect.poll(() => rightPanel.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  },
  collapsed: async (app) => {
    const rightPanel = app.window.getByTestId('resizable-panel-right');
    await expect(app.window.getByTestId('toggle-right-panel')).toHaveAttribute('aria-pressed', 'false');
    await expect(rightPanel).toHaveAttribute('aria-hidden', 'true');
    await expect(rightPanel).toBeHidden();
    await expect(app.window.getByTestId('companion-panel')).toBeHidden();
  },
};

async function expectLibraryFocusedLaunch(
  app: AppHandle,
  testInfo: TestInfo,
  label: string,
  drawer: DrawerAtLaunch,
): Promise<NativeWindowState> {
  await expect.poll(async () => (await nativeWindowState(app)).maximized).toBe(true);
  const state = await nativeWindowState(app);
  expect(state).toMatchObject({
    visible: true,
    fullScreen: false,
    simpleFullScreen: false,
    resizable: true,
    maximizable: true,
  });
  // Maximized fills the display's work area, leaving the menu bar/taskbar.
  expect(state.bounds).toEqual(state.workArea);

  await expect(app.window.getByTestId('library-view')).toBeVisible();
  await expect(app.window.getByTestId('sidebar-library')).toBeVisible();
  // Settings hydration records the drawer's launch state as its live state, so
  // the persisted value proves the launch rule has run, not merely that the
  // pre-hydration placeholder is still showing.
  await expect.poll(async () => (await persistedLayout(app)).rightOpen).toBe(drawer === 'open');

  await EXPECT_DRAWER[drawer](app);

  const rightPanel = app.window.getByTestId('resizable-panel-right');
  const innerWidth = await app.window.evaluate(() => window.innerWidth);
  const viewport = await rectOf(app.window.getByTestId('reader-viewport'));
  const sidebar = await rectOf(app.window.getByTestId('resizable-panel-left'));
  const drawerBox = await rectOf(rightPanel);
  // The Library runs from the sidebar to the open drawer's edge, or to the
  // window's edge when it is collapsed (only the panel's 1px border remains).
  const libraryEnd = { open: drawerBox.x, collapsed: innerWidth }[drawer];
  expect(Math.abs(Math.round(viewport.x + viewport.width) - Math.round(libraryEnd))).toBeLessThanOrEqual(1);

  const screenshot = testInfo.outputPath(`${label}.png`);
  await captureWindowPng(app, screenshot);
  const evidence = {
    label, drawer, ...state, innerWidth, readerViewport: viewport, librarySidebar: sidebar, drawerBox,
    persisted: await persistedLayout(app), screenshot,
  };
  writeFileSync(testInfo.outputPath(`${label}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  return state;
}

/** Sets "Open AI drawer on startup" through Settings → General, as a reader does. */
async function setOpenDrawerOnStartup(app: AppHandle, checked: boolean, screenshot: string): Promise<void> {
  await app.window.getByTestId('open-settings').click();
  const settings = app.window.getByTestId('ai-providers-settings-modal');
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'General' }).click();
  const checkbox = settings.getByRole('checkbox', { name: /Open AI drawer on startup/u });
  await expect(checkbox).toBeVisible();
  await expect(settings.getByText(/Applies the next time Interleaf opens/u)).toBeVisible();
  await checkbox.setChecked(checked);
  await expect(checkbox).toBeChecked({ checked });
  await expect.poll(async () => (await persistedLayout(app)).openRightPanelOnStartup).toBe(checked);
  await captureWindowPng(app, screenshot);
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(settings).toHaveCount(0);
}

async function toggleDrawer(app: AppHandle, open: boolean): Promise<void> {
  const toggle = app.window.getByTestId('toggle-right-panel');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(open));
  await expect.poll(async () => (await persistedLayout(app)).rightOpen).toBe(open);
}

test('the AI drawer opens at launch unless Settings turns it off for the next launch', async ({}, testInfo) => {
  let app = await launchInterleaf();
  const userDataDir = app.userDataDir;
  try {
    await expectLibraryFocusedLaunch(app, testInfo, 'fresh-profile-launch', 'open');

    // Turning the preference off leaves this session's drawer alone.
    await setOpenDrawerOnStartup(app, false, testInfo.outputPath('settings-general-startup-off.png'));
    await expect(app.window.getByTestId('toggle-right-panel')).toHaveAttribute('aria-pressed', 'true');
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();
    // Manual toggles are ordinary and leave the startup preference alone; the
    // drawer is last left open.
    await toggleDrawer(app, false);
    await toggleDrawer(app, true);
    expect(await persistedLayout(app)).toEqual({ rightOpen: true, openRightPanelOnStartup: false });

    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    await expectLibraryFocusedLaunch(app, testInfo, 'opted-out-relaunch', 'collapsed');

    // The drawer still opens normally; turning the preference back on and
    // leaving the drawer closed still opens it on the next launch.
    await toggleDrawer(app, true);
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();
    await setOpenDrawerOnStartup(app, true, testInfo.outputPath('settings-general-startup-on.png'));
    await toggleDrawer(app, false);
    expect(await persistedLayout(app)).toEqual({ rightOpen: false, openRightPanelOnStartup: true });

    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    await expectLibraryFocusedLaunch(app, testInfo, 'opted-in-relaunch', 'open');

    // It is an ordinary maximized window: it can be restored and resized.
    const browserWindow = await app.electronApp.browserWindow(app.window);
    await browserWindow.evaluate((win) => { win.unmaximize(); });
    await expect.poll(async () => (await nativeWindowState(app)).maximized).toBe(false);
    await browserWindow.evaluate((win) => { win.setSize(1100, 760); });
    await expect.poll(async () => {
      const { bounds } = await nativeWindowState(app);
      return [bounds.width, bounds.height];
    }).toEqual([1100, 760]);
  } finally {
    await app.close({ preserveUserData: true });
    const { rmSync } = await import('node:fs');
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
