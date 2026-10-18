import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/** Titles of every conversation card on the Conversations screen. */
function cardTitles(scope: Page | Locator): Locator {
  return scope.locator('[data-testid^="session-card-"] .chat-design-card-title');
}

/** Title the thread header shows for the conversation now open. */
function conversationLine(scope: Page | Locator): Locator {
  return scope.getByTestId('chat-conversation-line');
}

/** Title of the conversation the panel is currently bound to. */
function currentCardTitle(scope: Page | Locator): Locator {
  return scope.locator('[data-testid^="session-card-"][data-current="true"] .chat-design-card-title');
}

test.describe('Defect 7: Unique conversation names instead of "New conversation"', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-unique-chat-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('creates deterministic unique conversation names per document, preserves across restart, and supports renaming', async () => {
    const pdfPath = join(fixtureDir, 'Unique_Naming_Fixture.pdf');
    writeFileSync(
      pdfPath,
      makePdfFixture({
        title: 'Unique Conversation Naming Fixture',
        author: 'Interleaf',
        pageLines: [['Grounded text for unique conversation testing.']],
      })
    );

    // 1. Configure OpenRouter test seam so we do not couple to the fake provider (defect 16).
    await app.electronApp.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init);
        const body = [
          'data: {"choices":[{"delta":{"content":"Grounded response from OpenRouter test seam."}}]}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await app.window.evaluate(async () => {
      await window.interleafAPI.ai.configureOpenRouter({
        apiKey: 'sk-or-v1-e2e-temporary-key',
        model: 'openrouter/auto',
      });
    });

    // 2. Import and open the document.
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [doc] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(doc).toBeDefined();

    await app.window.getByTestId(`read-doc-${doc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    // 3. Open Chat panel.
    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    // Set provider to OpenRouter.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');

    // 4. Create Session 1.
    const newChatBtn = app.window.getByRole('button', { name: 'New chat' });
    await newChatBtn.click();

    // Main persists the session before it answers the create, and the thread
    // header only names a conversation the store has received. Reading the
    // persisted list once the header names it therefore reads the contract
    // itself — creation is durable by the time the user can see it — instead
    // of racing the round trip the click never awaited.
    await expect(conversationLine(app.window)).toHaveText('Conversation 1');

    // Verify Session 1 is named "Conversation 1" on its own card.
    let sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), doc!.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe('Conversation 1');
    const session1 = sessions[0]!;
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(currentCardTitle(app.window)).toHaveText('Conversation 1');
    // The Resume label and its chevron share one line.
    const resumeLines = await app.window.getByTestId('resume-chat-session').evaluate((button) => {
      const icon = button.querySelector('svg');
      const text = button.firstChild;
      if (icon === null || text === null) return null;
      const range = document.createRange();
      range.selectNodeContents(text);
      const label = range.getBoundingClientRect();
      const chevron = icon.getBoundingClientRect();
      return { sameRow: Math.abs((label.top + label.bottom) / 2 - (chevron.top + chevron.bottom) / 2) <= 2, height: Math.round(button.getBoundingClientRect().height) };
    });
    expect(resumeLines?.sameRow).toBe(true);
    expect(resumeLines?.height).toBeLessThanOrEqual(16);

    // Send a message in Conversation 1.
    await app.window.getByTestId('resume-chat-session').click();
    const composer = app.window.getByLabel('Message Reader AI');
    await composer.fill('Question in Conversation 1');
    await composer.press('Enter');
    await expect.poll(async () => {
      const messages = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listMessages(sessionId), session1.id);
      return messages.find((m) => m.role === 'assistant')?.status;
    }).toBe('complete');
    await expect(app.window.getByText('Grounded response from OpenRouter test seam.')).toBeVisible();

    // 6. Create Session 2.
    await newChatBtn.click();
    await expect(conversationLine(app.window)).toHaveText('Conversation 2');
    sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), doc!.id);
    expect(sessions).toHaveLength(2);
    const session2 = sessions.find((s) => s.title === 'Conversation 2');
    expect(session2).toBeDefined();
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(app.window.getByTestId(`session-card-${session2!.id}`)).toHaveAttribute('data-current', 'true');
    await app.window.getByTestId('resume-chat-session').click();

    // 7. Create Session 3.
    await newChatBtn.click();
    await expect(conversationLine(app.window)).toHaveText('Conversation 3');
    sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), doc!.id);
    expect(sessions).toHaveLength(3);
    const session3 = sessions.find((s) => s.title === 'Conversation 3');
    expect(session3).toBeDefined();
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(app.window.getByTestId(`session-card-${session3!.id}`)).toHaveAttribute('data-current', 'true');

    // 8. Rename Session 3 to "Architecture Notes" from its current-card action.
    await app.window.getByTestId('rename-chat-session').click();
    const renameInput = app.window.getByLabel('Edit chat session title');
    await renameInput.fill('Architecture Notes');
    await renameInput.press('Enter');

    await expect.poll(async () => {
      const currentSessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), doc!.id);
      return currentSessions.find((s) => s.id === session3!.id)?.title;
    }).toBe('Architecture Notes');
    await expect(currentCardTitle(app.window)).toHaveText('Architecture Notes');

    // 9. Delete Session 1 through its own card menu, creating a naming gap.
    // The card that is not current keeps its actions in the overflow menu.
    await app.window.getByTestId(`session-actions-${session1.id}`).click();
    await app.window.getByTestId(`delete-session-${session1.id}`).click();
    await app.window.getByRole('button', { name: 'Confirm delete conversation' }).click();

    await expect.poll(async () => {
      const currentSessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), doc!.id);
      return currentSessions.length;
    }).toBe(2);

    // 10. Create the next session from the Conversations screen: it reuses the
    // gap and is named "Conversation 1".
    await app.window.getByTestId('new-conversation-button').click();
    await expect(conversationLine(app.window)).toHaveText('Conversation 1');
    sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), doc!.id);
    expect(sessions).toHaveLength(3);
    const reusedSession = sessions.find((s) => s.title === 'Conversation 1');
    expect(reusedSession).toBeDefined();

    // The current card must truthfully display the full generated title.
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(currentCardTitle(app.window)).toHaveText('Conversation 1');

    // 11. Create another session: 1, 2, and "Architecture Notes" exist, so the
    // lowest unused positive integer N where "Conversation N" is free is 3.
    await app.window.getByTestId('new-conversation-button').click();
    await expect(conversationLine(app.window)).toHaveText('Conversation 3');
    sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), doc!.id);
    expect(sessions).toHaveLength(4);
    const session4 = sessions.find((s) => s.title === 'Conversation 3');
    expect(session4).toBeDefined();
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(currentCardTitle(app.window)).toHaveText('Conversation 3');

    // Switch to "Architecture Notes" to showcase a readable custom title in the evidence.
    await app.window.getByTestId(`open-session-${session3!.id}`).click();
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(currentCardTitle(app.window)).toHaveText('Architecture Notes');

    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });

    const relaunched = await launchInterleaf({ userDataDir });
    try {
      await expect(relaunched.window.getByTestId('library-view')).toBeVisible();
      await relaunched.window.getByTestId(`read-doc-${doc!.id}`).click();
      await expect(relaunched.window.getByTestId('pdf-canvas-p1')).toBeVisible();

      await relaunched.window.getByRole('tab', { name: 'Chat' }).click();
      await expect(relaunched.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();
      await relaunched.window.getByRole('button', { name: 'Back to conversations' }).click();
      await expect.poll(async () => {
        return cardTitles(relaunched.window).allInnerTexts();
      }).toContain('Conversation 1');

      const titles = await cardTitles(relaunched.window).allInnerTexts();
      expect(titles).toContain('Conversation 2');
      expect(titles).toContain('Conversation 3');
      expect(titles).toContain('Architecture Notes');
      expect(new Set(titles).size).toBe(titles.length);
      // 13. Capture 200% zoom screenshot with layout containment assertions.
      await relaunched.electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) throw new Error('Main BrowserWindow not found');
        win.setSize(960, 608);
        win.webContents.setZoomFactor(2.0);
      });

      await expect.poll(async () => relaunched.window.evaluate(() => window.innerWidth)).toBeLessThan(920);
      const zoom = await relaunched.electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor()
      );
      expect(zoom).toBe(2);

      // Toggle drawer if in compact mode.
      const rightToggle = relaunched.window.getByTestId('toggle-right-panel');
      if (await rightToggle.isVisible()) {
        await rightToggle.click();
      }
      const drawer = relaunched.window.getByTestId('compact-drawer-right');
      await expect
        .poll(async () =>
          drawer.evaluate((node) => {
            const raw = getComputedStyle(node).transform;
            return raw === 'none' || raw === 'matrix(1, 0, 0, 1, 0, 0)';
          })
        )
        .toBe(true);
      await expect(drawer.getByRole('region', { name: 'AI research chat' })).toBeVisible();
      const drawerRegion = drawer.getByRole('region', { name: 'AI research chat' });
      const openSessions = drawerRegion.getByRole('button', { name: 'Back to conversations' });
      if (await openSessions.count()) await openSessions.click();
      await drawerRegion.evaluate((element) => {
        element.scrollIntoView({ block: 'start', inline: 'nearest' });
      });
      await expect(currentCardTitle(drawerRegion)).toBeVisible();

      const containment = await relaunched.window.evaluate(() => {
        const drawerElement = document.querySelector<HTMLElement>('[data-testid="compact-drawer-right"]');
        const chatElement = drawerElement?.querySelector<HTMLElement>('[aria-label="AI research chat"]') ?? null;
        const appElement = document.querySelector<HTMLElement>('[data-testid="app-shell"]');
        const drawerRect = drawerElement?.getBoundingClientRect();
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          bodyScrollWidth: document.body.scrollWidth,
          bodyScrollHeight: document.body.scrollHeight,
          appOverflowX: appElement ? appElement.scrollWidth - appElement.clientWidth : null,
          drawerRight: drawerRect?.right ?? null,
          drawerBottom: drawerRect?.bottom ?? null,
          chatWithinDrawer: chatElement !== null,
        };
      });

      expect(containment.bodyScrollWidth).toBeLessThanOrEqual(containment.innerWidth + 1);
      expect(containment.bodyScrollHeight).toBeLessThanOrEqual(containment.innerHeight + 1);
      expect(containment.appOverflowX).toBeLessThanOrEqual(1);
      expect(containment.drawerRight).toBeLessThanOrEqual(containment.innerWidth + 1);
      expect(containment.drawerBottom).toBeLessThanOrEqual(containment.innerHeight + 1);
      expect(containment.chatWithinDrawer).toBe(true);
    } finally {
      await relaunched.close();
    }
  });
});
