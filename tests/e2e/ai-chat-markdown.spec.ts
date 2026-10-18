import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, configureOpenRouterTestSeam, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

test.describe('Defect 5: AI Chat Markdown rendering', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-markdown-'));
    app = await launchInterleaf();
    await configureOpenRouterTestSeam(app);
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('renders Markdown in both prompt and deterministic streamed response, and stays contained at 200%', async () => {
    const pdfPath = join(fixtureDir, 'Markdown_Chat_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Markdown Chat Fixture',
      author: 'Interleaf',
      pageLines: [['A deterministic passage for grounded Markdown chat.']],
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [openedDocument] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(openedDocument).toBeDefined();
    await app.window.getByTestId(`read-doc-${openedDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();
    await app.window.getByRole('button', { name: 'New chat' }).click();
    // Bind the session to the intercepted OpenRouter boundary. Without this
    // the session takes whichever provider is first available, which on a
    // machine with an authenticated CLI provider installed is not the seam.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(app.window.getByTestId('chat-model-picker')).toContainText('OpenRouter');

    const composer = app.window.getByLabel('Message Reader AI');
    await composer.fill(`### User heading\n\nThis **prompt** is Markdown.\n\n${'LongToken'.repeat(500)}`);
    await composer.press('Enter');
    await expect.poll(async () => {
      const sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), openedDocument!.id);
      const session = sessions[0];
      if (!session) return 0;
      return (await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listMessages(sessionId), session.id))
        .filter((message) => message.status === 'complete').length;
    }).toBe(2);

    const userMessage = app.window.getByRole('article').filter({ hasText: 'You' });
    await expect(userMessage.getByRole('heading', { name: 'User heading' })).toBeVisible();
    await expect(userMessage.getByText('prompt')).toHaveCount(1);
    await expect(userMessage).not.toContainText('### User heading');

    const assistantMessage = app.window.getByRole('article').filter({ hasText: 'Reader AI' });
    await expect(assistantMessage.getByRole('heading', { name: 'Grounded Markdown' })).toBeVisible();
    await expect(assistantMessage.getByText('formatted')).toHaveCount(1);
    await expect(assistantMessage.getByRole('list')).toBeVisible();
    await expect(assistantMessage.getByRole('blockquote')).toBeVisible();
    await expect(assistantMessage.getByText('stream-safe example')).toBeVisible();
    await expect(assistantMessage).not.toContainText('### Grounded Markdown');

    const chatMessages = app.window.getByTestId('chat-messages');
    await expect(chatMessages).toBeVisible();

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(960, 640);
      window.webContents.setZoomFactor(2.0);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeLessThan(920);
    const zoomFactor = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor());
    expect(zoomFactor).toBe(2);

    const rightToggle = app.window.getByTestId('toggle-right-panel');
    await expect(rightToggle).toBeVisible();
    await rightToggle.click();
    const drawer = app.window.getByTestId('compact-drawer-right');
    await expect(drawer).toBeVisible();
    await expect
      .poll(async () =>
        drawer.evaluate((node) => {
          const raw = getComputedStyle(node).transform;
          return raw === 'none' || raw === 'matrix(1, 0, 0, 1, 0, 0)';
        })
      )
      .toBe(true);
    await expect(drawer.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    const containment = await app.window.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('[data-testid="app-shell"]');
      const drawerElement = document.querySelector<HTMLElement>('[data-testid="compact-drawer-right"]');
      const chatMessagesElement = document.querySelector<HTMLElement>('[data-testid="chat-messages"]');
      const codeElement = document.querySelector<HTMLElement>('[data-testid^="chat-message-"] pre');
      const drawerRect = drawerElement?.getBoundingClientRect();
      const chatRect = chatMessagesElement?.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight,
        shellOverflowX: shell ? shell.scrollWidth - shell.clientWidth : null,
        drawerRight: drawerRect?.right ?? null,
        drawerBottom: drawerRect?.bottom ?? null,
        chatRight: chatRect?.right ?? null,
        chatOverflowX: chatMessagesElement ? chatMessagesElement.scrollWidth - chatMessagesElement.clientWidth : null,
        codeOverflowX: codeElement ? codeElement.scrollWidth - codeElement.clientWidth : null,
        chatWithinDrawer: drawerElement !== null && chatMessagesElement !== null && drawerElement.contains(chatMessagesElement),
        drawerOverflowY: drawerElement ? drawerElement.scrollHeight - drawerElement.clientHeight : null,
      };
    });
    expect(containment.bodyScrollWidth).toBeLessThanOrEqual(containment.innerWidth + 1);
    expect(containment.bodyScrollHeight).toBeLessThanOrEqual(containment.innerHeight + 1);
    expect(containment.shellOverflowX).toBeLessThanOrEqual(1);
    expect(containment.drawerRight).toBeLessThanOrEqual(containment.innerWidth + 1);
    expect(containment.drawerBottom).toBeLessThanOrEqual(containment.innerHeight + 1);
    expect(containment.chatRight).toBeLessThanOrEqual(containment.drawerRight! + 1);
    expect(containment.chatWithinDrawer).toBe(true);
    expect(containment.drawerOverflowY).toBeGreaterThanOrEqual(0);
    expect(containment.chatOverflowX).toBeLessThanOrEqual(1);
    expect(containment.codeOverflowX).toBeLessThanOrEqual(1);
  });
});
