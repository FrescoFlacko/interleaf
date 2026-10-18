import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { _electron, expect } from '@playwright/test';
import type { BaseWindow, MessageBoxOptions } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ISOLATED_ELECTRON_SWITCHES, isolatedLaunchEnvironment } from './offline-environment';
import { installMainNetworkGuard } from './main-network-guard';
import { denyAllLocalServer, type DenyAllLocalServer } from './offline-local-server';
import { chooseListboxValue } from './listbox';

export type AppHandle = {
  readonly electronApp: ElectronApplication;
  readonly window: Page;
  readonly userDataDir: string;
  /**
   * The only local-server address this app can reach, and the record of every
   * request it made to it. See `offline-local-server.ts`.
   */
  readonly localServer: DenyAllLocalServer;
  close(options?: { readonly preserveUserData?: boolean }): Promise<void>;
};

export async function launchInterleaf(options?: {
  userDataDir?: string;
  fakeResumeSleep?: boolean;
  testSeam?: boolean;
  /**
   * A directory prepended to `PATH` for the app process.
   *
   * CLI providers are discovered by looking their binary up on `PATH`, so a
   * fixture directory is how a test gets a real, offline CLI provider to appear
   * without a production switch. The app's own spawn path is untouched.
   *
   * It is prepended to the sanitized `PATH` from `offline-environment`, never
   * to the host's — see `OFFLINE_PATH_DIRECTORIES` for why the host's `PATH`
   * never reaches an app under test.
   */
  binDir?: string;
  /**
   * Keeps guided onboarding exactly as the application presents it.
   *
   * Every launch here uses an empty user-data directory, so the application
   * correctly classifies it as a first run and opens the wizard over the shell.
   * A test that is not about onboarding has to get past that the way a person
   * does, so the default is to leave the flow through its own control. Only the
   * tests that assert first-run behaviour opt out.
   */
  preserveOnboarding?: boolean;
  /** Records a Playwright video of the first window into this directory. */
  recordVideoDir?: string;
  /**
   * The app's `HOME`. Defaults to a fresh empty directory removed on close; a
   * spec supplies one only to plant files the app must *not* discover there.
   */
  isolatedHome?: string;
}): Promise<AppHandle> {
  const isCustomDir = options?.userDataDir !== undefined;
  const userDataDir = options?.userDataDir ?? mkdtempSync(path.join(os.tmpdir(), 'interleaf-e2e-'));
  const ownsIsolatedHome = options?.isolatedHome === undefined;
  const isolatedHome = options?.isolatedHome ?? mkdtempSync(path.join(os.tmpdir(), 'interleaf-e2e-home-'));
  const localServer = await denyAllLocalServer();
  const electronApp = await _electron.launch({
    args: [...ISOLATED_ELECTRON_SWITCHES, 'out/main/index.js'],
    ...(options?.recordVideoDir === undefined ? {} : { recordVideo: { dir: options.recordVideoDir, size: { width: 1280, height: 800 } } }),
    env: {
      ...isolatedLaunchEnvironment({ isolatedHome, binDir: options?.binDir }),
      NODE_ENV: 'test',
      INTERLEAF_USER_DATA: userDataDir,
      ...(options?.testSeam === true ? { INTERLEAF_TEST_SEAM: '1' } : {}),
      ...(options?.fakeResumeSleep === true ? { INTERLEAF_FAKE_RESUME_SLEEP: '1' } : {}),
    },
  });
  // Before the window is awaited: main makes no outbound request until the
  // renderer asks for one, and from here on none can leave the machine.
  await installMainNetworkGuard(electronApp);
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  // As early as the bridge exists, so the window in which the app could reach a
  // local server this run does not own is as short as this suite can make it.
  // Best-effort here and only here: the renderer is still hydrating, and a
  // writer that submits the document it hydrated will put the default back —
  // which is what the second, enforced call below is for.
  await pointLocalProviderAtTheTrap(window, localServer.endpoint, { enforce: false });
  if (options?.preserveOnboarding === true) {
    await waitForGuidedOnboarding(window);
  } else {
    await leaveGuidedOnboarding(window);
    keepShellReachableAcrossReloads(window);
  }
  await pointLocalProviderAtTheTrap(window, localServer.endpoint, { rehydrate: true });
  // The reload above put the wizard back for the specs that came to watch it.
  if (options?.preserveOnboarding === true) await waitForGuidedOnboarding(window);
  let processClosed = false;
  let processClosePromise: Promise<void> | null = null;
  let directoryCleaned = false;
  return {
    electronApp,
    window,
    userDataDir,
    localServer,
    close: async (closeOpts) => {
      if (!processClosed) {
        processClosePromise ??= (async () => {
          try {
            await electronApp.close();
            processClosed = true;
          } catch (error) {
            // A failed close must remain retryable. Do not leave the helper
            // claiming the process is closed when Playwright still owns it.
            processClosePromise = null;
            throw error;
          }
        })();
        await processClosePromise;
      }
      if (!isCustomDir && closeOpts?.preserveUserData !== true && !directoryCleaned) {
        directoryCleaned = true;
        rmSync(userDataDir, { recursive: true, force: true });
      }
      if (ownsIsolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    },
  };
}

/**
 * Points this profile's local-server endpoint at the deny-all server this run
 * owns, and confirms it stuck.
 *
 * A fresh profile starts from the documented default, `127.0.0.1:11434`, which
 * is Ollama's port — so on a machine running Ollama the app would discover a
 * ready `local` provider no spec asked for, bind sessions to it, and send turns
 * to a model whose answers no assertion controls. `PATH` sanitization cannot
 * reach that: this provider is a socket, not a binary.
 *
 * This is the real settings IPC writing a real, policy-valid loopback endpoint
 * into an isolated profile — the same path a person takes when they point
 * Interleaf at their own server — so nothing test-only is switched on in the
 * application, and the profile keeps the first-run shape the onboarding
 * classification reads.
 *
 * Called twice per launch, and both times for a reason. The first call is made
 * as soon as the bridge exists, which is the earliest this suite can narrow the
 * window in which the app could reach a server this run does not own. The
 * second is made once the renderer has settled, because every renderer settings
 * writer — panel collapse, panel resize, the wizard — submits the complete
 * document built from the copy it hydrated, so a write that lands
 * mid-hydration is put back by the next one. Read back both times: a silently
 * lost write would hand the suite a live inference server, and the failure
 * would otherwise surface much later as an answer no assertion controls.
 *
 * Writing to main is not sufficient on its own, which is what `rehydrate` is
 * for. The renderer keeps its own copy of the settings document
 * (`useUiStore.loadedSettings`), taken once when it hydrated, and every UI
 * writer — `ResizablePanel.persistLayout`, the Settings modal, the panel
 * collapse effect in `App.tsx` — submits that whole copy back. A copy taken
 * before this write still carries `127.0.0.1:11434`, so the first panel the
 * spec collapses would hand the host's inference port back to main. Reloading
 * is the application's own way of taking a fresh copy: main already holds this
 * run's endpoint by then, so the renderer hydrates from it and every later UI
 * write carries it. The endpoint is read back again afterwards.
 */
export async function pointLocalProviderAtTheTrap(
  page: Page,
  endpoint: string,
  options?: { readonly enforce?: boolean; readonly rehydrate?: boolean }
): Promise<void> {
  await writeLocalEndpoint(page, endpoint, options?.enforce !== false);
  if (options?.rehydrate !== true) return;
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await writeLocalEndpoint(page, endpoint, true);
}

async function writeLocalEndpoint(page: Page, endpoint: string, enforce: boolean): Promise<void> {
  let written = '';
  // A concurrent renderer writer can land between the update and the read back,
  // so the enforced call insists rather than reporting the first stale answer.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    written = await page.evaluate(async (target) => {
      const api = window.interleafAPI;
      const current = await api.settings.get();
      if (current.ai.local.endpoint !== target) {
        await api.settings.update({
          ...current,
          ai: { ...current.ai, local: { ...current.ai.local, endpoint: target } },
        });
      }
      return (await api.settings.get()).ai.local.endpoint;
    }, endpoint);
    if (written === endpoint || !enforce) return;
    await page.waitForTimeout(200);
  }
  throw new Error(
    `The app under test is pointed at ${written}, not this run's deny-all local server (${endpoint}). ` +
      'A local server this suite does not own would answer turns no assertion controls.'
  );
}

