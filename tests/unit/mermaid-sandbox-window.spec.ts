import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallbackResponse, OnBeforeRequestListenerDetails, Session, WebRequestFilter } from 'electron';
import { rejectionOf } from '../helpers/errors';

/**
 * A window main can create without Electron.
 *
 * The creation path is what the load-failure behaviour lives in, so the stub is
 * drivable rather than inert: a test decides what `loadURL` does and fires the
 * contents events itself, in whatever order a real failure would report them.
 */
const electron = vi.hoisted(() => {
  type Handler = () => void;
  type FakeWindow = {
    readonly once: Map<string, Handler>;
    readonly loadURLs: string[];
    destroyed: boolean;
    webContents: {
      once: (event: string, handler: Handler) => void;
      on: () => undefined;
      setWindowOpenHandler: () => undefined;
      executeJavaScript: () => Promise<undefined>;
    };
    loadURL: (url: string) => Promise<void>;
    isDestroyed: () => boolean;
    destroy: () => void;
  };
  const control = { loadURL: (): Promise<void> => Promise.resolve() };
  const windows: FakeWindow[] = [];

  function makeWindow(): FakeWindow {
    const once = new Map<string, Handler>();
    const window: FakeWindow = {
      once,
      loadURLs: [],
      destroyed: false,
      webContents: {
        once: (event: string, handler: Handler) => {
          once.set(event, handler);
        },
        on: () => undefined,
        setWindowOpenHandler: () => undefined,
        executeJavaScript: () => Promise.resolve(undefined),
      },
      loadURL: (url: string) => {
        window.loadURLs.push(url);
        return control.loadURL();
      },
      isDestroyed: () => window.destroyed,
      destroy: () => {
        window.destroyed = true;
      },
    };
    windows.push(window);
    return window;
  }

  function makeSession() {
    return {
      webRequest: { onBeforeRequest: () => undefined },
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      setDevicePermissionHandler: () => undefined,
    };
  }

  return { control, windows, makeWindow, makeSession };
});

vi.mock('electron', () => ({
  // A constructor, not an arrow: the module calls it with `new`.
  BrowserWindow: function BrowserWindowStub() {
    return electron.makeWindow();
  },
  session: { fromPartition: () => electron.makeSession() },
}));

const {
  applySandboxSessionPolicy,
  createMermaidSandboxWindow,
  encodeJobLiteral,
  mermaidSandboxUrl,
  sandboxAssetPrefix,
} = await import('../../src/main/documents/mermaid/mermaid-sandbox-window');

// Built from code points so the two bare separators survive any editor.
const LINE_SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'u');

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type BeforeRequest = (
  details: OnBeforeRequestListenerDetails,
  callback: (response: CallbackResponse) => void
) => void;

/** Both of Electron's `onBeforeRequest` overloads: with and without a URL filter. */
type BeforeRequestArgs = [BeforeRequest | null] | [WebRequestFilter, BeforeRequest | null];

function listenerOf(args: BeforeRequestArgs): BeforeRequest | null {
  return args.length === 1 ? args[0] : args[1];
}

function fakeSession(): { session: Session; decide: () => BeforeRequest } {
  const installed: BeforeRequest[] = [];
  const webRequest: Pick<Session['webRequest'], 'onBeforeRequest'> = {
    onBeforeRequest: (...args: BeforeRequestArgs) => {
      const listener = listenerOf(args);
      if (listener !== null) installed.push(listener);
    },
  };
  const policySurface: Pick<
    Session,
    'webRequest' | 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'
  > = {
    webRequest: webRequest as Session['webRequest'],
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  };
  const session = policySurface as Session;
  return {
    session,
    decide: () => {
      const handler = installed[0];
      if (handler === undefined) throw new Error('no request handler installed');
      return handler;
    },
  };
}

