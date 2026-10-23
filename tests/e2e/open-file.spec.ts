import { _electron, expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, captureWindowPng, configureOpenRouterTestSeam, launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle } from './helpers';
import { ISOLATED_ELECTRON_SWITCHES, isolatedLaunchEnvironment } from './offline-environment';
import { installMainNetworkGuard } from './main-network-guard';
import { makeMarkdownFixture, makePdfFixture } from '../fixtures/document-fixtures';

/** Optional evidence directory supplied by the supervising harness. */
const ARTIFACTS = process.env.INTERLEAF_E2E_ARTIFACTS;

/** Text that only the opened files contain, so any durable copy of them is findable. */
const OPENED_MARKER = 'Quillfeather marginalia';

async function listLibrary(page: Page): Promise<readonly string[]> {
  const documents = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
  return documents.map((document) => document.title);
}

async function currentDocumentId(page: Page): Promise<string> {
  const id = await page.getByTestId('reader-view').getAttribute('data-document-id');
  if (id === null) throw new Error('The reader does not name its document.');
  return id;
}

async function completedMessages(page: Page, documentId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const [session] = await window.interleafAPI.chat.listSessions(id);
    if (!session) return 0;
    const messages = await window.interleafAPI.chat.listMessages(session.id);
    return messages.filter((message) => message.status === 'complete').length;
  }, documentId);
}

/** Every byte the profile keeps, searched for the opened files' text. */
function profileContains(directory: string, needle: string): boolean {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).some((entry) => {
    const path = join(directory, entry);
    return statSync(path).isFile() && readFileSync(path).includes(needle);
  });
}

