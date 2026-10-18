import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { createOmpCliFixture } from './omp-cli-fixture';

test.describe('Defect 6: OpenRouter provider selection and truthful binding', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let binDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-openrouter-selection-'));
    // An offline fixture CLI is the one ready provider this isolated app can
    // discover; no host-installed CLI is reachable.
    binDir = createOmpCliFixture();
    app = await launchInterleaf({ binDir });
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  test('fails closed when unavailable, then routes a new session through the OpenRouter test seam', async () => {
    const pdfPath = join(fixtureDir, 'OpenRouter_Selection_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'OpenRouter Selection Fixture',
      author: 'Interleaf',
      pageLines: [['A deterministic passage for provider routing.']],
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    let [libraryDocument] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(libraryDocument).toBeDefined();
    await app.window.getByTestId(`read-doc-${libraryDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    // OpenRouter starts disconnected in the isolated app, so the picker does
    // not offer it at all: only ready providers are groups, followed by the
    // Settings remedy. Wait for discovery so the assertion is about settled
    // statuses.
    await expect(app.window.getByText('Checking available AI providers…')).toHaveCount(0, { timeout: 15_000 });
    await app.window.getByTestId('chat-model-picker').click();
    const picker = app.window.getByTestId('chat-model-picker-popover');
    await expect(picker).toBeVisible();
    await expect(picker.locator('[role="option"][data-provider-id="openrouter"]')).toHaveCount(0);
    // The ready fixture provider is still offered, and it is the only group.
    await expect(picker.getByRole('group', { name: 'Omp', exact: true })).toBeVisible();
    await expect(picker.getByRole('group')).toHaveCount(1);
    await expect(picker.getByTestId('chat-provider-edit')).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(app.window.getByTestId('chat-model-picker')).toBeFocused();
    expect(await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), libraryDocument!.id)).toHaveLength(0);

    // Test seam: persist only a temporary key in this isolated E2E profile and
    // intercept the OpenRouter completion request in Electron's main process.
    await app.electronApp.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init);
        const body = [
          'data: {"choices":[{"delta":{"content":"OpenRouter seam response."}}]}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await app.window.evaluate(async () => {
      await window.interleafAPI.ai.configureOpenRouter({ apiKey: 'sk-or-v1-e2e-temporary-key', model: 'openrouter/auto' });
    });
    await app.window.reload();
    await app.window.waitForLoadState('domcontentloaded');

    [libraryDocument] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(libraryDocument).toBeDefined();
    await app.window.getByTestId(`read-doc-${libraryDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();
    // The fixture CLI stays the default; OpenRouter is now ready and offered.
    const providerTrigger = app.window.getByTestId('chat-model-picker');
    await expect(providerTrigger).toBeVisible();

    // Choose OpenRouter explicitly through the model picker.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await app.window.getByRole('button', { name: 'New chat' }).click();
    await app.window.getByRole('button', { name: 'Back to conversations' }).click();
    const currentCard = app.window.locator('[data-testid^="session-card-"][data-current="true"]');
    await expect(currentCard).toContainText('OpenRouter · openrouter/auto');
    await app.window.getByTestId('resume-chat-session').click();
    const sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), libraryDocument!.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ providerId: 'openrouter', modelId: 'openrouter/auto' });

    const composer = app.window.getByLabel('Message Reader AI');
    await composer.fill('Prove the selected provider is used.');
    await composer.press('Enter');
    await expect.poll(async () => {
      const messages = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listMessages(sessionId), sessions[0]!.id);
      return messages.find((message) => message.role === 'assistant')?.status;
    }).toBe('complete');
    await expect(app.window.getByText('OpenRouter seam response.')).toBeVisible();

    const dbPath = join(app.userDataDir, 'database', 'interleaf.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT provider_id, model_id FROM chat_sessions WHERE id = ?').get(sessions[0]!.id) as { provider_id: string; model_id: string | null };
      expect(row).toEqual({ provider_id: 'openrouter', model_id: 'openrouter/auto' });
    } finally {
      db.close();
    }

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(960, 640);
      window.webContents.setZoomFactor(2.0);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeLessThan(920);
    expect(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(2);
    await app.window.getByTestId('toggle-right-panel').click();
    const drawer = app.window.getByTestId('compact-drawer-right');
    await expect
      .poll(async () =>
        drawer.evaluate((node) => {
          const raw = getComputedStyle(node).transform;
          return raw === 'none' || raw === 'matrix(1, 0, 0, 1, 0, 0)';
        })
      )
      .toBe(true);
    await expect(drawer.getByRole('region', { name: 'AI research chat' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Back to conversations' }).click();
    await drawer.locator('[data-testid^="session-card-"][data-current="true"]').evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
    });

    const containment = await app.window.evaluate(() => {
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
        chatOverflowX: chatElement ? chatElement.scrollWidth - chatElement.clientWidth : null,
      };
    });
    expect(containment.bodyScrollWidth).toBeLessThanOrEqual(containment.innerWidth + 1);
    expect(containment.bodyScrollHeight).toBeLessThanOrEqual(containment.innerHeight + 1);
    expect(containment.appOverflowX).toBeLessThanOrEqual(1);
    expect(containment.drawerRight).toBeLessThanOrEqual(containment.innerWidth + 1);
    expect(containment.drawerBottom).toBeLessThanOrEqual(containment.innerHeight + 1);
    expect(containment.chatWithinDrawer).toBe(true);
    expect(containment.chatOverflowX).toBeLessThanOrEqual(1);
  });
});