/**
 * Settings → AI providers collapses integrations whose CLI is absent under
 * "Not installed (n)". Which ones that is depends on the host, so a spec that
 * needs every row opens the group, as a user would, when it is there.
 */
export async function revealNotInstalledProviders(scope: Locator): Promise<void> {
  // The built-in rows arrive together with their detection; Codex is always one.
  await expect(scope.getByTestId('provider-summary-codex')).toHaveCount(1);
  const toggle = scope.getByTestId('provider-not-installed-toggle');
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

export async function stubOpenDialog(app: AppHandle, filePaths: readonly string[]): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, selectedPaths) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [...selectedPaths], bookmarks: [] });
  }, filePaths);
}

/**
 * Leaves guided onboarding through its own control for this page load.
 *
 * Deterministic rather than opportunistic: main latches the launch verdict
 * before the renderer exists and holds it for the process lifetime, so
 * `onboarding.getLaunchState()` answers whether this page load opens the wizard
 * *before* it has rendered. A verdict of `shouldAutoOpen` makes the wizard a
 * certainty to wait for, and anything else is an immediate no-op — nothing here
 * polls for something that may never arrive, and nothing sleeps.
 *
 * *Finish later* is the exit rather than *Start reading* because it is the one
 * control every stage renders, and the status it records (`finish-later`) is the
 * one that suppresses the wizard, the upgrade banner and the first-action tip on
 * the launches that follow. No production behaviour is bypassed: this is the
 * same button a person clicks.
 *
 * Exported because a page load is not only a launch — reloading the renderer
 * re-asks main for the same latched verdict and opens the wizard again.
 */