function blocked(handler: BeforeRequest, url: string): boolean {
  const answers: boolean[] = [];
  handler({ url } as OnBeforeRequestListenerDetails, (response) => {
    if (response.cancel !== undefined) answers.push(response.cancel);
  });
  const answer = answers[0];
  if (answer === undefined) throw new Error('handler did not answer');
  return answer;
}

describe('mermaid sandbox URL', () => {
  it('loads the app bundle in production and the dev server in development', () => {
    expect(mermaidSandboxUrl(undefined)).toMatch(/^file:\/\/.*\/mermaid-sandbox\/index\.html$/);
    expect(mermaidSandboxUrl('http://localhost:5173/')).toBe(
      'http://localhost:5173/mermaid-sandbox/index.html'
    );
  });

  it('allows the built renderer directory the diagram chunks are split into', () => {
    expect(sandboxAssetPrefix('file:///app/out/renderer/mermaid-sandbox/index.html')).toBe(
      'file:///app/out/renderer/'
    );
  });
});

describe('mermaid sandbox session policy', () => {
  it('permits the app’s own compiled assets and refuses everything else', () => {
    const { session, decide } = fakeSession();
    applySandboxSessionPolicy(session, 'file:///app/out/renderer/mermaid-sandbox/index.html', log);
    const handler = decide();

    expect(blocked(handler, 'file:///app/out/renderer/mermaid-sandbox/index.html')).toBe(false);
    expect(blocked(handler, 'file:///app/out/renderer/assets/mermaidSandbox-abc.js')).toBe(false);

    for (const url of [
      'https://cdn.example/mermaid.js',
      'http://127.0.0.1:9229/',
      'file:///Users/someone/.ssh/id_rsa',
      'file:///app/out/main/index.js',
      'data:text/html,<script>alert(1)</script>',
      'ws://localhost:1234/',
    ]) {
      expect(blocked(handler, url)).toBe(true);
    }
  });

  it('denies permissions and device access outright', () => {
    const { session } = fakeSession();
    applySandboxSessionPolicy(session, 'file:///app/out/renderer/mermaid-sandbox/index.html', log);

    const request = vi.mocked(session.setPermissionRequestHandler).mock.calls[0]?.[0];
    const answer = vi.fn();
    request?.({} as never, 'media', answer, {} as never);
    expect(answer).toHaveBeenCalledWith(false);
    expect(vi.mocked(session.setPermissionCheckHandler).mock.calls[0]?.[0]?.(
      null,
      'media',
      '',
      {} as never
    )).toBe(false);
    expect(vi.mocked(session.setDevicePermissionHandler).mock.calls[0]?.[0]?.({} as never)).toBe(
      false
    );
  });

  it('logs only the scheme of a blocked request, never the target', () => {
    const { session, decide } = fakeSession();
    log.warn.mockClear();
    applySandboxSessionPolicy(session, 'file:///app/out/renderer/mermaid-sandbox/index.html', log);
    blocked(decide(), 'https://evil.example/secret-path?token=abc');

    const [, detail] = log.warn.mock.calls[0] ?? [];
    expect(JSON.stringify(detail)).not.toContain('evil.example');
    expect(detail).toEqual({ scheme: 'https:' });
  });
});

