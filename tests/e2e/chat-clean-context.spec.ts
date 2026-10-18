import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chooseChatModel, configureOpenRouterTestSeam, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Persistent attached context and `Clean Context`, end to end.
 *
 * Both halves are one reader-visible promise: what you attach stays attached
 * until you remove it or clean the conversation, and cleaning summarises the
 * conversation through the session's own provider while leaving the transcript
 * readable. The provider boundary here is the real OpenRouter path with a
 * deterministic local network seam — no paid call is ever made.
 */


test.describe('Chat Clean Context and persistent attached context', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-clean-context-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('keeps attached context across turns and compacts the conversation on request', async () => {
    await configureOpenRouterTestSeam(app);

    const pdfPath = join(fixtureDir, 'Clean_Context_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Clean Context Fixture',
      author: 'Interleaf QA',
      pageLines: [
        ['Quorum replication requires a majority of replicas to acknowledge each write.'],
        ['Leader election proceeds in terms, and a term has at most one leader.'],
      ],
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [fixtureDocument] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(fixtureDocument).toBeDefined();

    await app.window.getByTestId(`read-doc-${fixtureDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status,
    fixtureDocument!.id)).toBe('ready');

    await app.window.getByRole('tab', { name: 'Chat' }).click();
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    await chat.getByRole('button', { name: 'New chat' }).click();
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(chat.getByTestId('chat-model-picker')).toContainText('OpenRouter');

    const contextBar = chat.getByTestId('chat-context-bar');
    const budgetWheel = chat.getByTestId('chat-context-budget');
    const statsPanel = app.window.getByTestId('chat-context-budget-popover');
    const cleanTrigger = app.window.getByTestId('chat-clean-context-trigger');
    // Compaction is offered in the context-window panel, never in the
    // attached-context row.
    await expect(contextBar.getByTestId('chat-clean-context-trigger')).toHaveCount(0);
    await expect(contextBar).not.toContainText('Clean Context');
    // Nothing has been packed yet, so the panel has no figures to show and says
    // so rather than inventing a zero — and it still opens, because the live
    // conversation is where compaction is offered. There is nothing settled to
    // summarise yet, so the action is present and refused.
    await expect(budgetWheel).toHaveCount(1);
    await expect(cleanTrigger).toHaveCount(0);
    await budgetWheel.click();
    await expect(statsPanel.getByTestId('chat-context-budget-unavailable')).toBeVisible();
    await expect(statsPanel.getByTestId('chat-context-budget-tokens')).toHaveCount(0);
    await expect(statsPanel.getByTestId('chat-context-budget-breakdown')).toHaveCount(0);
    await expect(cleanTrigger).toBeDisabled();
    await app.window.keyboard.press('Escape');
    await expect(statsPanel).toHaveCount(0);

    await chat.getByRole('button', { name: 'Add pages to AI context' }).click();
    await app.window.getByLabel('Start page for context').fill('1');
    await app.window.getByLabel('End page for context').fill('2');
    await app.window.getByRole('button', { name: 'Add range' }).click();
    await expect(contextBar.getByText('Pages 1–2')).toBeVisible();

    const composer = chat.getByLabel('Message Reader AI');
    const [session] = await app.window.evaluate(async (documentId) =>
      window.interleafAPI.chat.listSessions(documentId), fixtureDocument!.id);
    expect(session).toBeDefined();

    const answered = async (minimum: number): Promise<number> => {
      const messages = await app.window.evaluate(async (sessionId) =>
        window.interleafAPI.chat.listMessages(sessionId), session!.id);
      const complete = messages.filter((message) => message.role === 'assistant' && message.status === 'complete');
      return complete.length >= minimum ? complete.length : -1;
    };

    await composer.fill('What does quorum replication require?');
    await composer.press('Enter');
    await expect.poll(async () => answered(1)).toBeGreaterThanOrEqual(1);

    // The chip outlives the turn that sent it.
    await expect(contextBar.getByText('Pages 1–2')).toBeVisible();
    await composer.fill('And how does leader election relate?');
    await composer.press('Enter');
    await expect.poll(async () => answered(2)).toBeGreaterThanOrEqual(2);
    await expect(contextBar.getByText('Pages 1–2')).toBeVisible();
    expect(await app.window.evaluate(async (sessionId) =>
      (await window.interleafAPI.chat.listContext(sessionId)).length, session!.id)).toBe(1);

    // Clean Context lives in the context-window panel, as text alone, and says
    // what it will do before it does it.
    await budgetWheel.click();
    await expect(statsPanel).toBeVisible();
    await expect(statsPanel).toContainText('Context window');
    await expect(cleanTrigger).toBeVisible();
    await expect(cleanTrigger).toBeEnabled();
    await expect(cleanTrigger).toHaveAccessibleName('Clean Context');
    expect(await cleanTrigger.locator('svg, img').count()).toBe(0);

    await cleanTrigger.click();
    const confirm = app.window.getByTestId('chat-clean-context-confirm-region');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('OpenRouter');
    await expect(confirm).toContainText('attached context is removed');
    // Asked inside the panel rather than in a second dialog on top of it.
    await expect(app.window.getByRole('dialog')).toHaveCount(1);
    // Escape backs out of the question and changes nothing; the panel stays.
    await app.window.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(statsPanel).toBeVisible();
    await expect(contextBar.getByText('Pages 1–2')).toBeVisible();

    await cleanTrigger.click();
    await confirm.getByTestId('chat-clean-context-confirm').click();

    await expect.poll(async () => app.window.evaluate(async (sessionId) =>
      (await window.interleafAPI.chat.listContext(sessionId)).length, session!.id)).toBe(0);
    await expect(contextBar.getByText('Pages 1–2')).toHaveCount(0);
    await expect(contextBar).toContainText('0 items');
    // Compaction, not deletion: every message is still on screen.
    await expect(chat.getByText('What does quorum replication require?')).toBeVisible();
    await expect(chat.getByText('And how does leader election relate?')).toBeVisible();

    const db = new DatabaseSync(join(app.userDataDir, 'database', 'interleaf.sqlite'));
    try {
      const state = db.prepare(`
        SELECT context_summary, compacted_through_ordinal, context_summary_updated_at
          FROM chat_sessions WHERE id = ?
      `).get(session!.id) as {
        context_summary: string | null;
        compacted_through_ordinal: number | null;
        context_summary_updated_at: string | null;
      };
      expect(state.context_summary).toBeTruthy();
      expect(state.compacted_through_ordinal).toBe(3);
      expect(state.context_summary_updated_at).toBeTruthy();
      const stored = db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?')
        .get(session!.id) as { count: number };
      expect(stored.count).toBe(4);
      const context = db.prepare('SELECT COUNT(*) AS count FROM chat_context_items WHERE session_id = ?')
        .get(session!.id) as { count: number };
      expect(context.count).toBe(0);
    } finally {
      db.close();
    }

    // A later turn replays the stored summary and only the messages after the
    // boundary, and the summary never reaches the system prompt.
    await composer.fill('Summarise where we got to.');
    await composer.press('Enter');
    await expect.poll(async () => answered(3)).toBeGreaterThanOrEqual(3);

    // Real BrowserWindow zoom: the control and its confirmation stay inside the
    // window at 200%, and the summary row does not clip its label.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(2400, 1200);
      window.webContents.setZoomFactor(2.0);
    });
    await expect.poll(async () => app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(2);
    const zoomedChat = app.window.getByRole('region', { name: 'AI research chat' });
    // The panel outlives the compaction it offered — the figures go away, not
    // the panel — so the zoomed pass starts by closing whatever is open.
    await app.window.keyboard.press('Escape');
    await expect(statsPanel).toHaveCount(0);
    await zoomedChat.getByTestId('chat-context-budget').click();
    const zoomedTrigger = app.window.getByTestId('chat-clean-context-trigger');
    await expect(zoomedTrigger).toBeVisible();
    await zoomedTrigger.click();
    await expect(app.window.getByTestId('chat-clean-context-confirm-region')).toBeVisible();
    const containment = await app.window.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="chat-context-budget-popover"]');
      const trigger = document.querySelector<HTMLElement>('[data-testid="chat-clean-context-trigger"]');
      const confirm = document.querySelector<HTMLElement>('[data-testid="chat-clean-context-confirm-region"]');
      if (!panel || !trigger || !confirm) return null;
      const panelBox = panel.getBoundingClientRect();
      const confirmBox = confirm.getBoundingClientRect();
      const contained = (box: DOMRect): boolean =>
        box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight;
      return {
        panelContained: contained(panelBox),
        // The question stays inside the panel that asked it rather than
        // escaping its edges at this zoom.
        confirmInsidePanel: confirmBox.left >= panelBox.left - 1 && confirmBox.right <= panelBox.right + 1,
        labelVisible: trigger.textContent === 'Clean Context',
        horizontalOverflow: document.body.scrollWidth - document.body.clientWidth > 1,
      };
    });
    expect(containment).toEqual({
      panelContained: true,
      confirmInsidePanel: true,
      labelVisible: true,
      horizontalOverflow: false,
    });
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.0);
    });
  });
});
