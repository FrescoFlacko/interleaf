import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chooseChatModel, dismissOnboardingIfOpen, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/**
 * Reader Chat's context row and composer, exercised through the real app.
 *
 * Three things are held here that only the running product can show: the whole
 * document has exactly one control and that control presses both ways, a
 * failed turn's words come back to the composer and its only Retry nudge just
 * refills the composer without sending, and the row stays contained when the window is zoomed to
 * 200%.
 *
 * The provider boundary is the genuine OpenRouter client behind an intercepted
 * `fetch`, so no paid call is ever made. The same seam is flipped to a refusal
 * to produce the failure the draft recovery answers.
 */
test.describe('Reader Chat context controls and composer recovery', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-polish-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('offers one Entire document toggle, a fill-only Retry nudge, and returns a failed prompt to the composer', async () => {
    const pdfPath = join(fixtureDir, 'Chat_Polish_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Chat Polish Fixture',
      author: 'Interleaf',
      pageLines: Array.from({ length: 6 }, (_unused, index) => [
        `Chat polish fixture page ${String(index + 1)}: bounded research content for context control testing.`,
      ]),
    }));

    await dismissOnboardingIfOpen(app);
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    // A deterministic OpenRouter boundary whose outcome this test controls.
    await app.electronApp.evaluate(() => {
      const store = globalThis as { __chatSeamFails?: boolean };
      store.__chatSeamFails = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init);
        if (store.__chatSeamFails === true) {
          return new Response('{"error":{"message":"Seam refused the turn."}}', {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        const body = [
          'data: {"choices":[{"delta":{"content":"Grounded seam answer [src-1]."}}]}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await app.window.evaluate(async () => {
      await window.interleafAPI.ai.configureOpenRouter({ apiKey: 'sk-or-v1-chat-polish-seam', model: 'openrouter/auto' });
    });
    await app.window.reload();
    await app.window.waitForLoadState('domcontentloaded');

    await dismissOnboardingIfOpen(app);
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
    await expect(contextBar).toBeVisible();

    // 1. The whole document has one representation, and it is a toggle.
    const wholeDocument = contextBar.getByRole('button', { name: 'Entire document' });
    await expect(wholeDocument).toHaveCount(1);
    await expect(wholeDocument).toHaveAttribute('aria-pressed', 'false');

    // 2. The Add trigger is the "@ Add context" pill with its specific name.
    const addTrigger = contextBar.getByRole('button', { name: 'Add pages to AI context' });
    await expect(addTrigger).toBeVisible();
    expect((await addTrigger.innerText()).replace(/\s+/gu, ' ').trim()).toBe('@ Add context');

    await wholeDocument.click();
    await expect(wholeDocument).toHaveAttribute('aria-pressed', 'true');
    const sessions = await app.window.evaluate(async (documentId) =>
      window.interleafAPI.chat.listSessions(documentId), fixtureDocument!.id);
    const session = sessions[0];
    expect(session).toBeDefined();
    await expect.poll(async () => {
      const items = await app.window.evaluate(async (sessionId) =>
        window.interleafAPI.chat.listContext(sessionId), session!.id);
      return items.filter((item) => item.kind === 'entire_document').length;
    }).toBe(1);
    // Still exactly one control, and no separate removable chip for the same
    // attachment.
    await expect(contextBar.getByRole('button', { name: 'Entire document' })).toHaveCount(1);
    await expect(contextBar.getByRole('button', { name: /Remove Entire document/ })).toHaveCount(0);

    // 3. Pressing it again removes the stored item through main.
    await wholeDocument.click();
    await expect(wholeDocument).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => {
      const items = await app.window.evaluate(async (sessionId) =>
        window.interleafAPI.chat.listContext(sessionId), session!.id);
      return items.filter((item) => item.kind === 'entire_document').length;
    }).toBe(0);

    // 4. A successful turn, so the transcript carries a settled answer whose
    //    actions can be inspected for a retry control that must not be there.
    const composer = chat.getByLabel('Message Reader AI');
    await composer.fill('Summarise the fixture.');
    await composer.press('Enter');
    await expect.poll(async () => {
      const messages = await app.window.evaluate(async (sessionId) =>
        window.interleafAPI.chat.listMessages(sessionId), session!.id);
      return messages.find((message) => message.role === 'assistant')?.status ?? null;
    }).toBe('complete');
    await expect(chat.getByTestId('retry-chat-button')).toHaveCount(0);
    await expect(chat.getByRole('button', { name: /Retry/i })).toHaveCount(0);
    await expect(composer).toHaveValue('');

    // 5. The provider refuses the next turn. There is nothing to press, so the
    //    exact submitted prompt comes back to the composer for this session.
    await app.electronApp.evaluate(() => {
      (globalThis as { __chatSeamFails?: boolean }).__chatSeamFails = true;
    });
    await composer.fill('Which page mentions leader election?');
    await composer.press('Enter');
    await expect.poll(async () => composer.inputValue(), { timeout: 20_000 })
      .toBe('Which page mentions leader election?');
    await expect(chat.getByTestId('retry-chat-button')).toHaveCount(0);
    // The only Retry is the fill-only nudge under the failed answer: it puts
    // the same words back in the composer and sends nothing.
    const retry = chat.getByTestId('chat-follow-ups').getByRole('button', { name: 'Retry', exact: true });
    await expect(chat.getByRole('button', { name: /Retry/i })).toHaveCount(1);
    await composer.fill('');
    await retry.click();
    await expect(composer).toHaveValue('Which page mentions leader election?');
    await expect(composer).toBeFocused();

    // 6. Sending it again is an ordinary send, and success clears the recovery.
    await app.electronApp.evaluate(() => {
      (globalThis as { __chatSeamFails?: boolean }).__chatSeamFails = false;
    });
    await composer.press('Enter');
    await expect.poll(async () => {
      const messages = await app.window.evaluate(async (sessionId) =>
        window.interleafAPI.chat.listMessages(sessionId), session!.id);
      return messages.filter((message) => message.role === 'assistant' && message.status === 'complete').length;
    }, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await expect(composer).toHaveValue('');

    // 7. The composer reserves no slot for controls this conversation does not
    //    have, and the row stays inside the panel at 200% zoom.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(2400, 1200);
      window.webContents.setZoomFactor(2.0);
    });
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();
    const zoomed = await app.window.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>('.chat-design-controls');
      const bar = document.querySelector<HTMLElement>('[data-testid="chat-context-bar"]');
      const send = document.querySelector<HTMLElement>('[data-testid="send-chat-button"]');
      const panel = document.querySelector<HTMLElement>('[data-testid="companion-panel"]');
      const sendGroup = send;
      const panelRight = panel?.getBoundingClientRect().right ?? window.innerWidth;
      // The last control actually on screen, whichever of the optional ones this
      // conversation turned out to have.
      const controls = toolbar ? Array.from(toolbar.children).filter((child) => child !== send) : [];
      const lastControl = controls[controls.length - 1];
      const lastControlRight = lastControl?.getBoundingClientRect().right ?? 0;
      const sendLeft = sendGroup?.getBoundingClientRect().left ?? 0;
      return {
        bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
        barRight: bar?.getBoundingClientRect().right ?? 0,
        sendRight: send?.getBoundingClientRect().right ?? 0,
        toolbarOverflowX: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : 0,
        controlCount: controls.length,
        lastControlToSendGap: sendLeft - lastControlRight,
        panelRight,
      };
    });
    const sendToComposerRightGap = await app.window.evaluate(() => {
      const composer = document.querySelector<HTMLElement>('.chat-design-composer');
      const send = document.querySelector<HTMLElement>('[data-testid="send-chat-button"]');
      const composerRight = composer ? composer.getBoundingClientRect().right : 0;
      const paddingRight = composer ? parseFloat(window.getComputedStyle(composer).paddingRight) : 0;
      const sendRight = send ? send.getBoundingClientRect().right : 0;
      return composerRight - paddingRight - sendRight;
    });
    expect(zoomed.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(zoomed.barRight).toBeLessThanOrEqual(zoomed.panelRight + 1);
    expect(zoomed.sendRight).toBeLessThanOrEqual(zoomed.panelRight + 1);
    expect(zoomed.toolbarOverflowX).toBeLessThanOrEqual(1);
    // This conversation has no web search and no reported context window, so
    // the model picker is the whole row. Send is pinned to the
    // composer's right content edge, leaving the free space between the toolbar
    // and Send while maintaining at least the compact minimum gap without overlap.
    expect(zoomed.controlCount).toBeGreaterThanOrEqual(1);
    expect(zoomed.lastControlToSendGap).toBeGreaterThanOrEqual(4);
    expect(sendToComposerRightGap).toBeLessThanOrEqual(2);
    expect(sendToComposerRightGap).toBeGreaterThanOrEqual(-1);

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.webContents.setZoomFactor(1.0);
      window.setSize(1400, 900);
    });
  });
});
