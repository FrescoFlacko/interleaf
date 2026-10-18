import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { APP_NAME } from '@shared/constants/brand';
import { defaultBrandIconPath } from '../app/brand-icon';
import type { Logger } from '../logging/logger';

/**
 * Secure BrowserWindow construction (docs/SECURITY.md §3, electron-development
 * skill checklist). The webPreferences factory is exported and unit-tested:
 * any weakening of these flags must fail the security test suite.
 */

export type SecureWebPreferences = { readonly contextIsolation: true;
readonly nodeIntegration: false;
readonly sandbox: true;
readonly webSecurity: true;
readonly allowRunningInsecureContent: false;
readonly experimentalFeatures: false;
readonly preload: string; }

export function createSecureWebPreferences(preloadPath: string): SecureWebPreferences {
  return Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    preload: preloadPath,
  });
}

export type MainWindowOptions = { /** Dev server origin (electron-vite sets ELECTRON_RENDERER_URL in dev). */
readonly devUrl?: string | undefined;
/** Absolute path to the built renderer index.html for production loads. */
readonly indexHtmlPath: string;
/** Absolute path to the compiled preload script. */
readonly preloadPath: string;
/**
 * Absolute path to the application icon raster. Windows and Linux need an
 * explicit window icon, and in development it also replaces the stock
 * Electron icon. macOS packaged builds use the bundle `.icns` instead.
 * Defaults to `defaultBrandIconPath()`; omitted when no icon is found.
 */
readonly iconPath?: string | undefined;
readonly log: Logger; }

const DEFAULT_WINDOW_BOUNDS = { width: 1400, height: 900 } as const;

export type MainWindowWebContents = {
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
};

export function installMainWindowSecurityHandlers(
  webContents: MainWindowWebContents,
  devUrl: string | undefined,
  log: Logger
): void {
  // Navigation hijack defense: only the app's own origin may be navigated.
  webContents.on('will-navigate', (event, url) => {
    if (isNavigationAllowed(url, devUrl)) {
      return;
    }
    event.preventDefault();
    log.warn('blocked unexpected navigation', { target: safeNavigationTargetForLog(url) });
  });

  // Pop-up exploitation defense: deny every auxiliary window. External URLs
  // are never forwarded to the OS in this phase.
  webContents.setWindowOpenHandler(({ url }) => {
    log.warn('denied new-window request', { target: safeNavigationTargetForLog(url) });
    return { action: 'deny' };
  });

  // Webview tag exploitation defense: block attachment of <webview> elements.
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log.warn('blocked webview attachment');
  });
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const { log } = options;
  const iconPath = options.iconPath ?? defaultBrandIconPath();
  const win = new BrowserWindow({
    ...DEFAULT_WINDOW_BOUNDS,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    backgroundColor: '#FBFBFA',
    autoHideMenuBar: false,
    webPreferences: createSecureWebPreferences(options.preloadPath),
  });

  // Open maximized to the display's work area, like an editor: a normal,
  // restorable window with its controls, not OS fullscreen. Maximizing while
  // still hidden means the first frame the user sees is already full size.
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  installMainWindowSecurityHandlers(win.webContents, options.devUrl, log);

  void (options.devUrl !== undefined
    ? win.loadURL(options.devUrl)
    : win.loadFile(options.indexHtmlPath));

  return win;
}

export function defaultIndexHtmlPath(): string {
  return join(__dirname, '../renderer/index.html');
}

export function defaultPreloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

/**
 * Pure navigation policy (unit-tested): in development the Vite dev-server
 * origin is allowed; everything else — including other schemes — is denied.
 */
export function isNavigationAllowed(candidateUrl: string, devUrl?: string): boolean {
  if (devUrl === undefined) {
    return false;
  }
  try {
    return new URL(candidateUrl).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}

export function safeNavigationTargetForLog(candidateUrl: string): string {
  try {
    const parsed = new URL(candidateUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
    return `${parsed.protocol}//[redacted]`;
  } catch {
    return '<malformed-url>';
  }
}
