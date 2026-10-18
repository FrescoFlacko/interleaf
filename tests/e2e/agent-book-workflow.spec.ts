import { expect, test, type Locator } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, selectFakeAgentForTest, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Agent work inside a book, end to end through the deterministic fake agent:
 * a page range is validated and attached by keyboard, a run starts and
 * resumes, over-long prompts are refused with a reason, and nothing from one
 * book's context or runs appears in another book.
 */
test.describe('Agent work within a book', () => {
  let app: AppHandle;
  let workspace: string;

  test.beforeEach(async () => {
    app = await launchInterleaf({ testSeam: true });
    workspace = mkdtempSync(join(tmpdir(), 'interleaf-agent-book-'));
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  /** Screenshots go to an evidence directory when one is supplied. */
  async function capture(name: string): Promise<void> {
    await app.window.screenshot({ path: evidencePath(name) });
  }

  function evidencePath(name: string): string {
    const directory = process.env.INTERLEAF_E2E_EVIDENCE_DIR;
    return directory === undefined ? test.info().outputPath(name) : join(directory, name);
  }

  /**
   * The window as painted. Under a zoom factor, Playwright's screenshot clips
   * to unzoomed viewport metrics and returns only the top-left corner.
   */
  async function captureWindow(name: string): Promise<void> {
    const png = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage();
      return image.toPNG().toString('base64');
    });
    writeFileSync(evidencePath(name), Buffer.from(png, 'base64'));
  }

  async function openBook(documentId: string): Promise<void> {
    if (!(await app.window.getByTestId('library-view').isVisible())) {
      const allDocuments = app.window.getByTestId('nav-all-documents');
      if (!(await allDocuments.isVisible())) await app.window.getByRole('button', { name: 'Toggle Library sidebar' }).click();
      await allDocuments.click();
      await expect(app.window.getByTestId('library-view')).toBeVisible();
    }
    await app.window.getByTestId(`read-doc-${documentId}`).click();
  }

  async function expectFocused(locator: Locator): Promise<void> {
    await expect(locator).toBeFocused({ timeout: 5_000 });
  }

  test('attaches pages by keyboard, starts and resumes, and keeps each book to itself', async () => {
    const bookAPath = join(workspace, 'book-a.pdf');
    const bookBPath = join(workspace, 'book-b.pdf');
    writeFileSync(bookAPath, makePdfFixture({
      title: 'Agent Book A', author: 'Interleaf',
      pageLines: [['Book A page one text.'], ['Book A page two text.'], ['Book A page three text.']],
    }));
    writeFileSync(bookBPath, makePdfFixture({ title: 'Agent Book B', author: 'Interleaf', pageLines: [['Book B only page.']] }));
    await stubOpenDialog(app, [bookAPath, bookBPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documents = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    const bookA = documents.find((document) => document.title === 'Agent Book A');
    const bookB = documents.find((document) => document.title === 'Agent Book B');
    if (bookA === undefined || bookB === undefined) throw new Error('Fixture books were not imported.');

    await openBook(bookA.id);
    await app.window.getByRole('tab', { name: /Agent/i }).click();
    // The deterministic agent may already be the only installed profile; reopening
    // the listbox while profiles refresh races its re-render.
    const agentProfile = app.window.getByRole('combobox', { name: 'Agent profile' });
    await expect(agentProfile).toBeVisible();
    if ((await agentProfile.getAttribute('data-value')) !== 'fake') await selectFakeAgentForTest(app);
    await stubOpenDialog(app, [workspace]);
    await app.window.getByRole('button', { name: 'Choose…' }).click();
    await expect(app.window.getByTestId('agent-no-context-notice')).toBeVisible();
    await capture('agent-panel-default-100.png');

    // The page picker opens focused, refuses a fractional page with a stated
    // reason, and Escape returns focus to the control that opened it.
    const trigger = app.window.getByTestId('agent-pages-trigger');
    await trigger.focus();
    await app.window.keyboard.press('Enter');
    const start = app.window.getByLabel('Start', { exact: true });
    await expectFocused(start);
    await start.fill('1.5');
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByTestId('agent-pages-error')).toHaveText('Page numbers must be positive whole numbers.');
    await expect(start).toHaveAttribute('aria-invalid', 'true');
    // Capture once the 150ms entry fade has finished, not mid-transition.
    await expect(app.window.getByRole('dialog', { name: 'Add pages to agent context' })).toHaveCSS('opacity', '1');
    await capture('agent-pages-error-100.png');
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByRole('dialog', { name: 'Add pages to agent context' })).toHaveCount(0);
    await expectFocused(trigger);

    // A valid range attaches by keyboard alone, and focus lands on Remove.
    await app.window.keyboard.press('Enter');
    await expectFocused(start);
    await start.fill('1');
    await app.window.keyboard.press('Tab');
    await app.window.keyboard.type('2');
    await app.window.keyboard.press('Enter');
    await expect(app.window.getByTestId('agent-context-range')).toHaveText('Pages 1–2');
    await expect(app.window.getByTestId('agent-context-summary')).toContainText('Book A page one text.');
    await expectFocused(app.window.getByTestId('agent-remove-context'));
    await capture('agent-context-attached-100.png');

    // An over-long task is refused with its reason before anything starts.
    const task = app.window.getByLabel('Task description');
    await task.fill('x'.repeat(100_001));
    await expect(app.window.getByTestId('agent-session-status')).toContainText('Shorten the prompt to 100,000 characters or fewer');
    await expect(app.window.getByTestId('agent-start-button')).toBeDisabled();

    await task.fill('summarize the attached pages');
    await app.window.getByTestId('agent-start-button').click();
    await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 15_000 });
    const [run] = await app.window.evaluate((documentId) => window.interleafAPI.agent.listSessions(documentId), bookA.id);
    expect(run?.documentId).toBe(bookA.id);
    expect(run?.contextSummary ?? '').toContain('Pages 1–2');

    // The follow-up refuses an over-long prompt, then resumes by keyboard.
    const followUp = app.window.getByLabel('Follow-up prompt');
    await followUp.fill('y'.repeat(100_001));
    await expect(app.window.getByTestId('agent-resume-length')).toContainText('Shorten the prompt to 100,000 characters or fewer');
    await expect(followUp).toHaveAttribute('aria-invalid', 'true');
    await expect(app.window.getByTestId('agent-resume-button')).toBeDisabled();
    await followUp.fill('continue with page three');
    await followUp.focus();
    await app.window.keyboard.press('Tab');
    await expectFocused(app.window.getByTestId('agent-resume-button'));
    await app.window.keyboard.press('Enter');
    // The composer steps aside while the resumed run is live; the panel's
    // status line reports it instead.
    await expect.poll(async () => {
      const detail = await app.window.evaluate((ids) => window.interleafAPI.agent.getSession(ids.run, ids.book), { run: run!.id, book: bookA.id });
      return detail?.events.filter((event) => event.type === 'started').length ?? 0;
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 15_000 });
    await expect(followUp).toHaveValue('');
    // The composer was away while the run was live; what it was asked survived
    // that, and the latest follow-up is recalled first.
    await followUp.focus();
    await app.window.keyboard.press('ArrowUp');
    await expect(followUp).toHaveValue('continue with page three');
    // An unsent idea stays with this run, across zoom, another book and back.
    await followUp.fill('an unsent idea for this run');
    await capture('agent-session-resumed-100.png');

    await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2.0); });
    // At 200% the companion becomes a drawer; the run and its follow-up stay usable there.
    const drawer = app.window.getByTestId('compact-drawer-right');
    if (!(await drawer.isVisible())) await app.window.getByRole('button', { name: 'Toggle companion panel' }).click();
    await expect(drawer).toBeVisible();
    const zoomedFollowUp = drawer.getByLabel('Follow-up prompt');
    await zoomedFollowUp.scrollIntoViewIfNeeded();
    await expect(zoomedFollowUp).toBeInViewport();
    await expect(drawer.getByTestId('agent-resume-button')).toBeInViewport();
    // Capture once the 280ms slide has ended with the drawer against the right edge.
    await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
    await expect.poll(() => drawer.evaluate((element) => Math.round(element.getBoundingClientRect().right) === window.innerWidth
      && element.getAnimations({ subtree: false }).length === 0)).toBe(true);
    await captureWindow('agent-session-zoom-200.png');
    await app.window.keyboard.press('Escape');
    await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.0); });
    await expect(drawer).toHaveCount(0);

    // Another book shows none of book A's context or runs.
    await openBook(bookB.id);
    await app.window.getByRole('tab', { name: /Agent/i }).click();
    await expect(app.window.getByTestId('agent-no-context-notice')).toBeVisible({ timeout: 10_000 });
    await expect(app.window.getByTestId('agent-context-summary')).toHaveCount(0);
    await expect(app.window.getByText('summarize the attached pages')).toHaveCount(0);
    expect(await app.window.evaluate((documentId) => window.interleafAPI.agent.listSessions(documentId), bookB.id)).toEqual([]);
    await expect(app.window.getByText('Book B only page.')).toBeVisible({ timeout: 10_000 });
    await capture('agent-other-book-100.png');

    // Book A's run is still there when the reader comes back.
    await openBook(bookA.id);
    await app.window.getByRole('tab', { name: /Agent/i }).click();
    await app.window.getByTestId('agent-session-list').getByRole('button', { name: /All sessions/ }).click();
    await expect(app.window.getByTestId('agent-session-list')).toContainText('summarize the attached pages', { timeout: 10_000 });
    await app.window.getByRole('list', { name: 'All agent sessions' }).getByRole('button', { name: /summarize the attached pages/ }).click();
    await expect(app.window.getByLabel('Follow-up prompt')).toHaveValue('an unsent idea for this run', { timeout: 10_000 });
  });

  test('shows a whole-book capture in progress, and cancelling it attaches nothing', async () => {
    // Enough pages that reading the whole book is still under way when the
    // reader acts; the capture's progress, not its speed, is what is checked.
    const pageCount = 6_000;
    const bookPath = join(workspace, 'long-book.pdf');
    writeFileSync(bookPath, makePdfFixture({
      title: 'Agent Long Book', author: 'Interleaf',
      pageLines: Array.from({ length: pageCount }, (_unused, index) => [`Long book page ${String(index + 1)} text.`]),
    }));
    await stubOpenDialog(app, [bookPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible({ timeout: 30_000 });
    const documents = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    const book = documents.find((document) => document.title === 'Agent Long Book');
    if (book === undefined) throw new Error('Fixture book was not imported.');

    await openBook(book.id);
    await expect(app.window.getByText('Long book page 1 text.')).toBeVisible({ timeout: 60_000 });
    await app.window.getByRole('tab', { name: /Agent/i }).click();
    const agentProfile = app.window.getByRole('combobox', { name: 'Agent profile' });
    await expect(agentProfile).toBeVisible();
    if ((await agentProfile.getAttribute('data-value')) !== 'fake') await selectFakeAgentForTest(app);
    await stubOpenDialog(app, [workspace]);
    await app.window.getByRole('button', { name: 'Choose…' }).click();
    await app.window.getByLabel('Task description').fill('summarize the whole book');

    // Cancelling at once withdraws the capture: nothing lands later, and focus
    // returns to the control that began it.
    const wholeBook = app.window.getByTestId('agent-attach-entire-doc');
    const pending = app.window.getByTestId('agent-context-pending');
    const cancel = app.window.getByRole('button', { name: 'Cancel attaching Entire document' });
    await wholeBook.click();
    await cancel.click({ timeout: 5_000 });
    await expect(pending).toHaveCount(0);
    await expect(app.window.getByTestId('agent-no-context-notice')).toBeVisible();
    await expectFocused(wholeBook);
    await app.window.waitForTimeout(3_000);
    await expect(app.window.getByTestId('agent-context-summary')).toHaveCount(0);
    await expect(app.window.getByTestId('agent-start-button')).toBeEnabled();
    await capture('agent-context-cancelled-100.png');

    // While the book is read, the panel says what is being attached and Start
    // waits for it rather than running without it.
    await wholeBook.click();
    await expect(pending.getByRole('status')).toHaveText('Attaching Entire document…');
    await expect(app.window.getByTestId('agent-start-button')).toBeDisabled();
    await expect(app.window.getByTestId('agent-session-status')).toContainText('Attaching Entire document… Start once it is attached, or cancel it.');
    await capture('agent-context-pending-100.png');
    await expect(app.window.getByTestId('agent-context-summary')).toBeVisible({ timeout: 60_000 });
    await app.window.getByTestId('agent-remove-context').click();

    // At 200% the same progress and Cancel are shown in the drawer.
    await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2.0); });
    const drawer = app.window.getByTestId('compact-drawer-right');
    if (!(await drawer.isVisible())) await app.window.getByRole('button', { name: 'Toggle companion panel' }).click();
    await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
    await expect.poll(() => drawer.evaluate((element) => Math.round(element.getBoundingClientRect().right) === window.innerWidth
      && element.getAnimations({ subtree: false }).length === 0)).toBe(true);
    const zoomedWholeBook = drawer.getByTestId('agent-attach-entire-doc');
    await zoomedWholeBook.scrollIntoViewIfNeeded();
    await zoomedWholeBook.click();
    await expect(drawer.getByRole('button', { name: 'Cancel attaching Entire document' })).toBeInViewport();
    await captureWindow('agent-context-pending-zoom-200.png');

    // Left alone, the capture lands and Start runs with it.
    await expect(drawer.getByTestId('agent-context-summary')).toBeVisible({ timeout: 60_000 });
    await expect(drawer.getByTestId('agent-context-pending')).toHaveCount(0);
    await app.window.keyboard.press('Escape');
    await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.0); });
    await expect(drawer).toHaveCount(0);
    await app.window.getByTestId('agent-start-button').click();
    await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 15_000 });
    const [run] = await app.window.evaluate((documentId) => window.interleafAPI.agent.listSessions(documentId), book.id);
    expect(run?.contextSummary ?? '').toContain('Entire document');
  });
});
