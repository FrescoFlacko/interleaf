import { expect, test, type Locator } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, selectFakeAgentForTest, stubOpenDialog, type AppHandle } from './helpers';
import { chooseListboxValue } from './listbox';
import { makePdfFixture } from '../fixtures/document-fixtures';

/** The installed axe bundle, injected into the window rather than bundled. */
const AXE_SOURCE = join(process.cwd(), 'node_modules/axe-core/axe.min.js');

/**
 * The Agent panel's run settings, prompt recall and Discard Sandbox in the real
 * app, through the deterministic fake agent: a refresh of the panel leaves an
 * open menu alone, a recalled prompt can be edited at once, and discarding a
 * run's sandbox is confirmed first — at a 280px panel and in the 200% drawer.
 */
test.describe('Agent run settings, recall and discard confirmation', () => {
  let app: AppHandle;
  let workspace: string;

  test.beforeEach(async () => {
    app = await launchInterleaf({ testSeam: true });
    workspace = mkdtempSync(join(tmpdir(), 'interleaf-agent-confirm-'));
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  function evidencePath(name: string): string {
    const directory = process.env.INTERLEAF_E2E_EVIDENCE_DIR;
    return directory === undefined ? test.info().outputPath(name) : join(directory, name);
  }

  /** The window as painted; Playwright's own screenshot clips under a zoom factor. */
  async function captureWindow(name: string): Promise<void> {
    const png = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage();
      return image.toPNG().toString('base64');
    });
    writeFileSync(evidencePath(name), Buffer.from(png, 'base64'));
  }

  async function setPanelWidth(width: number): Promise<void> {
    const resizer = app.window.getByTestId('panel-resizer-right');
    await resizer.focus();
    await app.window.keyboard.press('End');
    const steps = (560 - width) / 16;
    for (let step = 0; step < steps; step += 1) await app.window.keyboard.press('ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow', String(width));
  }

  async function openBook(): Promise<string> {
    const pdfPath = join(workspace, 'confirm-book.pdf');
    writeFileSync(pdfPath, makePdfFixture({ title: 'Confirm Book', author: 'Interleaf', pageLines: [['A page for the agent.']] }));
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (document === undefined) throw new Error('Fixture book was not imported.');
    await app.window.getByTestId(`read-doc-${document.id}`).click();
    await app.window.getByRole('tab', { name: /Agent/i }).click();
    return document.id;
  }

  /** An open menu stays open, and focused, for as long as a refresh could take. */
  async function expectStaysOpen(combobox: Locator): Promise<void> {
    for (let check = 0; check < 10; check += 1) {
      await expect(combobox).toHaveAttribute('aria-expanded', 'true');
      await expect(combobox).toBeEnabled();
      await app.window.waitForTimeout(100);
    }
  }

  /** Tries to focus a control behind the confirmation; the confirmation must keep focus. */
  async function expectFocusHeld(confirmation: Locator, background: Locator): Promise<void> {
    await background.evaluate((element) => { (element as HTMLElement).focus(); });
    expect(await confirmation.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  }

  async function axeViolations(selector: string): Promise<readonly AxeRunViolation[]> {
    await app.window.evaluate(`(() => { ${readFileSync(AXE_SOURCE, 'utf8')} })()`);
    return app.window.evaluate(async (target) => {
      const results = await window.axe.run(target, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
      return results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes }));
    }, selector);
  }

  test('keeps menus open across a refresh, recalls an editable prompt, and confirms a discard', async () => {
    const documentId = await openBook();
    await selectFakeAgentForTest(app);

    // Showing the panel again reloads it for the same book. A menu opened at
    // that moment stays open, and a choice in it lands.
    const profile = app.window.getByRole('combobox', { name: 'Agent profile' });
    const model = app.window.getByTestId('agent-model-select');
    for (const combobox of [profile, model]) {
      await app.window.getByRole('tab', { name: /Search/i }).click();
      await app.window.getByRole('tab', { name: /Agent/i }).click();
      await combobox.click();
      await expectStaysOpen(combobox);
      await combobox.press('Escape');
      await expect(combobox).toHaveAttribute('aria-expanded', 'false');
    }
    await app.window.getByRole('tab', { name: /Search/i }).click();
    await app.window.getByRole('tab', { name: /Agent/i }).click();
    await chooseListboxValue(model, 'fixture-model-b');
    await expect(profile).toHaveAttribute('data-value', 'fake');

    await stubOpenDialog(app, [workspace]);
    await app.window.getByRole('button', { name: 'Choose…' }).click();
    await chooseListboxValue(app.window.getByTestId('composer-execution-mode-select'), 'isolated-copy');
    const task = app.window.getByLabel('Task description');
    await task.fill('write the fixture change');
    await app.window.getByTestId('agent-start-button').click();
    await expect(app.window.getByText('Session completed.', { exact: true })).toBeVisible({ timeout: 15_000 });
    const [run] = await app.window.evaluate((id) => window.interleafAPI.agent.listSessions(id), documentId);
    if (run === undefined) throw new Error('The run was not recorded.');
    expect(run.executionMode).toBe('isolated-copy');
    const sandbox = join(app.userDataDir, 'agent-workspaces', run.id, 'workspace');
    expect(existsSync(sandbox)).toBe(true);
    expect(existsSync(join(workspace, 'interleaf-fixture-change.txt'))).toBe(false);

    // A recalled prompt is editable at once: a caret moved straight after
    // recall, with nothing waited for, is where the next keystroke lands.
    await app.window.getByTestId('agent-back-button').click();
    await task.focus();
    await app.window.keyboard.press('ArrowUp');
    for (const key of Array<string>('change'.length).fill('ArrowLeft')) await app.window.keyboard.press(key);
    await app.window.keyboard.type('big ');
    await expect(task).toHaveValue('write the fixture big change');
    await task.fill('');
    const history = app.window.getByTestId('agent-session-list');
    await history.getByRole('button', { name: 'All sessions' }).click();
    await app.window.getByRole('list', { name: 'All agent sessions' }).getByRole('button', { name: /write the fixture change/ }).click();
    await expect(app.window.getByTestId('agent-environment-review')).toBeVisible({ timeout: 10_000 });

    // At a 280px panel the confirmation is described, focuses Cancel and keeps
    // Tab inside it; cancelling it keeps the sandbox.
    await setPanelWidth(280);
    await app.window.getByRole('button', { name: 'Review', exact: true }).click();
    const discard = app.window.getByRole('button', { name: 'Discard Sandbox' });
    await discard.click();
    const confirmation = app.window.getByRole('alertdialog', { name: 'Discard sandbox?' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('permanently removes the agent’s un-applied changes');
    await expect(confirmation).toContainText('This run cannot be resumed afterwards.');
    await expect(confirmation.getByTestId('agent-discard-run')).toContainText('write the fixture change');
    // Everything behind it is inert, and focus sent there stays in the confirmation.
    await expect(app.window.locator('#root')).toHaveAttribute('inert', '');
    await expectFocusHeld(confirmation, app.window.getByRole('button', { name: 'Review', exact: true, includeHidden: true }));
    await expectFocusHeld(confirmation, app.window.getByTestId('agent-back-button'));
    const cancel = confirmation.getByRole('button', { name: 'Cancel' });
    const confirm = confirmation.getByRole('button', { name: 'Discard sandbox' });
    await expect(cancel).toBeFocused();
    await app.window.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await app.window.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await app.window.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    expect(await axeViolations('[data-testid="agent-discard-confirm"]')).toEqual([]);
    await captureWindow('agent-discard-confirm-280.png');
    await cancel.click();
    await expect(confirmation).toHaveCount(0);
    await expect(app.window.locator('#root')).not.toHaveAttribute('inert', '');
    await expect(discard).toBeFocused();
    expect(existsSync(sandbox)).toBe(true);

    // At 200% the companion is a drawer: Escape closes the confirmation and
    // leaves the drawer open, and the drawer still closes on the next Escape.
    await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2.0); });
    const drawer = app.window.getByTestId('compact-drawer-right');
    if (!(await drawer.isVisible())) await app.window.getByRole('button', { name: 'Toggle companion panel' }).click();
    await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
    // The drawer mounts the review afresh, opened collapsed.
    await expect(drawer.getByTestId('agent-environment-review')).toBeVisible();
    const zoomedDiscard = drawer.getByRole('button', { name: 'Discard Sandbox' });
    if ((await zoomedDiscard.count()) === 0) await drawer.getByRole('button', { name: 'Review', exact: true }).click();
    await zoomedDiscard.scrollIntoViewIfNeeded();
    await zoomedDiscard.click();
    await expect(confirmation).toBeVisible();
    await expect(cancel).toBeFocused();
    await expect(confirmation).toBeInViewport({ ratio: 1 });
    await expectFocusHeld(confirmation, drawer.getByTestId('close-compact-drawer'));
    await expectFocusHeld(confirmation, drawer.getByRole('button', { name: 'Review', exact: true, includeHidden: true }));
    expect(await axeViolations('[data-testid="agent-discard-confirm"]')).toEqual([]);
    await captureWindow('agent-discard-confirm-200.png');
    await app.window.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(zoomedDiscard).toBeFocused();
    expect(existsSync(sandbox)).toBe(true);

    // Confirming discards this run's sandbox once, and only it.
    await zoomedDiscard.click();
    await confirm.click();
    await expect(confirmation).toHaveCount(0);
    await expect(drawer.getByTestId('agent-environment-review')).toHaveCount(0);
    // The review and its trigger are gone; focus lands on the run's New task, in the open drawer.
    await expect(drawer).toHaveAttribute('data-slide-phase', 'open');
    await expect(drawer.getByTestId('agent-back-button')).toBeFocused();
    await expect.poll(() => existsSync(sandbox)).toBe(false);
    expect(existsSync(join(workspace, 'interleaf-fixture-change.txt'))).toBe(false);
    const after = await app.window.evaluate((id) => window.interleafAPI.agent.listSessions(id), documentId);
    expect(after.find((session) => session.id === run.id)?.environment).toBeNull();
  });
});