async function leaveGuidedOnboarding(page: Page): Promise<void> {
  const opensOnThisLoad = await page.evaluate(
    async () => (await window.interleafAPI.onboarding.getLaunchState()).shouldAutoOpen
  );
  if (!opensOnThisLoad) return;
  const wizard = page.getByTestId('onboarding-wizard');
  // The verdict already says the wizard is coming, so this bound is a failure
  // ceiling rather than a guess: the renderer only opens it once settings have
  // hydrated, and that can land well after `domcontentloaded` on a loaded
  // machine. Waiting shorter would fail a launch that is merely slow.
  await expect(wizard).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('onboarding-finish-later').click();
  await expect(wizard).toBeHidden({ timeout: 10_000 });
}

/**
 * Waits for the wizard without touching it, for the specs that came to test
 * onboarding itself.
 *
 * Its arrival is the renderer's own signal that settings have hydrated, which
 * is what the offline endpoint write needs to survive. Those specs then find
 * the first-run flow exactly where they left it.
 */
async function waitForGuidedOnboarding(page: Page): Promise<void> {
  const opensOnThisLoad = await page.evaluate(
    async () => (await window.interleafAPI.onboarding.getLaunchState()).shouldAutoOpen
  );
  if (!opensOnThisLoad) return;
  await expect(page.getByTestId('onboarding-wizard')).toBeVisible({ timeout: 30_000 });
}

