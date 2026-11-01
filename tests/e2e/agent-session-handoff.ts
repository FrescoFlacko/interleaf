import { expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectFakeAgentForTest, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Agent session ownership handoff (docs/REMAINING_WORK.md item C), shared by
 * the macOS close-and-reopen case and the relaunch case every host can reach.
 * A window that did not start a session may not act on it by naming its ID
 * until it claims the session explicitly; then it can copy, review, resume and
 * apply it. No provider is contacted: the gated fake CLI fixture produces the run.
 */
export type CompletedAgentSession = { readonly documentId: string; readonly sessionId: string; readonly userPrompt: string };

/** Imports a fixture document and runs the fake agent on it to completion in `app`'s window. */
export async function startCompletedAgentSession(app: AppHandle, workingDirectory: string): Promise<CompletedAgentSession> {
  const pdfPath = join(workingDirectory, 'agent-handoff.pdf');
  writeFileSync(pdfPath, makePdfFixture({
    title: 'Agent Handoff',
    author: 'Interleaf',
    pageLines: [['Document-scoped agent session ownership.']],
  }));
  await stubOpenDialog(app, [pdfPath]);
  await app.window.getByTestId('import-files-button').click();
  await expect(app.window.getByTestId('success-banner')).toBeVisible();
  const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
  if (document === undefined) throw new Error('Fixture document was not imported.');
  await app.window.getByTestId(`read-doc-${document.id}`).click();
  await app.window.getByRole('tab', { name: /Agent/i }).click();
  await expect(app.window.getByRole('combobox', { name: 'Agent profile' })).toBeVisible();
  await selectFakeAgentForTest(app);
  await stubOpenDialog(app, [workingDirectory]);
  await app.window.getByRole('button', { name: 'Choose…' }).click();
  await expect(app.window.getByTestId('agent-working-directory')).not.toHaveText('Not selected');
  await app.window.getByLabel('Task description').fill('summarize the fixture workspace');
  await app.window.getByRole('button', { name: 'Start agent' }).click();
  await expect.poll(async () => app.window.evaluate(async (documentId) => {
    const sessions = await window.interleafAPI.agent.listSessions(documentId);
    return sessions[0]?.status ?? null;
  }, document.id), { timeout: 30_000 }).toBe('completed');
  const session = await app.window.evaluate(
    async (documentId) => (await window.interleafAPI.agent.listSessions(documentId))[0],
    document.id,
  );
  if (session === undefined) throw new Error('Agent session was not persisted.');
  return { documentId: document.id, sessionId: session.id, userPrompt: session.userPrompt };
}

/** Proves `window2`, a different owner, is barred until it claims the session, and can then act on it fully. */
export async function expectHandoffToNewOwner(window2: Page, completed: CompletedAgentSession, workingDirectory: string): Promise<void> {
  const { documentId, sessionId, userPrompt } = completed;
  // A different window may not act on the session by naming its ID.
  const beforeClaim = await window2.evaluate(async (sessionId) => {
    try {
      await window.interleafAPI.agent.copyResult(sessionId);
      return 'copied';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, sessionId);
  expect(beforeClaim).toMatch(/not owned/i);

  // The explicit handoff is what grants ownership.
  expect(await window2.evaluate(async (sessionId) => window.interleafAPI.agent.claimSession(sessionId), sessionId))
    .toEqual({ claimed: true, ownerChanged: true });

  const afterClaim = await window2.evaluate(async ({ sessionId, documentId }) => {
    const copy = await window.interleafAPI.agent.copyResult(sessionId);
    const review = await window.interleafAPI.agent.getEnvironmentReview(sessionId);
    const resumed = await window.interleafAPI.agent.resumeSession({ sessionId, prompt: 'continue the summary' });
    const detail = await window.interleafAPI.agent.getSession(resumed.session.id, documentId);
    return { copied: copy.copied, reviewSessionId: review?.sessionId ?? null, resumedId: resumed.session.id, status: detail?.status ?? null };
  }, { sessionId: sessionId, documentId: documentId });
  expect(afterClaim.copied).toBe(true);
  expect(afterClaim.reviewSessionId).toBe(sessionId);
  expect(afterClaim.resumedId).toBe(sessionId);

  // The resumed run has to have stopped before the sandbox actions are
  // offered, so the UI walk below waits for the session itself rather than
  // for a duration.
  await expect.poll(async () => window2.evaluate(async (documentId) => {
    const sessions = await window.interleafAPI.agent.listSessions(documentId);
    return sessions[0]?.status ?? null;
  }, documentId), { timeout: 30_000 }).toBe('completed');

  // The reopened window's UI drives the same owned session. Opening the
  // document does not select it: hydrate only auto-selects a session that
  // is still running, and this one has finished. That is the product's
  // behaviour and stays unchanged — a reopened window does not reopen old
  // history on its own — so the reader picks the session out of the
  // "All sessions" history, which is the real path to a finished run.
  const wizard = window2.getByTestId('onboarding-wizard');
  if (await wizard.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) {
    await window2.getByTestId('onboarding-start-reading').click();
    await expect(wizard).toBeHidden({ timeout: 10_000 });
  }
  await window2.getByTestId(`read-doc-${documentId}`).click();
  await window2.getByRole('tab', { name: /Agent/i }).click();
  const history = window2.getByTestId('agent-session-list');
  await expect(history).toBeVisible({ timeout: 30_000 });
  await history.getByRole('button', { name: 'All sessions' }).click();
  // The history row is announced by its task, never by the internal run id.
  const historyItem = history.getByRole('button', { name: `Task: ${userPrompt.replace(/[.!?]+$/u, '')}, Completed`, exact: false });
  await expect(historyItem).toBeVisible({ timeout: 30_000 });
  await historyItem.click();

  await expect(window2.getByTestId('agent-environment-review')).toBeVisible({ timeout: 30_000 });
  await window2.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(window2.getByTestId('agent-review-files')).toContainText('interleaf-fixture-change.txt');

  // Apply is exercised, not merely enabled: the sandbox change has to land
  // in the working directory the session targets.
  const appliedFile = join(workingDirectory, 'interleaf-fixture-change.txt');
  expect(existsSync(appliedFile)).toBe(false);
  const applyChanges = window2.getByRole('button', { name: 'Apply Changes' });
  await expect(applyChanges).toBeEnabled();
  await applyChanges.click();
  await expect.poll(() => (existsSync(appliedFile) ? readFileSync(appliedFile, 'utf8') : null), { timeout: 30_000 })
    .toBe('Deterministic fake agent change\n');
  // And the applied environment is what the reopened window now reports.
  await expect.poll(async () => window2.evaluate(async ({ sessionId, documentId }) => {
    const detail = await window.interleafAPI.agent.getSession(sessionId, documentId);
    return detail?.environmentState ?? null;
  }, { sessionId: sessionId, documentId: documentId }), { timeout: 30_000 }).toBe('applied');
}
