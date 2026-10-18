import { expect, test, type Locator } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chooseChatModel, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { choosePalette } from './listbox';

/** Opens a disclosure control unless it already reports itself expanded. */
async function expandIfCollapsed(control: Locator): Promise<void> {
  if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click();
}

test.describe('Defect 14: chat context slim bar and Pages popover', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-context-bar-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('adds grounded page context through the real popover, preserves it, and remains contained at 200%', async () => {
    const pdfPath = join(fixtureDir, 'Context_Bar_Fixture.pdf');
    const pageLines = Array.from({ length: 8 }, (_, index) => [
      `Context bar fixture page ${String(index + 1)}: bounded research content for page range testing.`,
    ]);
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Context Bar Fixture',
      author: 'Interleaf',
      pageLines,
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

    // Use the real OpenRouter boundary with a deterministic network seam.
    // Fake providers are intentionally unavailable through renderer IPC.
    await app.electronApp.evaluate(() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init);
        const body = [
          'data: {"choices":[{"delta":{"content":"Context seam response."}}]}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await app.window.evaluate(async () => {
      await window.interleafAPI.ai.configureOpenRouter({ apiKey: 'sk-or-v1-context-seam-key', model: 'openrouter/auto' });
    });
    await app.window.reload();
    await app.window.waitForLoadState('domcontentloaded');
    const [reloadedDocument] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(reloadedDocument).toBeDefined();
    await app.window.getByTestId(`read-doc-${reloadedDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    await app.window.getByRole('tab', { name: 'Chat' }).click();
    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    await chat.getByRole('button', { name: 'New chat' }).click();
    // Bind the session to the intercepted OpenRouter boundary explicitly.
    // Without this the session takes whichever provider is first available,
    // which on a machine with a CLI provider installed is not the seam, and the
    // turn below fails for a reason that has nothing to do with this bar.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(chat.getByTestId('chat-model-picker')).toContainText('OpenRouter');

    const contextBar = app.window.getByTestId('chat-context-bar');
    await expect(contextBar).toBeVisible();
    for (const paletteId of ['paper', 'sepia', 'moss', 'ocean', 'graphite', 'midnight'] as const) {
      await choosePalette(app.window, paletteId);
      await expect(contextBar).toBeVisible();
      const paletteBounds = await contextBar.boundingBox();
      expect(paletteBounds).not.toBeNull();
    }
    await app.window.emulateMedia({ forcedColors: 'active' });
    const forcedColorState = await contextBar.evaluate((element) => {
      const styles = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        color: styles.color,
        borderColor: styles.borderColor,
        right: bounds.right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(forcedColorState.color).not.toBe('');
    expect(forcedColorState.borderColor).not.toBe('');
    expect(forcedColorState.right).toBeLessThanOrEqual(forcedColorState.viewportWidth + 1);
    await app.window.emulateMedia({ forcedColors: 'none' });
    await choosePalette(app.window, 'paper');
    await expect(contextBar).toContainText('0 items');
    // The summary line names the context and offers to add to it, and nothing
    // else: the context-window wheel it used to carry now sits beside Send,
    // where the decision it informs is actually made.
    const summary = contextBar.getByTestId('chat-context-summary');
    await expect(summary).toContainText('Context ·');
    await expect(summary).toContainText('0 items');
    await expect(summary.getByRole('button', { name: 'Add pages to AI context' })).toBeVisible();
    await expect(contextBar.getByTestId('chat-context-budget')).toHaveCount(0);

    const pagesTrigger = chat.getByRole('button', { name: 'Add pages to AI context' });
    await pagesTrigger.focus();
    await pagesTrigger.press('Enter');
    await expect(pagesTrigger).toHaveAttribute('aria-expanded', 'true');
    const popover = app.window.getByTestId('chat-pages-popover');
    await expect(popover).toBeVisible();
    await expect(app.window.getByLabel('Start page for context')).toBeFocused();

    await app.window.getByLabel('Start page for context').fill('2');
    await app.window.getByLabel('End page for context').fill('4');
    await app.window.getByLabel('End page for context').press('Enter');
    await expect(pagesTrigger).toBeFocused();
    await expect(contextBar.getByText('Pages 2–4')).toBeVisible();

    let sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), fixtureDocument!.id);
    const session = sessions[0];
    expect(session).toBeDefined();
    let contextItems = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listContext(sessionId), session!.id);
    expect(contextItems).toHaveLength(1);
    expect(contextItems[0]).toMatchObject({
      kind: 'range',
      displayLabel: 'Pages 2–4',
      sourceRef: { format: 'pdf', pageStart: 2, pageEnd: 4 },
    });

    const composer = chat.getByLabel('Message Reader AI');
    await composer.fill('Summarize the selected pages.');
    await composer.press('Enter');
    await expect.poll(async () => {
      sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), fixtureDocument!.id);
      const active = sessions[0];
      if (!active) return null;
      const messages = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listMessages(sessionId), active.id);
      return messages.find((message) => message.role === 'assistant')?.status ?? null;
    }).toBe('complete');

    // Once main has a packed request to report, the wheel appears — in the
    // composer, still not in this bar.
    const meter = chat.getByTestId('chat-context-budget');
    await expect(meter).toBeVisible();
    await expect(contextBar.getByTestId('chat-context-budget')).toHaveCount(0);
    expect(await meter.evaluate((element) => element.closest('form') !== null)).toBe(true);

    const db = new DatabaseSync(join(app.userDataDir, 'database', 'interleaf.sqlite'));
    try {
      const source = db.prepare(`
        SELECT cms.page_label AS page_label, cms.display_label AS display_label
          FROM chat_message_sources cms
          JOIN chat_messages cm ON cm.id = cms.message_id
         WHERE cm.session_id = ? AND cm.role = 'assistant'
         ORDER BY cms.ordinal ASC LIMIT 1
      `).get(session!.id) as { page_label: string; display_label: string } | undefined;
      expect(source).toMatchObject({ page_label: '2–4', display_label: 'Pages 2–4' });
    } finally {
      db.close();
    }

    // Attached context is a standing statement about this conversation, not a
    // per-turn payload: the chip outlives the turn that sent it and stays
    // removable, while the turn keeps its own source snapshots for citations.
    await expect(contextBar.getByText('Pages 2–4')).toBeVisible();
    contextItems = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listContext(sessionId), session!.id);
    expect(contextItems.map((item) => item.displayLabel)).toEqual(['Pages 2–4']);
    // The whole document is the one toggle in the row, never a second chip.
    await contextBar.getByRole('button', { name: 'Entire document' }).click();
    await expect(contextBar.getByRole('button', { name: 'Entire document' })).toHaveAttribute('aria-pressed', 'true');
    await expect(contextBar.getByRole('button', { name: /Remove Entire document/ })).toHaveCount(0);

    await pagesTrigger.click();
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: 'Close' }).click();
    await expect(pagesTrigger).toBeFocused();

    // Exercise the real supported narrow companion-panel layout at 100% with
    // many pinned ranges. The minimum supported BrowserWindow width clamps
    // this request to the normal panel layout; chips must wrap while
    // every remove control remains in the vertically scrollable,
    // keyboard-reachable list. The compact drawer is exercised below at 200%.
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.webContents.setZoomFactor(1.0);
      window.setSize(700, 900);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(920);
    const narrowZoomFactor = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor());
    expect(narrowZoomFactor).toBe(1);
    const narrowToggle = app.window.getByTestId('toggle-right-panel');
    await expandIfCollapsed(narrowToggle);
    const narrowChat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(narrowChat).toBeVisible();
    const narrowContextBar = narrowChat.getByTestId('chat-context-bar');
    for (let index = 0; index < 20; index += 1) {
      const narrowPagesTrigger = narrowChat.getByRole('button', { name: 'Add pages to AI context' });
      await narrowPagesTrigger.click();
      await app.window.getByLabel('Start page for context').fill('1');
      await app.window.getByLabel('End page for context').fill('1');
      await app.window.getByRole('button', { name: 'Add range' }).click();
      await expect(narrowPagesTrigger).toBeFocused();
    }
    // Every item stays listed as a wrapping chip; the count leads the row.
    await expect(narrowContextBar.getByTestId('chat-context-summary')).toContainText('Context · 22 items');
    const narrowMetrics = await app.window.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="chat-context-bar"]');
      const list = document.querySelector<HTMLElement>('[data-testid="chat-context-list"]');
      const companion = document.querySelector<HTMLElement>('[data-testid="companion-panel"]');
      const barRect = bar?.getBoundingClientRect();
      const listRect = list?.getBoundingClientRect();
      return {
        bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
        barHeight: barRect?.height ?? 0,
        barRight: barRect?.right ?? 0,
        barScrollHeight: bar?.scrollHeight ?? 0,
        listScrollHeight: list?.scrollHeight ?? 0,
        listClientHeight: list?.clientHeight ?? 0,
        listRight: listRect?.right ?? 0,
        companionRight: companion?.getBoundingClientRect().right ?? window.innerWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(narrowMetrics.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(narrowMetrics.barHeight).toBeGreaterThan(40);
    expect(narrowMetrics.barScrollHeight).toBeLessThanOrEqual(narrowMetrics.barHeight + 1);
    expect(narrowMetrics.listClientHeight).toBeGreaterThan(0);
    expect(narrowMetrics.barRight).toBeLessThanOrEqual(narrowMetrics.companionRight + 1);
    expect(narrowMetrics.listRight).toBeLessThanOrEqual(narrowMetrics.companionRight + 1);
    expect(await narrowContextBar.getAttribute('data-context-layout')).toBe('wrapping-chips');
    const narrowRemoveControls = narrowContextBar.getByRole('button', { name: /Remove Page 1 from AI context/ });
    expect(await narrowRemoveControls.count()).toBe(20);
    await narrowRemoveControls.last().focus();
    await expect(narrowRemoveControls.last()).toBeFocused();

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(1400, 900);
      window.webContents.setZoomFactor(2.0);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeLessThan(920);
    const zoomFactor = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor());
    expect(zoomFactor).toBe(2);

    const rightToggle = app.window.getByTestId('toggle-right-panel');
    if (await rightToggle.isVisible()) await rightToggle.click();
    const compactDrawer = app.window.getByTestId('compact-drawer-right');
    const zoomedChat = (await compactDrawer.count()) > 0 && await compactDrawer.isVisible()
      ? compactDrawer.getByRole('region', { name: 'AI research chat' })
      : chat;
    await expect(zoomedChat.getByTestId('chat-context-bar')).toBeVisible();
    expect(await zoomedChat.getByRole('button', { name: /Remove Page 1 from AI context/ }).count()).toBe(20);
    await zoomedChat.getByRole('button', { name: 'Add pages to AI context' }).click();
    await expect(popover).toBeVisible();

    const containment = await app.window.evaluate(() => {
      const chatBar = document.querySelector<HTMLElement>('[data-testid="chat-context-bar"]');
      const popover = document.querySelector<HTMLElement>('[data-testid="chat-pages-popover"]');
      const drawer = document.querySelector<HTMLElement>('[data-testid="compact-drawer-right"]');
      return {
        bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
        barOverflowX: chatBar ? chatBar.scrollWidth - chatBar.clientWidth : null,
        barRight: chatBar?.getBoundingClientRect().right ?? null,
        popoverRight: popover?.getBoundingClientRect().right ?? null,
        windowWidth: window.innerWidth,
        drawerRight: drawer?.getBoundingClientRect().right ?? null,
      };
    });
    expect(containment.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(containment.barOverflowX).toBeLessThanOrEqual(1);
    expect(containment.drawerRight ?? containment.windowWidth).toBeLessThanOrEqual(containment.windowWidth + 1);
    const rightBoundary: number = containment.drawerRight ?? containment.windowWidth;
    expect(Number(containment.barRight)).toBeLessThanOrEqual(rightBoundary + 1);
    expect(Number(containment.popoverRight)).toBeLessThanOrEqual(rightBoundary + 1);
    // The compact drawer was exercised above. Give the genuine BrowserWindow
    // enough CSS width for the normal companion panel to remain fully visible
    // at 200%.
    await popover.getByRole('button', { name: 'Close' }).click();
    await app.window.getByTestId('close-compact-drawer').click();
    await expect(compactDrawer).toBeHidden();
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.setSize(2400, 1200);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(920);
    const desktopToggle = app.window.getByTestId('toggle-right-panel');
    // The BrowserWindow resize event updates compactPresentation in a React
    // effect. Wait for the header's production desktop contract before
    // clicking, otherwise a fast parallel run can click the still-mounted
    // compact drawer toggle and leave the desktop companion panel closed.
    await expect(desktopToggle).toHaveAttribute('aria-controls', 'companion-panel');
    await expandIfCollapsed(desktopToggle);
    await expect(app.window.getByTestId('companion-panel')).toBeVisible();
    // Re-select the real Chat tab after leaving the compact drawer. This keeps
    // the desktop step independent of whichever companion tab a prior drawer
    // lifecycle restored, while still exercising the production tab control.
    await app.window.getByRole('tab', { name: 'AI Chat' }).click();
    const desktopChat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(desktopChat).toBeVisible();
    await desktopChat.getByRole('button', { name: 'Add pages to AI context' }).click();
    await expect(popover).toBeVisible();
    const desktopContainment = await app.window.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="chat-context-bar"]');
      const popover = document.querySelector<HTMLElement>('[data-testid="chat-pages-popover"]');
      return {
        bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
        barRight: bar?.getBoundingClientRect().right ?? 0,
        popoverRight: popover?.getBoundingClientRect().right ?? 0,
        viewportWidth: window.innerWidth,
      };
    });
    expect(desktopContainment.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(desktopContainment.barRight).toBeLessThanOrEqual(desktopContainment.viewportWidth + 1);
    expect(desktopContainment.popoverRight).toBeLessThanOrEqual(desktopContainment.viewportWidth + 1);
    await popover.getByRole('button', { name: 'Close' }).click();
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('Main BrowserWindow was not found.');
      window.webContents.setZoomFactor(1.0);
      window.setSize(1400, 900);
    });
    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    const [reopened] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(reopened?.id).toBe(fixtureDocument!.id);
    await app.window.getByTestId(`read-doc-${fixtureDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    const restartedRightToggle = app.window.getByTestId('toggle-right-panel');
    if (await restartedRightToggle.isVisible() && (await restartedRightToggle.getAttribute('aria-pressed')) !== 'true') {
      await restartedRightToggle.click();
    }
    await app.window.getByRole('tab', { name: 'Chat' }).click();
    const restartedChat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(restartedChat.getByTestId('chat-context-list').getByText('Entire document')).toBeVisible();
    contextItems = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listContext(sessionId), session!.id);
    expect(contextItems.some((item) => item.kind === 'entire_document')).toBe(true);
  });
});