/**
 * Extends the launch helper's "the shell is reachable" contract to the reloads
 * a spec performs itself.
 *
 * Main latches the launch verdict for the process lifetime and the renderer
 * store asks for it on every page load, so `page.reload()` puts the wizard back
 * over the shell even though onboarding was already left. The specs that reload
 * are testing chat, context and naming behaviour rather than onboarding, and
 * each would otherwise need the same line appended to its own reload.
 *
 * The dismissal is therefore attached to `reload` itself, so it completes
 * before the call a spec awaits returns. Nothing is stubbed and no production
 * behaviour changes: the reload is the real one, and what follows it is the
 * same UI exit the launch path already uses. (That a reload resurrects a
 * dismissed wizard at all is an application behaviour, reported separately
 * rather than papered over here.)
 */
function keepShellReachableAcrossReloads(page: Page): void {
  const reload = page.reload.bind(page);
  page.reload = async (options?: Parameters<Page['reload']>[0]) => {
    const response = await reload(options);
    await page.waitForLoadState('domcontentloaded');
    await leaveGuidedOnboarding(page);
    return response;
  };
}

/**
 * The defensive form, for a spec that reaches a point where the wizard may or
 * may not be on screen. `launchInterleaf` has already settled the launch-time
 * flow before any spec body runs, so this only answers for what is visible now,
 * and stays safe to call repeatedly.
 */
export async function dismissOnboardingIfOpen(app: AppHandle): Promise<void> {
  const wizard = app.window.getByTestId('onboarding-wizard');
  if (!(await wizard.isVisible().catch(() => false))) return;
  await app.window.getByTestId('onboarding-finish-later').click();
  await expect(wizard).toBeHidden({ timeout: 10_000 });
}

/** Select the explicitly enabled deterministic agent seam for legacy fixture
 * workflows. Normal launches never expose this option. */
export async function selectFakeAgentForTest(app: AppHandle): Promise<void> {
  const profile = app.window.getByRole('combobox', { name: 'Agent profile' });
  await expect(profile).toBeVisible();
  await chooseListboxValue(profile, 'fake');
  await expect(profile).toHaveAttribute('data-value', 'fake');
}

/** Configure the real OpenRouter IPC/provider path with a deterministic local
 * SSE response. This keeps E2E chat coverage independent of the removed fake
 * provider; the renderer still selects OpenRouter through the normal UI. */