test.describe('Open a file without adding it to the library', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let notesPath: string;
  let paperPath: string;
  let keptPath: string;

  test.beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-open-file-e2e-'));
    notesPath = join(fixtureDir, 'Field_Notes.MD');
    paperPath = join(fixtureDir, 'Survey_Paper.pdf');
    keptPath = join(fixtureDir, 'Kept_Book.pdf');
    writeFileSync(notesPath, makeMarkdownFixture({
      title: 'Field Notes',
      body: `# Field Notes\n\n## Observations\n\n${OPENED_MARKER} fill the notebook margins.\n\nA second paragraph about distributed consensus.\n`,
    }));
    writeFileSync(paperPath, makePdfFixture({ title: 'Survey Paper', author: 'Interleaf QA', pageLines: [[`${OPENED_MARKER} in a survey.`]] }));
    writeFileSync(keptPath, makePdfFixture({ title: 'Kept Book', author: 'Interleaf QA', pageLines: [['A book that belongs in the library.']] }));
    if (ARTIFACTS !== undefined) mkdirSync(join(ARTIFACTS, 'video'), { recursive: true });
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function evidence(name: string): Promise<void> {
    if (ARTIFACTS !== undefined) await captureWindowPng(app, join(ARTIFACTS, name));
  }

  test('reads a file, asks AI about it, and leaves the library and profile unchanged', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-open-file-profile-'));
    app = await launchInterleaf({ userDataDir, ...(ARTIFACTS === undefined ? {} : { recordVideoDir: join(ARTIFACTS, 'video') }) });
    await configureOpenRouterTestSeam(app);
    const page = app.window;

    await stubOpenDialog(app, [keptPath]);
    await page.getByTestId('import-files-button').click();
    await expect(page.getByTestId('success-banner')).toBeVisible();
    expect(await listLibrary(page)).toEqual(['Kept Book']);

    // Open File reads the chosen file where it is.
    await stubOpenDialog(app, [notesPath]);
    await page.getByTestId('library-open-file').click();
    await expect(page.getByTestId('reader-view')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Observations' })).toBeVisible();
    await expect(page.getByText(OPENED_MARKER)).toBeVisible();
    const notesId = await currentDocumentId(page);
    expect(await listLibrary(page)).toEqual(['Kept Book']);
    await expect(page.locator('body')).not.toContainText(/temporary|ephemeral|not saved/i);
    await evidence('open-file-markdown.png');

    // Ask Reader AI through the offline OpenRouter fixture.
    await page.getByRole('tab', { name: 'Chat' }).click();
    await expect(page.getByRole('region', { name: 'AI research chat' })).toBeVisible();
    await chooseChatModel(page, 'openrouter', 'openrouter/auto');
    await expect(page.getByTestId('chat-model-picker')).toContainText('OpenRouter');
    const composer = page.getByLabel('Message Reader AI');
    await composer.fill('What fills the notebook margins?');
    await composer.press('Enter');
    await expect.poll(() => completedMessages(page, notesId)).toBe(2);
    await expect(page.getByRole('article').filter({ hasText: 'Reader AI' })).toContainText('deterministic OpenRouter seam');
    await expect(page.locator('body')).not.toContainText(/temporary|ephemeral|not saved/i);
    await evidence('open-file-markdown-chat.png');

    // Opening another file with the shortcut replaces the first one.
    await stubOpenDialog(app, [paperPath]);
    await page.keyboard.press('ControlOrMeta+O');
    await expect(page.getByTestId('pdf-canvas-p1')).toBeVisible();
    const paperId = await currentDocumentId(page);
    expect(paperId).not.toBe(notesId);
    await expect(page.evaluate(async (id) => window.interleafAPI.chat.listSessions(id), notesId)).rejects.toThrow();
    await evidence('open-file-pdf.png');

    // Closing discards the file and its chat; the library is exactly as it was.
    await returnToLibrary(app);
    await expect(page.getByTestId('library-view')).toBeVisible();
    expect(await listLibrary(page)).toEqual(['Kept Book']);
    await expect(page.evaluate(async (id) => window.interleafAPI.chat.listSessions(id), paperId)).rejects.toThrow();
    await expect.poll(() => readdirSync(join(userDataDir, 'open-files'))).toEqual([]);
    await evidence('open-file-closed-library.png');
    expect(readFileSync(notesPath, 'utf8')).toContain(OPENED_MARKER);

    // Nothing about either file survives a restart.
    await app.close();
    expect(profileContains(userDataDir, OPENED_MARKER)).toBe(false);
    app = await launchInterleaf({ userDataDir });
    expect(await listLibrary(app.window)).toEqual(['Kept Book']);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('opens a file named on the command line of a cold launch', async () => {
    // A first launch settles onboarding, as a person would have before using Open With.
    const userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-open-file-cold-'));
    app = await launchInterleaf({ userDataDir });
    await app.close();

    const coldHome = mkdtempSync(join(tmpdir(), 'interleaf-e2e-home-'));
    const cold = await _electron.launch({
      args: [...ISOLATED_ELECTRON_SWITCHES, 'out/main/index.js', notesPath],
      ...(ARTIFACTS === undefined ? {} : { recordVideo: { dir: join(ARTIFACTS, 'video'), size: { width: 1280, height: 800 } } }),
      env: { ...isolatedLaunchEnvironment({ isolatedHome: coldHome }), NODE_ENV: 'test', INTERLEAF_USER_DATA: userDataDir },
    });
    await installMainNetworkGuard(cold);
    try {
      const page = await cold.firstWindow();
      await expect(page.getByTestId('reader-view')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Observations' })).toBeVisible();
      await expect(page.getByText(OPENED_MARKER)).toBeVisible();
      expect(await listLibrary(page)).toEqual([]);
      expect(await cold.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
      if (ARTIFACTS !== undefined) await page.screenshot({ path: join(ARTIFACTS, 'open-file-cold-launch.png') });
    } finally {
      await cold.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(coldHome, { recursive: true, force: true });
    }
  });

  test('opens a file handed over by a second launch or by macOS, in the existing window', async () => {
    app = await launchInterleaf(ARTIFACTS === undefined ? undefined : { recordVideoDir: join(ARTIFACTS, 'video') });
    const page = app.window;
    const executable = await app.electronApp.evaluate(() => process.execPath);

    // A second launch passes its command line to the running instance and exits.
    const secondHome = mkdtempSync(join(tmpdir(), 'interleaf-e2e-home-'));
    try {
      await promisify(execFile)(executable, [...ISOLATED_ELECTRON_SWITCHES, 'out/main/index.js', notesPath], {
        env: { ...isolatedLaunchEnvironment({ isolatedHome: secondHome }), NODE_ENV: 'test', INTERLEAF_USER_DATA: app.userDataDir },
        timeout: 30_000,
      });
    } finally {
      rmSync(secondHome, { recursive: true, force: true });
    }
    await expect(page.getByText(OPENED_MARKER)).toBeVisible();
    expect(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await listLibrary(page)).toEqual([]);
    await evidence('open-file-second-instance.png');

    // Finder's "Open With" arrives as an open-file event. A second notification
    // for the same request (as a window mounting while it arrives would see)
    // makes a duplicate claim that finds nothing pending; it must not cancel
    // the claim that took the file.
    await app.electronApp.evaluate(({ app: electronApp, BrowserWindow }, filePath) => {
      electronApp.emit('open-file', { preventDefault: () => undefined }, filePath);
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('files:command', 'open-pending');
    }, paperPath);
    await expect(page.getByTestId('pdf-canvas-p1')).toBeVisible();

    // A file that is not what its name says is refused, and the reader keeps its document.
    const disguised = join(fixtureDir, 'Disguised.docx');
    writeFileSync(disguised, makePdfFixture({ title: 'Disguised', author: 'Interleaf QA', pageLines: [['Not a Word file.']] }));
    await stubOpenDialog(app, [disguised]);
    await page.getByTestId('library-open-file').click();
    await expect(page.getByTestId('open-file-error')).toBeVisible();
    await expect(page.getByTestId('pdf-canvas-p1')).toBeVisible();
    await evidence('open-file-refused.png');
    await page.getByRole('button', { name: 'Dismiss error' }).click();
    await expect(page.getByTestId('open-file-error')).toHaveCount(0);
    expect(await listLibrary(page)).toEqual([]);
  });
});
