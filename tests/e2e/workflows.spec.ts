import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, selectFakeAgentForTest, stubMessageBox, stubOpenDialog, getRecordedMessageBoxCalls, resetRecordedMessageBoxCalls, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue, choosePalette } from './listbox';
test.describe('interleaf-media protocol containment', () => {
  let app: AppHandle;

  test.beforeEach(async () => {
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('blocks path traversal attempts with error status', async () => {
    const status = await app.electronApp.evaluate(async ({ net }) => {
      const response = await net.fetch('interleaf-media:///etc/passwd');
      return response.status;
    });
    expect(status >= 400).toBe(true);
  });

  test('blocks encoded traversal payloads with error status', async () => {
    const status = await app.electronApp.evaluate(async ({ net }) => {
      const response = await net.fetch('interleaf-media:///%2e%2e/%2e%2e/etc/passwd');
      return response.status;
    });
    expect(status >= 400).toBe(true);
  });

  test('rejects non-media URL paths through the media protocol', async () => {
    const status = await app.electronApp.evaluate(async ({ net }) => {
      const response = await net.fetch('interleaf-media://unknown-asset-id').catch(() => null);
      return response ? response.status : 0;
    });
    expect(status).toBe(400);
  });

  test('renderer CSP permits controlled interleaf-media fetches', async () => {
    const result = await app.window.evaluate(async () => {
      const response = await fetch(
        'interleaf-media://550e8400-e29b-41d4-a716-446655440000'
      );
      return { status: response.status, type: response.type };
    });
    expect(result.status).toBe(404);
    expect(result.type).not.toBe('opaque');
  });
});

test.describe('renderer shell behaviors', () => {
  let app: AppHandle;

  test.beforeEach(async () => {
    // This legacy workflow intentionally exercises the deterministic fixture
    // through the explicit, main-owned test seam. Normal launches never
    // register fake providers or agents.
    app = await launchInterleaf({ testSeam: true });
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('renders the reader-first three-pane shell', async () => {
    await expect(app.window.getByTestId('app-header')).toBeVisible();
    await expect(app.window.getByTestId('sidebar-library')).toBeVisible();
    await expect(app.window.getByTestId('reader-viewport')).toBeVisible();
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();
  });

  test('Workflow J restores a real reader workspace exactly after Focus Mode', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'interleaf-workflow-j-source-'));
    try {
      const pdfPath = join(sourceDir, 'workflow-j.pdf');
      writeFileSync(pdfPath, makePdfFixture({
        title: 'Workflow J Reader',
        author: 'Interleaf',
        pageLines: [
          ['Workflow J reading target for selection and focus restoration.', 'Page one reading content.'],
          ['Page two reading content for navigation and progress.'],
          ['Page three reading content.'],
        ],
        outline: [
          { title: 'Workflow J outline one', targetPage: 1 },
          { title: 'Workflow J outline two', targetPage: 2 },
        ],
      }));
      await stubOpenDialog(app, [pdfPath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${document!.id}`).click();
      await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();

      // Establish deliberately non-default state before entering Focus Mode.
      await app.window.getByTestId('panel-resizer-left').press('End');
      await app.window.getByTestId('panel-resizer-right').press('Home');
      const leftBefore = await app.window.getByTestId('panel-resizer-left').getAttribute('aria-valuenow');
      const rightBefore = await app.window.getByTestId('panel-resizer-right').getAttribute('aria-valuenow');
      await app.window.getByRole('tab', { name: 'Annotations' }).click();
      await app.window.getByTestId('toggle-toc-button').click();
      await expect(app.window.getByTestId('reader-outline-sidebar')).toBeVisible();

      // Create and then dismiss a real selection toolbar so its state is
      // exercised while Focus Mode keeps selection UI out of the document.
      // Use the browser's real selection path so the adapter's selection
      // listener validates the same text-layer/range invariants as a user
      // gesture (synthetic selectionchange events do not create a layout
      // selection in Chromium).
      await expect.poll(async () => {
        const textLayer = app.window.getByTestId('pdf-textlayer-p1');
        try {
          if (await textLayer.count() !== 1) return false;
          await textLayer.selectText();
          return await app.window.getByTestId('annotation-selection-toolbar').count() === 1;
        } catch {
          // PDF.js may replace a virtualized text layer between locator
          // resolution and the selection gesture; retry against the current
          // attached layer rather than relying on a fixed delay.
          return false;
        }
      }, { timeout: 10_000 }).toBe(true);
      const selectionToolbar = app.window.getByTestId('annotation-selection-toolbar');
      await expect(selectionToolbar).toBeVisible();
      await selectionToolbar.getByRole('button', { name: 'Close selection toolbar' }).click();

      const focusTarget = app.window.getByTestId('panel-resizer-right');
      await focusTarget.focus();
      await app.window.keyboard.press('F11');
      await expect(app.window.getByTestId('app-header')).toBeHidden();
      await expect(app.window.getByTestId('sidebar-library')).toBeHidden();
      await expect(app.window.getByTestId('companion-panel')).toBeHidden();
      await expect(app.window.getByTestId('reader-header-toolbar')).toBeHidden();
      await expect(app.window.getByTestId('reader-outline-sidebar')).toHaveCount(0);
      await expect(app.window.getByTestId('annotation-selection-toolbar')).toHaveCount(0);
      await expect(app.window.getByTestId('focus-progress')).toBeVisible();

      await app.window.keyboard.press('ArrowRight');
      await expect.poll(() => app.window.getByTestId('focus-progress').getAttribute('aria-valuenow')).toBe('67');
      await app.window.getByTestId('reader-viewport').hover({ position: { x: 120, y: 1 } });
      await expect(app.window.getByTestId('focus-reveal')).toBeVisible();

      // F11 is a deterministic exit path and restores every captured state.
      await app.window.keyboard.press('F11');
      await expect(app.window.getByTestId('app-header')).toBeVisible();
      await expect(app.window.getByTestId('sidebar-library')).toBeVisible();
      await expect(app.window.getByTestId('companion-panel')).toBeVisible();
      await expect(app.window.getByTestId('reader-outline-sidebar')).toBeVisible();
      await expect(app.window.getByRole('tab', { name: 'Annotations' })).toHaveAttribute('aria-selected', 'true');
      await expect(app.window.getByTestId('panel-resizer-left')).toHaveAttribute('aria-valuenow', leftBefore!);
      await expect(app.window.getByTestId('panel-resizer-right')).toHaveAttribute('aria-valuenow', rightBefore!);
      await expect(app.window.getByTestId('panel-resizer-right')).toBeFocused();

      // Verify Esc remains the alternate exit path after another complete
      // enter/exit cycle and that navigation/progress remains available.
      await app.window.keyboard.press('F11');
      await expect(app.window.getByTestId('focus-progress')).toBeVisible();
      await app.window.keyboard.press('Escape');
      await expect(app.window.getByTestId('app-header')).toBeVisible();
      await expect(app.window.getByTestId('panel-resizer-right')).toBeFocused();
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('agent composer defaults to Auto-Isolated and offers Active Environment without an inline confirmation', async () => {
    const agentTab = app.window.getByRole('tab', { name: /Agent/i });
    await agentTab.click();

    const modeSelect = app.window.getByTestId('composer-execution-mode-select');
    await expect(modeSelect).toHaveAttribute('data-value', 'auto-isolated');

    // Direct-workspace confirmation belongs to the native main-process dialog
    // raised at start time, so no inline warning or checkbox exists here.
    await chooseListboxValue(modeSelect, 'active-env');
    await expect(modeSelect).toHaveAttribute('data-value', 'active-env');
    await expect(app.window.getByTestId('direct-workspace-warning')).toHaveCount(0);
    await expect(app.window.getByTestId('direct-workspace-confirm')).toHaveCount(0);

    await chooseListboxValue(modeSelect, 'auto-isolated');
    await expect(modeSelect).toHaveAttribute('data-value', 'auto-isolated');
  });

  test('runs the gated fake fixture through the typed composer stream', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-agent-e2e-'));
    try {
      const pdfPath = join(workingDirectory, 'agent-context.pdf');
      writeFileSync(pdfPath, makePdfFixture({
        title: 'Agent Context',
        author: 'Interleaf',
        pageLines: [['Document-scoped agent context.']],
      }));
      await stubOpenDialog(app, [pdfPath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${document!.id}`).click();
      await app.window.getByRole('tab', { name: /Agent/i }).click();
      await expect(app.window.getByRole('combobox', { name: 'Agent profile' })).toBeVisible();
      const publicProfiles = await app.window.evaluate(() => window.interleafAPI.agent.listProfiles());
      expect(publicProfiles.every((profile) => !('binaryPath' in profile) && !('defaultArgs' in profile) && !('permissionMode' in profile) && !('binaryPath' in profile.detection))).toBe(true);
      await selectFakeAgentForTest(app);
      await stubOpenDialog(app, [workingDirectory]);
      await app.window.getByRole('button', { name: 'Choose…' }).click();
      await expect(app.window.getByTestId('agent-working-directory')).not.toHaveText('Not selected');
      await app.window.getByLabel('Task description').fill('stream fixture output and tests');
      await app.window.getByRole('button', { name: 'Start agent' }).click();
      await expect(app.window.getByLabel('Agent event log')).toContainText('started', { timeout: 10_000 });
      await expect(app.window.getByText('Session completed.', { exact: true })).toBeVisible({ timeout: 10_000 });
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('carries a real PDF selection into the composer and persists the streamed fake session', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'interleaf-agent-selection-'));
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-agent-workspace-'));
    try {
      const pdfPath = join(sourceDir, 'agent-selection.pdf');
      writeFileSync(pdfPath, makePdfFixture({
        title: 'Agent Selection Guide', author: 'Interleaf',
        pageLines: [['A selected passage is untrusted reference context for the local agent.']],
      }));
      await stubOpenDialog(app, [pdfPath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${document!.id}`).click();
      await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
      const quote = 'A selected passage is untrusted reference context';
      await app.window.getByTestId('pdf-textlayer-p1').evaluate((layer, target) => {
        const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = node.textContent?.indexOf(target) ?? -1;
          if (start < 0) continue;
          const range = layer.ownerDocument.createRange();
          range.setStart(node, start); range.setEnd(node, start + target.length);
          const selection = layer.ownerDocument.getSelection();
          selection?.removeAllRanges(); selection?.addRange(range);
          layer.ownerDocument.dispatchEvent(new Event('selectionchange'));
          return;
        }
        throw new Error('Selection target not found');
      }, quote);
      const toolbar = app.window.getByTestId('annotation-selection-toolbar');
      await expect(toolbar).toBeVisible();
      await toolbar.getByRole('button', { name: 'Submit selected passage to agent' }).click();
      await expect(app.window.getByTestId('agent-context-summary')).toContainText(quote);
      await expect(app.window.getByLabel('Task description')).toBeFocused();

      await app.window.evaluate(() => {
        const events: { type: string; ordinal: number }[] = [];
        window.__agentEvents = events;
        window.interleafAPI.agent.onEvent((event) => { events.push({ type: event.type, ordinal: event.ordinal }); });
      });
      await selectFakeAgentForTest(app);
      await stubOpenDialog(app, [workingDirectory]);
      await app.window.getByRole('button', { name: 'Choose…' }).click();
      await app.window.getByLabel('Task description').fill('report on the selected passage');
      await app.window.getByRole('button', { name: 'Start agent' }).click();
      await expect.poll(async () => app.window.evaluate(async (documentId) => {
        const sessions = await window.interleafAPI.agent.listSessions(documentId);
        return sessions[0]?.status ?? null;
      }, document!.id)).toBe('completed');
      const session = await app.window.evaluate(
        async (documentId) => (await window.interleafAPI.agent.listSessions(documentId))[0],
        document!.id,
      );
      if (session === undefined) throw new Error('Agent session was not persisted.');
      const detail = await app.window.evaluate(
        async ({ sessionId, documentId }) => window.interleafAPI.agent.getSession(sessionId, documentId),
        { sessionId: session.id, documentId: document!.id },
      );
      expect(detail?.events.map((event) => event.type)).toEqual(expect.arrayContaining(['started', 'stdout', 'stderr', 'structured', 'changed-files', 'tests', 'final', 'ended']));
      expect(detail?.events.every((event, index, events) => index === 0 || event.ordinal > (events[index - 1]?.ordinal ?? -1))).toBe(true);
      const streamed = await app.window.evaluate(() => window.__agentEvents);
      expect(streamed.map((event) => event.type)).toEqual(expect.arrayContaining(['changed-files', 'tests', 'final', 'ended']));
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('Workflow H reviews and applies an isolated Git worktree, then discards a second run', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'interleaf-workflow-h-'));
    const sourceDir = mkdtempSync(join(tmpdir(), 'interleaf-workflow-h-source-'));
    try {
      const pdfPath = join(sourceDir, 'workflow-h.pdf');
      writeFileSync(pdfPath, makePdfFixture({ title: 'Workflow H', author: 'Interleaf', pageLines: [['A selected passage for the isolated agent workflow.']] }));
      writeFileSync(join(repository, 'README.md'), 'fixture\n');
      execFileSync('git', ['init', '--quiet', repository]);
      execFileSync('git', ['-C', repository, 'config', 'user.email', 'interleaf@example.invalid']);
      execFileSync('git', ['-C', repository, 'config', 'user.name', 'Interleaf Test']);
      execFileSync('git', ['-C', repository, 'add', '.']);
      execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', 'fixture']);
      await stubOpenDialog(app, [pdfPath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${document!.id}`).click();
      await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
      const quote = 'A selected passage for the isolated agent workflow.';
      await app.window.getByTestId('pdf-textlayer-p1').evaluate((layer, target) => {
        const node = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT).nextNode();
        if (node === null) throw new Error('Selection target not found');
        const text = node.textContent ?? '';
        if (!text.includes(target)) throw new Error('Selection target not found');
        const range = layer.ownerDocument.createRange();
        const start = text.indexOf(target); range.setStart(node, start); range.setEnd(node, start + target.length);
        const selection = layer.ownerDocument.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); layer.ownerDocument.dispatchEvent(new Event('selectionchange'));
      }, quote);
      await app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Submit selected passage to agent' }).click();
      await expect(app.window.getByTestId('agent-context-summary')).toContainText(quote);
      await app.window.getByRole('tab', { name: /Agent/i }).click();
      await selectFakeAgentForTest(app);
      await stubOpenDialog(app, [repository]);
      await app.window.getByRole('button', { name: 'Choose…' }).click();
      await app.window.getByLabel('Task description').fill('apply the isolated fixture change');
      await app.window.getByRole('button', { name: 'Start agent' }).click();
      await expect(app.window.getByText('Session completed.', { exact: true })).toBeVisible({ timeout: 15_000 });
      const firstSession = await app.window.evaluate(
        async (documentId) => (await window.interleafAPI.agent.listSessions(documentId))[0],
        document!.id,
      );
      if (firstSession === undefined) throw new Error('Workflow H session was not persisted.');
      expect(firstSession.executionMode).toBe('isolated-worktree');
      expect(firstSession.environment?.mode).toBe('isolated-worktree');
      expect(existsSync(join(repository, 'interleaf-fixture-change.txt'))).toBe(false);
      const userData = await app.electronApp.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
      const worktreeListing = execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
      expect(worktreeListing).toContain(join(userData, 'agent-workspaces', firstSession.id, 'worktree'));
      await expect(app.window.getByTestId('agent-environment-review')).toContainText('1 changed file', { timeout: 5_000 });
      // The review body opens collapsed; its detail and actions live inside it.
      await app.window.getByRole('button', { name: 'Review', exact: true }).click();
      await expect(app.window.getByTestId('agent-review-files')).toContainText('interleaf-fixture-change.txt', { timeout: 5_000 });
      await expect(app.window.getByTestId('agent-review-tests')).toContainText('passed', { timeout: 5_000 });
      await app.window.getByRole('button', { name: 'View Diff' }).click();
      await expect(app.window.getByTestId('agent-environment-diff')).toContainText('diff', { timeout: 5_000 });
      await app.window.getByRole('button', { name: 'Apply Changes' }).click();
      await expect.poll(() => existsSync(join(repository, 'interleaf-fixture-change.txt'))).toBe(true);
      rmSync(join(repository, 'interleaf-fixture-change.txt'));
      await app.window.getByRole('button', { name: 'Discard Sandbox' }).click();
      await app.window.getByRole('alertdialog', { name: 'Discard sandbox?' }).getByRole('button', { name: 'Discard sandbox' }).click();
      await expect.poll(() => execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).not.toContain(join(userData, 'agent-workspaces', firstSession.id, 'worktree'));

      await app.window.getByTestId('agent-back-button').click();
      await app.window.getByLabel('Task description').fill('discard the isolated fixture change');
      await app.window.getByRole('button', { name: 'Start agent' }).click();
      await expect(app.window.getByText('Session completed.', { exact: true })).toBeVisible({ timeout: 15_000 });
      const secondSession = await app.window.evaluate(
        async ({ documentId, firstSessionId }) => (await window.interleafAPI.agent.listSessions(documentId)).find((session) => session.id !== firstSessionId),
        { documentId: document!.id, firstSessionId: firstSession.id },
      );
      if (secondSession === undefined) throw new Error('Workflow H second session was not persisted.');
      expect(secondSession.executionMode).toBe('isolated-worktree');
      await app.window.getByRole('button', { name: 'Review', exact: true }).click();
      // Cancelling the confirmation keeps the sandbox; only confirming removes it.
      await app.window.getByRole('button', { name: 'Discard Sandbox' }).click();
      await app.window.getByRole('alertdialog', { name: 'Discard sandbox?' }).getByRole('button', { name: 'Cancel' }).click();
      expect(execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).toContain(join(userData, 'agent-workspaces', secondSession.id, 'worktree'));
      await app.window.getByRole('button', { name: 'Discard Sandbox' }).click();
      await app.window.getByRole('alertdialog', { name: 'Discard sandbox?' }).getByRole('button', { name: 'Discard sandbox' }).click();
      expect(existsSync(join(repository, 'interleaf-fixture-change.txt'))).toBe(false);
      await expect.poll(() => execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).not.toContain(join(userData, 'agent-workspaces', secondSession.id, 'worktree'));
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('Workflow I requires native main confirmation and reports direct active-workspace changes', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-workflow-i-'));
    try {
      const pdfPath = join(workingDirectory, 'workflow-i-context.pdf');
      writeFileSync(pdfPath, makePdfFixture({ title: 'Workflow I Context', author: 'Interleaf', pageLines: [['Document-scoped direct workspace task.']] }));
      await stubOpenDialog(app, [pdfPath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${document!.id}`).click();
      await app.window.getByRole('tab', { name: /Agent/i }).click();
      await selectFakeAgentForTest(app);
      await stubOpenDialog(app, [workingDirectory]);
      await app.window.getByRole('button', { name: 'Choose…' }).click();
      await chooseListboxValue(app.window.getByTestId('composer-execution-mode-select'), 'active-env');
      await app.window.getByLabel('Task description').fill('modify active workspace directly');

      // The native main-process dialog is the only confirmation step, and it is
      // authoritative: declining it must stop the launch. Start is reachable
      // without any inline renderer checkbox.
      await stubMessageBox(app, 0);
      await resetRecordedMessageBoxCalls(app);
      const startButton = app.window.getByRole('button', { name: 'Start agent' });
      await expect(startButton).toBeEnabled();
      await startButton.click();
      await expect(app.window.getByTestId('agent-session-status'))
        .toContainText('Direct workspace confirmation was cancelled.', { timeout: 15_000 });
      expect(await getRecordedMessageBoxCalls(app)).toHaveLength(1);
      expect(existsSync(join(workingDirectory, 'interleaf-fixture-change.txt'))).toBe(false);

      await stubMessageBox(app, 1);
      await startButton.click();
      await expect(app.window.getByText('Session completed.', { exact: true })).toBeVisible({ timeout: 15_000 });
      await app.window.getByRole('button', { name: 'Review', exact: true }).click();
      await app.window.getByRole('button', { name: 'Refresh' }).click();
      await expect(app.window.getByTestId('agent-environment-review')).toContainText('Active workspace modified directly', { timeout: 5_000 });
      expect(existsSync(join(workingDirectory, 'interleaf-fixture-change.txt'))).toBe(true);
      // Direct mode has no sandbox: the confirmation says the working directory is not restored.
      await app.window.getByRole('button', { name: 'Discard Sandbox' }).click();
      const confirmation = app.window.getByRole('alertdialog', { name: 'Discard review data?' });
      await expect(confirmation).toContainText('does not undo changes the agent already made');
      await confirmation.getByRole('button', { name: 'Discard review data' }).click();
      await expect.poll(async () => (await app.window.evaluate(
        async (documentId) => (await window.interleafAPI.agent.listSessions(documentId))[0],
        document!.id,
      ))?.environment).toBeNull();
      expect(existsSync(join(workingDirectory, 'interleaf-fixture-change.txt'))).toBe(true);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('palette choice persists to SQLite and survives an application restart', async () => {
    await choosePalette(app.window, 'paper');

    const dbPath = await app.electronApp.evaluate(({ app }) =>
      app.getPath('userData') + '/database/interleaf.sqlite'
    );

    // Switch to Midnight and wait until the write lands in SQLite (WAL).
    await choosePalette(app.window, 'midnight');
    await waitForStoredPalette(dbPath, 'midnight');

    // The theme cross-fades in, so it lands on the root a frame after the click.
    await expect.poll(() => app.window.evaluate(() => document.documentElement.dataset.theme)).toBe('midnight');

    const userDataDir = app.userDataDir;
    // Close the electron app without deleting userDataDir so the restart reads the database
    await app.close({ preserveUserData: true });

    const relaunched = await launchInterleaf({ userDataDir });
    try {
      await expect
        .poll(() => relaunched.window.evaluate(() => document.documentElement.dataset.theme))
        .toBe('midnight');
    } finally {
      await relaunched.close();
    }
  });

  test('shell reflows without horizontal overflow at minimum window size 960x640 and zoom factor 2', async () => {
    // Set window size to minimum 960x640 and zoom factor to 2.0
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.setSize(960, 640);
      win.webContents.setZoomFactor(2.0);
    });

    await app.window.waitForTimeout(500);

    // Verify horizontal overflow invariant: scrollWidth <= clientWidth across all shell containers
    const overflowCheck = await app.window.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      const header = document.querySelector<HTMLElement>('[data-testid="app-header"]');
      const shell = document.querySelector<HTMLElement>('[data-testid="app-shell"]');
      const viewport = document.querySelector<HTMLElement>('[data-testid="reader-viewport"]');

      const results = {
        innerWidth: window.innerWidth,
        bodyScrollWidth: body.scrollWidth,
        bodyClientWidth: body.clientWidth,
        htmlScrollWidth: html.scrollWidth,
        htmlClientWidth: html.clientWidth,
        headerScrollWidth: header?.scrollWidth ?? 0,
        headerClientWidth: header?.clientWidth ?? 0,
        shellScrollWidth: shell?.scrollWidth ?? 0,
        shellClientWidth: shell?.clientWidth ?? 0,
        viewportScrollWidth: viewport?.scrollWidth ?? 0,
        viewportClientWidth: viewport?.clientWidth ?? 0,
      };
      return results;
    });

    // Assert all queried layout containers exist and have positive clientWidth
    expect(overflowCheck.bodyClientWidth).toBeGreaterThan(0);
    expect(overflowCheck.htmlClientWidth).toBeGreaterThan(0);
    expect(overflowCheck.headerClientWidth).toBeGreaterThan(0);
    expect(overflowCheck.shellClientWidth).toBeGreaterThan(0);
    expect(overflowCheck.viewportClientWidth).toBeGreaterThan(0);

    expect(overflowCheck.bodyScrollWidth).toBeLessThanOrEqual(overflowCheck.bodyClientWidth);
    expect(overflowCheck.htmlScrollWidth).toBeLessThanOrEqual(overflowCheck.htmlClientWidth);
    expect(overflowCheck.headerScrollWidth).toBeLessThanOrEqual(overflowCheck.headerClientWidth);
    expect(overflowCheck.shellScrollWidth).toBeLessThanOrEqual(overflowCheck.shellClientWidth);
    expect(overflowCheck.viewportScrollWidth).toBeLessThanOrEqual(overflowCheck.viewportClientWidth);

    // Verify all essential header controls are visible and bounded within the viewport
    const headerControls = [
      'toggle-left-panel',
      'toggle-right-panel',
      'open-settings',
      'open-shortcuts',
      'theme-menu-trigger',
    ];

    await expect(app.window.getByTestId('open-focus')).toHaveCount(0);

    for (const testId of headerControls) {
      const el = app.window.getByTestId(testId);
      await expect(el).toBeVisible();

      // Check bounding box is within viewport
      const box = await el.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(overflowCheck.innerWidth + 2);
      }
    }

    // Verify compact presentation drawer toggle behavior and accessibility
    const toggleSidebar = app.window.getByTestId('toggle-left-panel');
    const toggleCompanion = app.window.getByTestId('toggle-right-panel');
    await expect(app.window.getByTestId('compact-drawer-left')).toBeHidden();
    await expect(app.window.getByTestId('compact-drawer-right')).toBeHidden();
    expect(await toggleSidebar.getAttribute('aria-expanded')).toBe('false');
    expect(await toggleSidebar.getAttribute('aria-pressed')).toBe('false');

    // Open Library drawer
    await toggleSidebar.click();
    const leftDrawer = app.window.getByTestId('compact-drawer-left');
    await expect(leftDrawer).toBeVisible();
    expect(await toggleSidebar.getAttribute('aria-expanded')).toBe('true');
    expect(await toggleSidebar.getAttribute('aria-pressed')).toBe('true');
    // Check left drawer positive dimensions and full in-viewport bounds (x, y, width, height)
    await expect
      .poll(async () =>
        leftDrawer.evaluate((node) => {
          const raw = getComputedStyle(node).transform;
          return raw === 'none' || raw === 'matrix(1, 0, 0, 1, 0, 0)';
        })
      )
      .toBe(true);
    const leftBox = await leftDrawer.boundingBox();
    expect(leftBox).not.toBeNull();
    const innerHeight = await app.window.evaluate(() => window.innerHeight);
    if (leftBox) {
      expect(leftBox.width).toBeGreaterThan(0);
      expect(leftBox.height).toBeGreaterThan(0);
      expect(leftBox.x).toBeGreaterThanOrEqual(0);
      expect(leftBox.y).toBeGreaterThanOrEqual(0);
      expect(leftBox.x + leftBox.width).toBeLessThanOrEqual(overflowCheck.innerWidth + 2);
      expect(leftBox.y + leftBox.height).toBeLessThanOrEqual(innerHeight + 2);
    }

    // Check initial focus moved inside the left drawer
    await expect.poll(async () => {
      return app.window.evaluate(() => document.activeElement?.closest('[data-testid="compact-drawer-left"]') !== null);
    }).toBe(true);

    // Switch from Library drawer to Companion drawer via in-drawer switcher
    const switchToCompanion = app.window.getByTestId('switch-to-companion-button');
    await switchToCompanion.click();
    const rightDrawer = app.window.getByTestId('compact-drawer-right');
    await expect(rightDrawer).toBeVisible();
    await expect(leftDrawer).toBeHidden();
    expect(await toggleCompanion.getAttribute('aria-expanded')).toBe('true');
    expect(await toggleCompanion.getAttribute('aria-pressed')).toBe('true');

    // Check right drawer positive dimensions and full in-viewport bounds (x, y, width, height)
    await expect
      .poll(async () =>
        rightDrawer.evaluate((node) => {
          const raw = getComputedStyle(node).transform;
          return raw === 'none' || raw === 'matrix(1, 0, 0, 1, 0, 0)';
        })
      )
      .toBe(true);
    const rightBox = await rightDrawer.boundingBox();
    expect(rightBox).not.toBeNull();
    if (rightBox) {
      expect(rightBox.width).toBeGreaterThan(0);
      expect(rightBox.height).toBeGreaterThan(0);
      expect(rightBox.x).toBeGreaterThanOrEqual(0);
      expect(rightBox.y).toBeGreaterThanOrEqual(0);
      expect(rightBox.x + rightBox.width).toBeLessThanOrEqual(overflowCheck.innerWidth + 2);
      expect(rightBox.y + rightBox.height).toBeLessThanOrEqual(innerHeight + 2);
    }

    // Check initial focus moved inside the right drawer
    await expect.poll(async () => {
      return app.window.evaluate(() => document.activeElement?.closest('[data-testid="compact-drawer-right"]') !== null);
    }).toBe(true);

    // Exercise Tab and Shift+Tab focus trap inside the right drawer
    const firstFocusableId = await app.window.evaluate(() => {
      const drawer = document.querySelector('[data-testid="compact-drawer-right"]');
      const focusable = drawer?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      return focusable?.[0]?.getAttribute('data-testid') ?? null;
    });
    expect(firstFocusableId).not.toBeNull();

    // Ensure first element has focus before Shift+Tab
    await app.window.evaluate(() => {
      const drawer = document.querySelector('[data-testid="compact-drawer-right"]');
      const focusable = drawer?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      focusable?.[0]?.focus();
    });

    // Press Shift+Tab from first element -> wraps to the last focusable element in drawer
    await app.window.keyboard.press('Shift+Tab');
    await expect.poll(async () => {
      return app.window.evaluate(() => {
        const drawer = document.querySelector('[data-testid="compact-drawer-right"]');
        if (!drawer) return false;
        const candidates = drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        const focusable = Array.from(candidates).filter((el) => {
          return !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.closest('[hidden]') === null;
        });
        const last = focusable[focusable.length - 1];
        return document.activeElement === last;
      });
    }).toBe(true);

    // Press Tab from last element -> wraps back to the first element in drawer
    await app.window.keyboard.press('Tab');
    await expect.poll(async () => {
      return app.window.evaluate(() => {
        const drawer = document.querySelector('[data-testid="compact-drawer-right"]');
        if (!drawer) return false;
        const candidates = drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        const focusable = Array.from(candidates).filter((el) => {
          return !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.closest('[hidden]') === null;
        });
        const first = focusable[0];
        return document.activeElement === first;
      });
    }).toBe(true);
    // Close via explicit Close button in drawer and verify focus restoration to toggle-right-panel
    const closeBtn = app.window.getByTestId('close-compact-drawer');
    await closeBtn.click();
    await expect(rightDrawer).toBeHidden();
    expect(await toggleCompanion.getAttribute('aria-expanded')).toBe('false');
    expect(await toggleCompanion.getAttribute('aria-pressed')).toBe('false');

    await expect.poll(async () => {
      return app.window.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'toggle-right-panel');
    }).toBe(true);

    // Reopen right drawer and verify F11 is blocked while drawer is open
    await toggleCompanion.click();
    await expect(rightDrawer).toBeVisible();
    await app.window.keyboard.press('F11');
    // Header remains visible (Focus Mode not activated) and drawer remains open
    await expect(app.window.getByTestId('app-header')).toBeVisible();
    await expect(rightDrawer).toBeVisible();

    // Press Escape to close drawer and assert focus restored to toggle-right-panel
    await app.window.keyboard.press('Escape');
    await expect(rightDrawer).toBeHidden();
    expect(await toggleCompanion.getAttribute('aria-expanded')).toBe('false');
    await expect.poll(async () => {
      return app.window.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'toggle-right-panel');
    }).toBe(true);
    const palettes = ['paper', 'sepia', 'moss', 'ocean', 'graphite', 'midnight'] as const;
    for (const p of palettes) {
      await choosePalette(app.window, p);
      const currentTheme = await app.window.evaluate(() => document.documentElement.dataset.theme);
      expect(currentTheme).toBe(p);
    }
  });
});

test.describe('Agent resume boundary workflow', () => {
  let app: AppHandle;

  test.beforeEach(async () => {
    app = await launchInterleaf({ fakeResumeSleep: true, testSeam: true });
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('resumes through Electron IPC, keeps Stop live, copies native clipboard, and opens the prepared folder', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-workflow-resume-'));
    try {
      const pdfPath = join(workingDirectory, 'resume-context.pdf');
      writeFileSync(pdfPath, makePdfFixture({ title: 'Resume Context', author: 'Interleaf', pageLines: [['Document-scoped resumable task.']] }));
      await stubOpenDialog(app, [pdfPath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${document!.id}`).click();
      await app.window.getByRole('tab', { name: /Agent/i }).click();
      await selectFakeAgentForTest(app);
      await stubOpenDialog(app, [workingDirectory]);
      await app.window.getByRole('button', { name: 'Choose…' }).click();
      await app.window.getByLabel('Task description').fill('complete the resumable fixture task');
      await app.window.getByRole('button', { name: 'Start agent' }).click();
      await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 15_000 });
      const initialSession = await app.window.evaluate(
        async (documentId) => (await window.interleafAPI.agent.listSessions(documentId))[0],
        document!.id,
      );
      if (initialSession === undefined) throw new Error('Resumable fixture session was not persisted.');

      await app.electronApp.evaluate(({ clipboard }) => { clipboard.clear(); });
      await app.window.getByTestId('agent-copy-result-button').click();
      await expect(app.window.getByText(/Copied report \(\d+ chars\) to clipboard\./)).toBeVisible({ timeout: 5_000 });
      await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('fixture final report');

      await app.window.getByLabel('Follow-up prompt').fill('continue the fixture task');
      await app.window.getByTestId('agent-resume-button').click();
      await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session running.', { timeout: 5_000 });
      await expect(app.window.getByRole('button', { name: 'Stop' })).toBeEnabled();
      const resumedDetail = await app.window.evaluate(async (documentId) => {
        const sessions = await window.interleafAPI.agent.listSessions(documentId);
        const selected = sessions[0];
        return selected === undefined ? null : window.interleafAPI.agent.getSession(selected.id, documentId);
      }, document!.id);
      expect(resumedDetail?.events.filter((event) => event.type === 'started').length).toBeGreaterThanOrEqual(2);

      await app.window.getByRole('button', { name: 'Stop' }).click();
      await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session cancelled.', { timeout: 10_000 });
      await expect(app.window.getByTestId('agent-environment-review')).toBeVisible({ timeout: 10_000 });

      await app.electronApp.evaluate(({ shell }) => {
        const state = globalThis as typeof globalThis & { __interleafOpenedFolder?: string };
        shell.openPath = (openedPath) => { state.__interleafOpenedFolder = openedPath; return Promise.resolve(''); };
      });
      await app.window.getByRole('button', { name: 'Review', exact: true }).click();
      await app.window.getByRole('button', { name: 'Open Folder' }).click();
      await expect.poll(() => app.electronApp.evaluate(() => (globalThis as typeof globalThis & { __interleafOpenedFolder?: string }).__interleafOpenedFolder)).toBe(join(app.userDataDir, 'agent-workspaces', initialSession.id, 'workspace'));
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});

test.describe('custom Expert Shell persistence workflow', () => {
  test('creates, runs, and rehydrates a custom Expert Shell profile through the desktop UI', async () => {
    test.skip(process.platform === 'win32', 'The deterministic shell fixture uses the POSIX /bin/sh executable.');

    const userDataDir = mkdtempSync(join(tmpdir(), 'interleaf-expert-shell-user-data-'));
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-expert-shell-workspace-'));
    const profileName = 'E2E Expert Shell';
    const outputMarker = 'interleaf-expert-shell-ok';
    let app: AppHandle | null = null;

    try {
      app = await launchInterleaf({ userDataDir });
      const pdfPath = join(workingDirectory, 'expert-shell-context.pdf');
      writeFileSync(pdfPath, makePdfFixture({ title: 'Expert Shell Context', author: 'Interleaf', pageLines: [['Document-scoped expert shell task.']] }));
      await stubOpenDialog(app, [pdfPath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${document!.id}`).click();
      await app.window.getByTestId('open-settings').click();
      const settings = app.window.getByRole('dialog', { name: 'Settings' });
      await expect(settings).toBeVisible();
      // Custom profiles keep their own rail section; built-in profiles now
      // live inside their provider rows.
      const profilesSection = settings.getByTestId('settings-rail-custom-profiles');
      await expect(profilesSection).toBeEnabled({ timeout: 10_000 });
      await profilesSection.click();
      await expect(settings.getByRole('heading', { name: 'Your custom profiles' })).toBeVisible();

      // The only native boundary stub is the executable picker. The renderer
      // receives the typed public projection ("sh"), never the selected path.
      await stubOpenDialog(app, ['/bin/sh']);
      await settings.getByRole('button', { name: 'Choose executable…' }).click();
      await expect(settings.getByText('sh', { exact: true })).toBeVisible();
      await settings.getByRole('radio', { name: /Expert Shell \(Dangerous/ }).check();
      await settings.getByLabel('Custom profile name').fill(profileName);
      await settings.getByLabel('Static shell command').fill(`printf '${outputMarker}\\n'`);

      // Profile creation and every subsequent Expert Shell run retain the
      // product's native confirmations; the response is deterministic only
      // for this isolated test process.
      await stubMessageBox(app, 1);
      await settings.getByRole('button', { name: 'Add profile' }).click();
      await expect(settings.getByText(profileName, { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(settings.getByText('Expert shell', { exact: true })).toBeVisible();

      // Assert dedicated profile-creation warning
      const creationCalls = await getRecordedMessageBoxCalls(app);
      expect(creationCalls.length).toBe(1);
      expect(creationCalls[0]?.title).toBe('Enable Expert Shell profile');
      expect(creationCalls[0]?.buttons).toContain('Enable Expert Shell');

      await settings.getByRole('button', { name: 'Close settings' }).click();

      await app.window.getByRole('tab', { name: /Agent/i }).click();
      await expect(app.window.getByRole('combobox', { name: 'Agent profile' })).toBeVisible();
      const createdProfile = await app.window.evaluate(async (name) => {
        const profiles = await window.interleafAPI.agent.listProfiles();
        return profiles.find((profile) => profile.name === name) ?? null;
      }, profileName);
      if (createdProfile === null) throw new Error('The created Expert Shell profile was not exposed by the main profile registry.');
      await chooseListboxValue(app.window.getByRole('combobox', { name: 'Agent profile' }), createdProfile.id);

      await stubOpenDialog(app, [workingDirectory]);
      await app.window.getByRole('button', { name: 'Choose…' }).click();
      await expect(app.window.getByTestId('agent-working-directory')).not.toHaveText('Not selected');
      await app.window.getByLabel('Task description').fill('run the deterministic shell evidence command');
      await stubMessageBox(app, 1);
      await app.window.getByRole('button', { name: 'Start agent' }).click();
      await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 20_000 });
      await expect(app.window.getByLabel('Agent event log')).toContainText(outputMarker, { timeout: 10_000 });

      // Assert subsequent run confirmation is distinct, critical, and sequenced
      const runCalls = await getRecordedMessageBoxCalls(app);
      expect(runCalls.length).toBe(2);
      expect(runCalls[1]?.title).toBe('Confirm Expert Shell run');
      expect(runCalls[1]?.message).toContain('CRITICAL: Expert Shell profile');
      expect(runCalls[1]?.buttons).toContain('Run once');
      expect(runCalls[0]?.sequence).toBe(1);
      expect(runCalls[1]?.sequence).toBe(2);
      // only the public profile name/id to prove persistence and selectability.
      await app.close({ preserveUserData: true });
      app = await launchInterleaf({ userDataDir });
      await app.window.getByTestId('open-settings').click();
      const restartedSettings = app.window.getByRole('dialog', { name: 'Settings' });
      await expect(restartedSettings).toBeVisible();
      const restartedProfilesSection = restartedSettings.getByTestId('settings-rail-custom-profiles');
      await expect(restartedProfilesSection).toBeEnabled({ timeout: 10_000 });
      await restartedProfilesSection.click();
      await expect(restartedSettings.getByRole('heading', { name: 'Your custom profiles' })).toBeVisible();
      await expect(restartedSettings.getByText(profileName, { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(restartedSettings.getByText('Expert shell', { exact: true })).toBeVisible();
      await restartedSettings.getByRole('button', { name: 'Close settings' }).click();

      await app.window.getByRole('tab', { name: /Agent/i }).click();
      const rehydratedProfile = await app.window.evaluate(async (name) => {
        const profiles = await window.interleafAPI.agent.listProfiles();
        return profiles.find((profile) => profile.name === name) ?? null;
      }, profileName);
      if (rehydratedProfile === null) throw new Error('The persisted Expert Shell profile was not rehydrated after restart.');
      await chooseListboxValue(app.window.getByRole('combobox', { name: 'Agent profile' }), rehydratedProfile.id);
      await expect(app.window.getByRole('combobox', { name: 'Agent profile' })).toHaveAttribute('data-value', rehydratedProfile.id);
    } finally {
      try {
        await app?.close({ preserveUserData: true });
      } finally {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(workingDirectory, { recursive: true, force: true });
      }
    }
  });
});

function waitForStoredPalette(dbPath: string, palette: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const attempt = (): void => {
      try {
        const db = new DatabaseSync(dbPath);
        try {
          const row = db.prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as
            | { value_json?: string }
            | undefined;
          const match =
            row !== undefined && (row.value_json ?? '').includes(`"palette":"${palette}"`);
          if (match) {
            resolve();
            return;
          }
        } finally {
          db.close();
        }
      } catch {
        // DB may be mid-write or locked; retry until the deadline.
      }
      if (Date.now() > deadline) {
        reject(new Error(`settings row never reached palette=${palette}`));
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}