export async function configureOpenRouterTestSeam(app: AppHandle): Promise<void> {
  // Idempotent: the seam's pass-through below reaches the guard, never the
  // network, so a request it does not answer is refused.
  await installMainNetworkGuard(app.electronApp);
  await app.electronApp.evaluate(() => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init);
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      const requestBody = rawBody.toLocaleLowerCase();
      const allSrcs = Array.from(rawBody.matchAll(/id=["'](src-\d+)["']/gu));
      const lastSrc = allSrcs.length > 0 ? allSrcs[allSrcs.length - 1]?.[1] ?? 'src-51' : 'src-51';

      const answer = requestBody.includes('markdown')
        ? '### Grounded Markdown\n\nThe deterministic OpenRouter seam returned a **formatted** answer with an _explicit_ structure [src-1].\n\n- First supporting point\n- Second supporting point\n\n> Evidence remains grounded in the selected document.\n\n```text\nstream-safe example\n```'
        : (requestBody.includes('51-page') || requestBody.includes('51 pages'))
          ? `Initial overview from page 1 [src-1] and conclusion from page 51 [${lastSrc}].`
          : (requestBody.includes('multi-page') || requestBody.includes('explain this multi-page'))
            ? 'Page one covers consensus algorithms [src-1], while page two details leader election [src-2].'
            : 'The document context supports a grounded answer to your question [src-1].';
      const body = [
        `data: {"choices":[{"delta":{"content":${JSON.stringify(answer)}}}]}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await app.window.evaluate(async () => {
    await window.interleafAPI.ai.configureOpenRouter({ apiKey: 'sk-or-v1-e2e-deterministic-seam', model: 'openrouter/auto' });
  });
  // The reload is a fresh page load against the same latched verdict, so guided
  // onboarding opens again over the shell this seam was configured for; a
  // helper-launched window leaves it as part of the reload.
  await app.window.reload();
  await app.window.waitForLoadState('domcontentloaded');
}

type RecordedMessageBoxCall = {
  readonly title: string;
  readonly message: string;
  readonly buttons: readonly string[];
  readonly response: number;
  readonly sequence: number;
};

export async function stubMessageBox(app: AppHandle, response = 1): Promise<void> {
  await app.electronApp.evaluate(({ BaseWindow, dialog }, selectedResponse) => {
    const globalStore = globalThis as { __recordedMessageBoxCalls?: RecordedMessageBoxCall[] };
    globalStore.__recordedMessageBoxCalls ??= [];
    // Both published overloads land here: the window-scoped call passes the
    // options second, the app-modal call passes them first.
    dialog.showMessageBox = ((
      browserWindowOrOptions: BaseWindow | MessageBoxOptions,
      maybeOptions?: MessageBoxOptions
    ) => {
      const options = browserWindowOrOptions instanceof BaseWindow ? maybeOptions : browserWindowOrOptions;
      if (options === undefined) {
        throw new Error('showMessageBox was called with a window but no options');
      }
      const sequence = (globalStore.__recordedMessageBoxCalls?.length ?? 0) + 1;
      const call: RecordedMessageBoxCall = {
        title: options.title ?? '',
        message: options.message,
        buttons: options.buttons ? [...options.buttons] : [],
        response: selectedResponse,
        sequence,
      };
      globalStore.__recordedMessageBoxCalls?.push(call);
      return Promise.resolve({ response: selectedResponse, checkboxChecked: false });
    });
  }, response);
}

export async function getRecordedMessageBoxCalls(app: AppHandle): Promise<readonly RecordedMessageBoxCall[]> {
  return await app.electronApp.evaluate(() => {
    const globalStore = globalThis as { __recordedMessageBoxCalls?: RecordedMessageBoxCall[] };
    return globalStore.__recordedMessageBoxCalls ? [...globalStore.__recordedMessageBoxCalls] : [];
  });
}

export async function resetRecordedMessageBoxCalls(app: AppHandle): Promise<void> {
  await app.electronApp.evaluate(() => {
    const globalStore = globalThis as { __recordedMessageBoxCalls?: RecordedMessageBoxCall[] };
    globalStore.__recordedMessageBoxCalls = [];
  });
}

/**
 * Real-pixel window capture via Electron's own compositor API, bound to the
 * exact BrowserWindow that owns `app.window` (never getAllWindows()[0]).
 * Playwright's CDP screenshot mis-samples zoomed fixed/transformed layers in
 * this app, so zoomed evidence comes from webContents.capturePage().
 */
export async function captureWindowPng(app: AppHandle, absolutePath: string): Promise<number> {
  let browserWindow: Awaited<ReturnType<typeof app.electronApp.browserWindow>>;
  try {
    browserWindow = await app.electronApp.browserWindow(app.window);
  } catch (error) {
    throw new Error(`captureWindowPng: page-to-window mapping failed: ${String(error)}`);
  }
  const png: readonly number[] | null = await browserWindow.evaluate((win) => {
    const contents: {
      capturePage: () => Promise<{ toPNG: () => Uint8Array }>;
    } = win.webContents;
    return contents
      .capturePage()
      .then((image) => Array.from(image.toPNG()))
      .catch((): readonly number[] | null => null);
  });
  if (png === null || png.length <= 2048) throw new Error('captureWindowPng: no usable pixels captured');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(absolutePath, Buffer.from(png));
  return png.length;
}

/**
 * Leaves the open document for the library.
 *
 * The reader header no longer carries a Library control: the library rail is
 * the one place that names library destinations, and every entry in it closes
 * whatever is being read first. This walks that real path — the sidebar is
 * revealed if the layout has it collapsed or behind the compact drawer — and
 * re-enters the section that is already active, so returning to the library
 * does not silently move the selection somewhere the test did not ask for.
 */
export async function returnToLibrary(app: AppHandle): Promise<void> {
  // Focus mode hides the rail along with the rest of the chrome, so it is left
  // first, exactly as a reader would leave it before navigating.
  const focusToggle = app.window.getByTestId('reader-focus-button');
  if ((await focusToggle.count()) > 0 && (await focusToggle.first().getAttribute('aria-pressed')) === 'true') {
    await app.window.keyboard.press('Escape');
    await expect(focusToggle.first()).toHaveAttribute('aria-pressed', 'false');
  }
  const sidebar = app.window.getByTestId('sidebar-library').first();
  if (!(await sidebar.isVisible().catch(() => false))) {
    await app.window.getByTestId('toggle-left-panel').click();
    await expect(sidebar).toBeVisible();
  }
  const sections = sidebar.locator('nav[aria-label="Library sections"] button');
  const active = sidebar.locator('nav[aria-label="Library sections"] button.font-semibold');
  const target = (await active.count()) > 0 ? active.first() : sections.first();
  await target.click();
  await expect(app.window.getByTestId('library-view')).toBeVisible();
}

/**
 * Ensures the companion drawer is open and at rest, opening it through its
 * header toggle only if needed.
 *
 * The drawer opens at launch by default, but only once settings hydrate
 * (`startup-library-focus.spec.ts` asserts that), so a geometry-sensitive spec
 * calls this to measure from the settled open layout rather than racing the
 * launch. Safe to call when the drawer is already open.
 */
export async function openCompanionPanel(app: Pick<AppHandle, 'window'>): Promise<void> {
  const toggle = app.window.getByTestId('toggle-right-panel');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(app.window.getByTestId('companion-panel')).toBeVisible();
  // Let the drawer finish gliding open, so the spec starts from the same
  // resting layout a drawer that was already open gave it.
  await expect
    .poll(() => app.window.getByTestId('resizable-panel-right').evaluate((node) => node.getAnimations({ subtree: true }).length))
    .toBe(0);
}

/**
 * Chooses a model in the composer's picker by exact provider and model ID, as
 * one combined choice, and waits for the picker to close. Without a model ID it
 * takes that provider's first row.
 */
export async function chooseChatModel(page: Page, providerId: string, modelId?: string): Promise<void> {
  await page.getByTestId('chat-model-picker').click();
  const popover = page.getByTestId('chat-model-picker-popover');
  await expect(popover).toBeVisible();
  const model = modelId === undefined ? '' : `[data-model-id="${modelId}"]`;
  await popover.locator(`[role="option"][data-provider-id="${providerId}"]${model}`).first().click();
  await expect(popover).toHaveCount(0);
}

/**
 * Launches open maximized to the display's work area. Specs whose geometry
 * depends on the window's restored default size (1400×900) restore it
 * explicitly rather than inheriting whatever the test display's work area is.
 */
export async function restoreDefaultWindowSize(app: AppHandle): Promise<void> {
  const browserWindow = await app.electronApp.browserWindow(app.window);
  await browserWindow.evaluate((win) => {
    win.unmaximize();
    win.setSize(1400, 900);
  });
  await expect
    .poll(() => browserWindow.evaluate((win) => {
      const { width, height } = win.getBounds();
      return !win.isMaximized() && width === 1400 && height === 900;
    }))
    .toBe(true);
}

/**
 * The Search panel's own live status line.
 *
 * `role="status"` stopped being unique to Search once the companion tab bar
 * grew an sr-only status for the shared Chat/Agent text size, so an unscoped
 * `getByRole('status')` now matches two regions and `.first()` matches the
 * wrong one. Scoping to the search panel keeps the exact assertions while
 * naming the region they were always about.
 */
export function searchStatus(app: AppHandle): Locator {
  return app.window.getByTestId('search-panel').getByRole('status');
}
