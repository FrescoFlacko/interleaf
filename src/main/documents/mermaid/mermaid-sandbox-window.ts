/**
 * The isolated, terminable process a diagram is actually drawn in.
 *
 * The official Mermaid build measures text with a real layout engine, so there
 * is no headless or worker path in the pinned version that produces correct
 * geometry. The renderer therefore needs a DOM — and a DOM that has run a
 * parser over document-controlled input is exactly what must not sit in the
 * reader's window. This module gives that work its own hidden window, on its
 * own in-memory session, with no preload, no bridge, no network, no
 * permissions, and no navigation, and hands main a handle that can end it.
 *
 * What crosses the boundary is narrow by construction: one JSON job in through
 * `executeJavaScript`, one JSON result out. There is no channel the page can
 * open on its own, and nothing it returns is trusted — `MermaidRenderService`
 * re-validates and re-checks every field.
 */
import { BrowserWindow, session as electronSession, type Session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MermaidSandboxJob } from '@shared/types/mermaid';
import type { Logger } from '../../logging/logger';
import type { MermaidSandbox } from './mermaid-render-service';
import type { CloneableValue } from '@shared/models/portable';

/** Session name without a `persist:` prefix: nothing survives the process. */
const SANDBOX_PARTITION = 'mermaid-sandbox';

/** The hidden window is never shown; the size only gives layout a viewport. */
const SANDBOX_BOUNDS = { width: 1_200, height: 1_200 } as const;

export type MermaidSandboxWindowOptions = {
  readonly log: Logger;
  /** Dev-server origin when electron-vite is serving the renderer. */
  readonly devUrl?: string | undefined;
};

/**
 * Where the isolated page is loaded from.
 *
 * Production loads a file inside the application bundle; development loads the
 * same route from the dev server. Both are fixed at startup from the app's own
 * layout — no document, renderer, or job contributes any part of this URL.
 */
export function mermaidSandboxUrl(devUrl: string | undefined): string {
  if (devUrl !== undefined) return new URL('mermaid-sandbox/index.html', devUrl).toString();
  return pathToFileURL(join(__dirname, '../renderer/mermaid-sandbox/index.html')).toString();
}

/**
 * The single location the isolated page may load anything from.
 *
 * The build code-splits Mermaid into chunks that sit beside the reader's own
 * bundle rather than inside the sandbox folder, so the allowance is the built
 * renderer directory: the app's own compiled assets and nothing outside them.
 */
export function sandboxAssetPrefix(baseUrl: string): string {
  return new URL('..', baseUrl).toString();
}

/**
 * Locks a session down to loading the app's own compiled assets and nothing
 * else.
 *
 * The page can pull the Mermaid chunks it splits into and can reach nothing
 * further — not the user's filesystem, not a host. A diagram that names a font,
 * a stylesheet, or an image is refused at the network layer as well as by the
 * source and output policies.
 */
export function applySandboxSessionPolicy(session: Session, baseUrl: string, log: Logger): void {
  const allowedPrefix = sandboxAssetPrefix(baseUrl);

  session.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith(allowedPrefix)) {
      callback({ cancel: false });
      return;
    }
    log.warn('blocked a request from the diagram renderer', {
      scheme: schemeForLog(details.url),
    });
    callback({ cancel: true });
  });

  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}

function schemeForLog(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '<malformed-url>';
  }
}

/**
 * The two separators JSON leaves bare and JavaScript once treated as newlines.
 * Built from code points rather than written literally so the characters cannot
 * be lost or normalized by an editor along the way.
 */
const LINE_SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'gu');

function escapeCodePoint(character: string): string {
  return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
}

/**
 * Serializes a job as a JavaScript literal.
 *
 * `JSON.stringify` already escapes quotes and backslashes; the two line
 * separators and `<` are escaped on top of that so the literal cannot end a
 * string, a script, or a line of the expression it is embedded in regardless of
 * what a document wrote.
 */
export function encodeJobLiteral(job: MermaidSandboxJob): string {
  return JSON.stringify(job)
    .replace(LINE_SEPARATORS, (character) => escapeCodePoint(character))
    .replace(/</gu, '\\u003c');
}

export function createMermaidSandboxWindow(options: MermaidSandboxWindowOptions): MermaidSandbox {
  const { log } = options;
  const url = mermaidSandboxUrl(options.devUrl);
  const session = electronSession.fromPartition(SANDBOX_PARTITION);
  applySandboxSessionPolicy(session, url, log);

  const win = new BrowserWindow({
    ...SANDBOX_BOUNDS,
    show: false,
    // Keeps the window off every task switcher and out of the user's way; it is
    // an implementation detail of drawing, not a surface.
    skipTaskbar: true,
    webPreferences: {
      session,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      webgl: false,
      images: false,
      spellcheck: false,
      devTools: false,
      // A hidden window is throttled by default, which would turn the fixed
      // deadline into a timeout for diagrams that render perfectly well.
      backgroundThrottling: false,
      // No `preload`: this page has no bridge and no application API.
    },
  });

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
    log.warn('blocked navigation inside the diagram renderer');
  });
  win.webContents.on('will-redirect', (event) => {
    event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  /**
   * Readiness settles exactly once, whichever way the load ends.
   *
   * A failed load can be reported twice — `did-fail-load` on the contents and a
   * rejection from `loadURL` itself — and a window can go away after it has
   * already loaded. The settler drops every outcome after the first, so the
   * caller sees one answer and a late report costs no second rejection and no
   * second log line.
   */
  let settleReady: ((outcome: Error | null) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = (outcome) => {
      settleReady = null;
      if (outcome === null) resolve();
      else reject(outcome);
    };
  });
  /** Whether this outcome was the one that decided readiness. */
  const settle = (outcome: Error | null): boolean => {
    const settler = settleReady;
    if (settler === null) return false;
    settler(outcome);
    return true;
  };
  // A rejection that arrives before any job would otherwise be unhandled; the
  // stored promise is awaited by `ready()` on the next render.
  ready.catch(() => undefined);

  win.webContents.once('did-finish-load', () => {
    settle(null);
  });
  win.webContents.once('did-fail-load', () => {
    if (settle(new Error('MermaidSandboxLoadFailed'))) {
      log.warn('the diagram renderer page failed to load');
    }
  });
  win.webContents.once('render-process-gone', () => {
    settle(new Error('MermaidSandboxProcessGone'));
  });

  // `loadURL` rejects on its own for a load that never reaches the contents —
  // a missing bundled file, a refused scheme — and that rejection is separate
  // from `did-fail-load`. Left floating it is an unhandled rejection in main;
  // handled here it becomes the same typed readiness failure the service
  // already falls back from.
  win.loadURL(url).catch(() => {
    if (settle(new Error('MermaidSandboxLoadFailed'))) {
      log.warn('the diagram renderer page failed to load');
    }
  });

  return {
    ready: () => ready,
    run: async (job) => {
      if (win.isDestroyed()) throw new Error('MermaidSandboxDestroyed');
      // Deliberately unvalidated: whatever the isolated page returns is a
      // structured-clone claim, and the service validates it against the result
      // schema before use.
      return (await win.webContents.executeJavaScript(
        `window.__interleafRenderMermaid(${encodeJobLiteral(job)})`,
        true
      )) as CloneableValue;
    },
    destroy: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
