import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, selectFakeAgentForTest, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue, listboxOptionLabels } from './listbox';

/**
 * Proves the renderer's independent agent-profile and model choices reach the
 * real fixed-executable, tokenized-argv launch path. The deterministic fake CLI
 * echoes its argv on stdout, so no provider is ever invoked.
 */
test.describe('Agent profile and model selection', () => {
  let app: AppHandle;

  test.beforeEach(async () => {
    app = await launchInterleaf({ testSeam: true });
  });

  test.afterEach(async () => {
    await app.close();
  });

  async function openAgentPanel(workingDirectory: string): Promise<string> {
    const pdfPath = join(workingDirectory, 'agent-model.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Agent Model Selection',
      author: 'Interleaf',
      pageLines: [['Document-scoped agent model selection.']],
    }));
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (document === undefined) throw new Error('Fixture document was not imported.');
    await app.window.getByTestId(`read-doc-${document.id}`).click();
    await app.window.getByRole('tab', { name: /Agent/i }).click();
    await expect(app.window.getByRole('combobox', { name: 'Agent profile' })).toBeVisible();
    return document.id;
  }

  test('passes the independently chosen profile and model into the launched CLI argv', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-agent-model-'));
    try {
      const documentId = await openAgentPanel(workingDirectory);

      // The model control is disabled until a profile that supports model
      // selection is chosen, so an unsupported pair can never be launched.
      const modelSelect = app.window.getByTestId('agent-model-select');
      await expect(modelSelect).toBeVisible();

      await selectFakeAgentForTest(app);
      await expect(modelSelect).toBeEnabled();
      await expect(modelSelect).toHaveAttribute('data-value', '');
      expect(await listboxOptionLabels(modelSelect))
        .toEqual(['Provider default', 'fixture-model-a', 'fixture-model-b']);

      await chooseListboxValue(modelSelect, 'fixture-model-b');
      await expect(modelSelect).toHaveAttribute('data-value', 'fixture-model-b');
      // Both controls are readable at the point of use, side by side in one block.
      await expect(app.window.getByRole('combobox', { name: 'Agent profile' })).toHaveAttribute('data-value', 'fake');

      await stubOpenDialog(app, [workingDirectory]);
      await app.window.getByRole('button', { name: 'Choose…' }).click();
      await expect(app.window.getByTestId('agent-working-directory')).not.toHaveText('Not selected');
      await app.window.getByLabel('Task description').fill('echo the launched model back');
      await app.window.getByRole('button', { name: 'Start agent' }).click();

      await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 15_000 });
      await expect(app.window.getByTestId('agent-active-session-profile')).toHaveText('Fake Agent (test/development only)');
      await expect(app.window.getByTestId('agent-active-session-model')).toHaveText('fixture-model-b');
      await expect(app.window.getByTestId('agent-session-item-profile').first()).toHaveText('Fake Agent (test/development only)');
      await expect(app.window.getByTestId('agent-session-item-model').first()).toHaveText('fixture-model-b');
      const detail = await app.window.evaluate(async (id) => {
        const sessions = await window.interleafAPI.agent.listSessions(id);
        const selected = sessions[0];
        return selected === undefined ? null : window.interleafAPI.agent.getSession(selected.id, id);
      }, documentId);
      expect(detail?.effectiveModel).toBe('fixture-model-b');
      expect(detail?.profileId).toBe('fake');

      // The fixture echoes its argv, so this is direct evidence the selected
      // model arrived as a discrete `--model <value>` token pair.
      const echoed = (detail?.events ?? [])
        .filter((event) => event.type === 'stdout')
        .map((event) => event.text)
        .filter((text) => text.includes('fixture stdout:'));
      expect(echoed.length).toBeGreaterThan(0);
      expect(echoed.some((text) => text.includes('--model fixture-model-b'))).toBe(true);
      expect(echoed.some((text) => text.includes('fixture-model-a'))).toBe(false);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('resumes with the run\'s recorded model after the composer default changes', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'interleaf-agent-model-resume-'));
    try {
      const documentId = await openAgentPanel(workingDirectory);
      await selectFakeAgentForTest(app);
      await chooseListboxValue(app.window.getByTestId('agent-model-select'), 'fixture-model-b');
      await stubOpenDialog(app, [workingDirectory]);
      await app.window.getByRole('button', { name: 'Choose…' }).click();
      await app.window.getByLabel('Task description').fill('first run under the chosen model');
      await app.window.getByRole('button', { name: 'Start agent' }).click();
      await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 15_000 });

      const started = await app.window.evaluate(
        async (id) => (await window.interleafAPI.agent.listSessions(id))[0],
        documentId,
      );
      if (started === undefined) throw new Error('The fixture session was not persisted.');

      // Move the composer default to the other model, then return to the run.
      await app.window.getByTestId('agent-back-button').click();
      const modelSelect = app.window.getByTestId('agent-model-select');
      await expect(modelSelect).toHaveAttribute('data-value', 'fixture-model-b');
      await chooseListboxValue(modelSelect, 'fixture-model-a');
      await expect(modelSelect).toHaveAttribute('data-value', 'fixture-model-a');
      // History lives behind the task view's "All sessions" chip, so the run is
      // reached the way a user reaches it: open that disclosure, read the list,
      // then pick the run. Scoping to the session-list section keeps this off
      // the run header's identically named overflow control.
      const sessionList = app.window.getByTestId('agent-session-list');
      const sessionsToggle = sessionList.getByRole('button', { name: 'All sessions' });
      await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'false');
      await sessionsToggle.click();
      await expect(sessionsToggle).toHaveAttribute('aria-expanded', 'true');

      const sessionItems = sessionList.getByRole('list', { name: 'All agent sessions' });
      await expect(sessionItems).toBeVisible();
      await expect(sessionList.getByTestId('agent-session-item-profile').first())
        .toHaveText('Fake Agent (test/development only)');
      await expect(sessionList.getByTestId('agent-session-item-model').first()).toHaveText('fixture-model-b');

      // A row is announced by its task, never by the internal run id.
      await sessionItems.getByRole('button', { name: `Task: ${started.userPrompt}, Completed`, exact: false }).click();
      await expect(app.window.getByTestId('agent-active-session-model')).toHaveText('fixture-model-b');
      await expect(app.window.getByTestId('agent-resume-section')).toBeVisible({ timeout: 10_000 });
      await app.window.getByLabel('Follow-up prompt').fill('continue under the original model');
      await app.window.getByTestId('agent-resume-button').click();

      await expect.poll(async () => app.window.evaluate(async ({ id, sessionId }) => {
        const detail = await window.interleafAPI.agent.getSession(sessionId, id);
        return (detail?.events ?? [])
          .filter((event) => event.type === 'stdout')
          .map((event) => event.text)
          .filter((text) => text.includes('fixture stdout:') && text.includes('--resume')).length;
      }, { id: documentId, sessionId: started.id }), { timeout: 15_000 }).toBeGreaterThan(0);

      const detail = await app.window.evaluate(
        ({ id, sessionId }) => window.interleafAPI.agent.getSession(sessionId, id),
        { id: documentId, sessionId: started.id },
      );
      expect(detail?.effectiveModel).toBe('fixture-model-b');
      const resumeEcho = (detail?.events ?? [])
        .filter((event) => event.type === 'stdout')
        .map((event) => event.text)
        .filter((text) => text.includes('fixture stdout:') && text.includes('--resume'));
      expect(resumeEcho.length).toBeGreaterThan(0);
      expect(resumeEcho.every((text) => text.includes('--model fixture-model-b'))).toBe(true);
      expect(resumeEcho.some((text) => text.includes('fixture-model-a'))).toBe(false);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});