describe('mermaid sandbox creation', () => {
  /** The most recent window the module created. */
  function latest(): (typeof electron.windows)[number] {
    const window = electron.windows.at(-1);
    if (window === undefined) throw new Error('no sandbox window was created');
    return window;
  }

  /** Rejections nobody handled, collected while a test runs. */
  /** Node's own description of an unhandled rejection's reason. */
  type UnhandledReason = Parameters<NodeJS.UnhandledRejectionListener>[0];

  function watchUnhandled(): { seen: UnhandledReason[]; stop: () => void } {
    const seen: UnhandledReason[] = [];
    const listener = (reason: UnhandledReason): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', listener);
    return {
      seen,
      stop: () => {
        process.off('unhandledRejection', listener);
      },
    };
  }

  /** Long enough for Node to decide a rejection had no handler. */
  function drain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
  }

  afterEach(() => {
    electron.control.loadURL = () => Promise.resolve();
    electron.windows.length = 0;
    log.warn.mockClear();
  });

  it('is ready once the isolated page has loaded', async () => {
    const sandbox = createMermaidSandboxWindow({ log, devUrl: 'http://localhost:5173/' });
    latest().once.get('did-finish-load')?.();

    await expect(sandbox.ready()).resolves.toBeUndefined();
    expect(latest().loadURLs).toEqual(['http://localhost:5173/mermaid-sandbox/index.html']);
  });

  it('turns a rejected load into a typed readiness failure rather than an unhandled rejection', async () => {
    const watch = watchUnhandled();
    electron.control.loadURL = () => Promise.reject(new Error('ERR_FILE_NOT_FOUND'));

    const sandbox = createMermaidSandboxWindow({ log });
    await drain();

    // The load never reaches the contents, so no event reports it; the failure
    // arrives only as the rejection `loadURL` returns.
    await expect(sandbox.ready()).rejects.toThrow('MermaidSandboxLoadFailed');
    await drain();
    watch.stop();
    expect(watch.seen).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('settles readiness once when a failed load is reported twice', async () => {
    const watch = watchUnhandled();
    electron.control.loadURL = () => Promise.reject(new Error('ERR_CONNECTION_REFUSED'));

    const sandbox = createMermaidSandboxWindow({ log });
    latest().once.get('did-fail-load')?.();
    await drain();
    // The contents event and the rejected call describe the same failure.
    const first = await rejectionOf(sandbox.ready());
    const second = await rejectionOf(sandbox.ready());

    expect(first).toBeInstanceOf(Error);
    expect(second).toBe(first);
    expect(log.warn).toHaveBeenCalledTimes(1);
    await drain();
    watch.stop();
    expect(watch.seen).toEqual([]);
  });

  it('ignores a lost renderer process after the page has already loaded', async () => {
    const sandbox = createMermaidSandboxWindow({ log });
    latest().once.get('did-finish-load')?.();
    latest().once.get('render-process-gone')?.();

    // Readiness was already decided; a later loss is the running job's problem,
    // not a second answer to a question that was settled.
    await expect(sandbox.ready()).resolves.toBeUndefined();
  });

  it('refuses to run a job once the window is gone', async () => {
    const sandbox = createMermaidSandboxWindow({ log });
    latest().once.get('did-finish-load')?.();
    sandbox.destroy();

    expect(latest().destroyed).toBe(true);
    await expect(
      sandbox.run({
        jobId: 'job-1',
        source: 'flowchart TD\n  A --> B',
        appearance: 'light',
        maxSvgBytes: 1_024,
        maxDimension: 800,
      })
    ).rejects.toThrow('MermaidSandboxDestroyed');
  });
});

describe('mermaid job serialization', () => {
  const job = {
    jobId: 'job-1',
    source: 'flowchart TD\n  A --> B',
    appearance: 'light',
    maxSvgBytes: 1_024,
    maxDimension: 800,
  } as const;

  it('round-trips an ordinary job', () => {
    expect(JSON.parse(encodeJobLiteral(job))).toEqual(job);
  });

  it.each([
    ['a quote and a backslash', 'flowchart TD\n  A["\\"] --> B'],
    ['a script-closing sequence', 'flowchart TD\n  A["</script><script>alert(1)"] --> B'],
    ['a template expression', 'flowchart TD\n  A["${process.exit(1)}`"] --> B'],
    ['the line separator characters', `flowchart TD\n  A[${String.fromCodePoint(0x2028, 0x2029)}]`],
  ])('escapes %s so it cannot end the expression it is embedded in', (_name, source) => {
    const literal = encodeJobLiteral({ ...job, source });

    expect(literal).not.toContain('<');
    expect(literal).not.toMatch(LINE_SEPARATORS);
    // Whatever was written, it comes back as data and only as data.
    expect(JSON.parse(literal)).toEqual({ ...job, source });
  });
});
