import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { IpcMainInvokeEvent } from 'electron';
import type { CloneableValue } from '@shared/models/portable';
import { createChatCliFixture, type ChatCliFixture } from './chat-cli-fixture';
import { chooseChatModel, configureOpenRouterTestSeam, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

test.describe('Reader selection to Chat planning and bounded limits', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-selection-chat-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('attaches genuine multi-page selection across pages 1 and 2 to Chat, resolves discrete per-page citations, and reflows at 200% zoom', async () => {
    await configureOpenRouterTestSeam(app);

    const pdfPath = join(fixtureDir, 'Selection_Chat_MultiPage.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Selection Chat MultiPage PDF',
      author: 'Interleaf Architecture',
      pageLines: [
        ['Distributed Consensus Invariants: State machine replication across fault domains.'],
        ['Detailed architecture text on page 2 explaining atomic broadcast and leader election.'],
      ],
      pageStartPositions: [
        [72, 80],
        [72, 740],
      ],
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [pdfDoc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(pdfDoc).toBeDefined();

    await app.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p2')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status,
    pdfDoc!.id)).toBe('ready');

    // Scroll to the page boundary between Page 1 and Page 2
    await app.window.evaluate(() => {
      const container = document.querySelector('[data-testid="pdf-scroll-container"]');
      const p1 = document.querySelector('[data-page-number="1"]');
      if (container && p1) {
        const p1Bottom = (p1 as HTMLElement).offsetTop + (p1 as HTMLElement).offsetHeight;
        container.scrollTop = p1Bottom - container.clientHeight / 2;
      }
    });
    await app.window.waitForTimeout(400);

    // Select text across Page 1 and Page 2
    const selectedText = await app.window.evaluate(() => {
      const layer1 = document.querySelector('[data-testid="pdf-textlayer-p1"]');
      const layer2 = document.querySelector('[data-testid="pdf-textlayer-p2"]');
      if (!layer1 || !layer2) throw new Error('Text layers not found');

      let startNode: Node | null = null;
      const w1 = document.createTreeWalker(layer1, NodeFilter.SHOW_TEXT);
      for (let n = w1.nextNode(); n; n = w1.nextNode()) {
        if ((n.textContent ?? '').includes('Distributed Consensus')) {
          startNode = n;
          break;
        }
      }

      let endNode: Node | null = null;
      let endOffset = 0;
      const w2 = document.createTreeWalker(layer2, NodeFilter.SHOW_TEXT);
      for (let n = w2.nextNode(); n; n = w2.nextNode()) {
        if ((n.textContent ?? '').includes('Detailed architecture')) {
          endNode = n;
          endOffset = n.textContent!.length;
          break;
        }
      }
      if (!startNode || !endNode) throw new Error('Text nodes not found');
      const range = document.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, endOffset);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return sel?.toString() ?? '';
    });
    expect(selectedText.length).toBeGreaterThan(0);

    const selectionToolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(selectionToolbar).toBeVisible();

    await selectionToolbar.getByRole('button', { name: 'Ask AI' }).click();
    const chatTab = app.window.getByRole('tab', { name: 'Chat' });
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
    // Bind the session to the intercepted OpenRouter boundary: on a machine
    // with an authenticated CLI provider installed the fresh session takes
    // that provider, and the turn fails for a reason unrelated to selection.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(app.window.getByTestId('chat-model-picker')).toContainText('OpenRouter');
    const contextSummary = app.window.getByTestId('chat-context-summary');
    await expect(contextSummary).toBeVisible();
    await expect(contextSummary).toContainText(/Pages 1–2|Distributed Consensus/i);
    // Send chat message with the selection context
    const composer = app.window.locator('#chat-composer');
    await composer.fill('Explain this multi-page section architecture');
    await app.window.getByRole('button', { name: 'Send' }).click();

    // Verify response streams and cites discrete sources
    const assistantMessage = app.window.locator('[data-testid^="chat-message-"]').nth(1);
    await expect(assistantMessage).toBeVisible({ timeout: 15_000 });

    const messages = await app.window.evaluate(async (docId) => {
      const sessions = await window.interleafAPI.chat.listSessions(docId);
      if (sessions.length === 0) return [];
      return window.interleafAPI.chat.listMessages(sessions[0]!.id);
    }, pdfDoc!.id);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.citations).toHaveLength(2);
    expect(assistant?.citations.map((c) => c.pageLabel)).toEqual(['Page 1', 'Page 2']);
    const citationPills = assistantMessage.locator('button[title^="Jump to"]');
    await expect(citationPills).toHaveCount(2);
    await expect(citationPills.nth(0)).toContainText('p. 1');
    await expect(citationPills.nth(1)).toContainText('p. 2');
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(960, 640);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.setViewportSize({ width: 960, height: 640 });
    await app.window.waitForTimeout(400);

    const overflow200 = await app.window.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    }));
    expect(overflow200.bodyScrollWidth).toBeLessThanOrEqual(overflow200.bodyClientWidth + 2);
  });

  test('allows large selections beyond annotation span directly into Chat while enforcing action-specific limits on annotations', async () => {
    await configureOpenRouterTestSeam(app);

    const mdPath = join(fixtureDir, 'Large_Markdown_Chat.md');
    const longMd = Array.from({ length: 120 }, (_, index) => `Paragraph text for block ${String(index + 1)} describing distributed system architecture in detail.`).join('\n\n');
    writeFileSync(mdPath, longMd);

    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(doc).toBeDefined();

    await app.window.getByTestId(`read-doc-${doc!.id}`).click();
    await expect(app.window.getByTestId('markdown-scroll-container')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status,
    doc!.id)).toBe('ready');

    // Trigger a selection spanning 106 blocks (from block 0 to block 105, exceeding the 100-block annotation limit)
    await app.window.evaluate(() => {
      const b0 = document.querySelector('[data-markdown-block="0"]');
      const b105 = document.querySelector('[data-markdown-block="105"]');
      if (!b0 || !b105) return { error: 'Blocks not found', totalBlocks: document.querySelectorAll('[data-markdown-block]').length };

      const w0 = document.createTreeWalker(b0, NodeFilter.SHOW_TEXT);
      const startNode = w0.nextNode();
      const w105 = document.createTreeWalker(b105, NodeFilter.SHOW_TEXT);
      const endNode = w105.nextNode();
      if (!startNode || !endNode) return { error: 'Text nodes not found' };

      const range = document.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, (endNode.textContent ?? '').length);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    const selectionToolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(selectionToolbar).toBeVisible();

    // 2. Try to create highlight -> verifies action-specific limit is enforced
    const yellowBtn = selectionToolbar.getByRole('button', { name: 'Yellow highlight' });
    await yellowBtn.click();
    await expect(selectionToolbar.getByRole('alert')).toContainText(/100 blocks/i);
    // 3. Click "Ask AI" -> verifies Chat accepts the 106-block selection directly
    const askAiBtn = selectionToolbar.getByRole('button', { name: 'Ask AI' });
    await askAiBtn.click();

    const chatTab = app.window.getByRole('tab', { name: 'Chat' });
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
    // Bind the session to the intercepted OpenRouter boundary (see the first
    // test in this file): an installed CLI provider would otherwise win.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(app.window.getByTestId('chat-model-picker')).toContainText('OpenRouter');
    const contextSummary = app.window.getByTestId('chat-context-summary');
    await expect(contextSummary).toBeVisible();
    await expect(contextSummary).toContainText(/Blocks 1–106|Paragraph text for block 1/i);
    // 5. Send message with the selection context
    const composer = app.window.locator('#chat-composer');
    await composer.fill('Analyze this passage');
    await app.window.getByRole('button', { name: 'Send' }).click();

    // 6. Verify grounded response streams and completes
    await expect(app.window.locator('[data-testid^="chat-message-"]').nth(1)).toBeVisible({ timeout: 15_000 });
  });
  test('handles 51-page PDF selection with virtualized pages, rejects annotation with 50-page limit, and attaches Pages 1–51 to Chat with exact endpoint citations', async () => {
    await configureOpenRouterTestSeam(app);

    const pdfPath = join(fixtureDir, 'FiftyOnePage_Chat.pdf');
    const pageLines = Array.from({ length: 51 }, (_, i) => [
      `Page ${String(i + 1)} initial headline text for long range selection verification.`,
      `Detailed body paragraph on page ${String(i + 1)} discussing distributed systems and consensus.`,
    ]);
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Fifty One Page Verification Document',
      author: 'Interleaf Testing',
      pageLines,
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(doc).toBeDefined();

    await app.window.getByTestId(`read-doc-${doc!.id}`).click();
    await expect(app.window.getByTestId('pdf-scroll-container')).toBeVisible();
    await expect(app.window.getByTestId('pdf-page-1')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status,
    doc!.id)).toBe('ready');

    // 1. Create a real browser selection range from page 1 wrapper to page 51 wrapper
    await app.window.evaluate(() => {
      const p1 = document.querySelector('[data-page-number="1"]');
      const p51 = document.querySelector('[data-page-number="51"]');
      if (!p1 || !p51) throw new Error('Page wrappers not found');

      let startNode: Node | null = null;
      const w1 = document.createTreeWalker(p1, NodeFilter.SHOW_TEXT);
      for (let n = w1.nextNode(); n; n = w1.nextNode()) {
        if ((n.textContent ?? '').includes('Page 1')) {
          startNode = n;
          break;
        }
      }
      startNode ??= p1.firstChild ?? p1;

      const endNode: Node = p51.lastChild ?? p51;
      const range = document.createRange();
      range.setStart(startNode, 0);
      const endLen = endNode instanceof Text ? endNode.length : endNode.childNodes.length;
      range.setEnd(endNode, endLen);

      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    const selectionToolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(selectionToolbar).toBeVisible();

    // 2. Try to create highlight -> assert 50-page limit alert is displayed
    const yellowBtn = selectionToolbar.getByRole('button', { name: 'Yellow highlight' });
    await yellowBtn.click();
    await expect(selectionToolbar.getByRole('alert')).toContainText(/50 pages/i);

    // 3. Click "Ask AI" -> attaches selection context to Chat
    const askAiBtn = selectionToolbar.getByRole('button', { name: 'Ask AI' });
    await askAiBtn.click();

    // 4. Verify Chat panel opens and context pill displays "Pages 1–51"
    const chatTab = app.window.getByRole('tab', { name: 'Chat' });
    await expect(chatTab).toHaveAttribute('aria-selected', 'true');
    // Bind the session to the intercepted OpenRouter boundary (see the first
    // test in this file): an installed CLI provider would otherwise win.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(app.window.getByTestId('chat-model-picker')).toContainText('OpenRouter');
    const contextSummary = app.window.getByTestId('chat-context-summary');
    await expect(contextSummary).toBeVisible();
    await expect(contextSummary).toContainText(/Pages 1–51/i);

    // 5. Send message with 51-page prompt
    const composer = app.window.locator('#chat-composer');
    await composer.fill('Analyze 51 pages overview and conclusion');
    await app.window.getByRole('button', { name: 'Send' }).click();

    // 6. Verify assistant response streams and resolves discrete citations
    const assistantMessage = app.window.locator('[data-testid^="chat-message-"]').nth(1);
    await expect(assistantMessage).toBeVisible({ timeout: 20_000 });

    const messages = await app.window.evaluate(async (docId) => {
      const sessions = await window.interleafAPI.chat.listSessions(docId);
      if (sessions.length === 0) return [];
      return window.interleafAPI.chat.listMessages(sessions[0]!.id);
    }, doc!.id);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();

    // Assert that the assistant citations cover Page 1 and Page 51
    const pageLabels = assistant?.citations.map((c) => c.pageLabel) ?? [];
    expect(pageLabels).toContain('Page 1');
    expect(pageLabels).toContain('Page 51');

    // Assert visible citation pills
    const citationPills = assistantMessage.locator('button[title^="Jump to"]');
    await expect(citationPills.first()).toBeVisible();
    await expect(citationPills.first()).toContainText('p. 1');
    await expect(citationPills.last()).toContainText('p. 51');
  });
});

/**
 * The same reader gesture as above, on a machine that has another provider
 * ready — which is the machine the defect was reported on.
 *
 * Offline, OpenRouter is the only provider a session can bind to, so those
 * tests cannot tell a respected choice from a lucky one. Here a connected CLI
 * provider is present as a fixture and is what the app offers first, so a
 * dropped choice has somewhere to land: the session binds to the CLI, and the
 * turn is spawned from it. Both are asserted directly — the session's binding,
 * and the fixture's own record of every argv it was invoked with.
 */
test.describe('Reader selection to Chat provider routing under a slow session create', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let cli: ChatCliFixture;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-selection-chat-race-'));
    // Detection answers late, so the panel is on screen and interactive while
    // the app is still deciding which providers it has.
    cli = createChatCliFixture({ delayMs: 400 });
    app = await launchInterleaf({ binDir: cli.binDir });
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(cli.binDir, { recursive: true, force: true });
  });

  test('sends the turn through the provider the reader chose while the session was still being created', async () => {
    await configureOpenRouterTestSeam(app);

    const pdfPath = join(fixtureDir, 'Selection_Chat_Race.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'Selection Chat Provider Race',
      author: 'Interleaf Architecture',
      pageLines: [['Distributed Consensus Invariants: state machine replication across fault domains.']],
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [pdfDoc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(pdfDoc).toBeDefined();

    await app.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();

    // The rival is real: the CLI fixture detects as connected and is the
    // provider this machine offers first, so it is what an unbound new session
    // would silently take.
    const providerTrigger = app.window.getByTestId('chat-model-picker');
    await expect(providerTrigger).toContainText('ChatGPT');
    await expect(providerTrigger).not.toContainText('subscription');

    // The reader chooses OpenRouter with no conversation open.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(providerTrigger).toContainText('OpenRouter');

    // Creation is held open, so the choice and the conversation it applies to
    // overlap rather than happening in a convenient order.
    await delayInvokeHandler(app, 'chat:create-session', 750);

    // Ask AI creates that conversation from the reader, outside the chat panel.
    await app.window.evaluate(() => {
      const layer = document.querySelector('[data-testid="pdf-textlayer-p1"]');
      if (!layer) throw new Error('Text layer not found');
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!node) throw new Error('No text node in the page 1 text layer');
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, (node.textContent ?? '').length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    const selectionToolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(selectionToolbar).toBeVisible();
    await selectionToolbar.getByRole('button', { name: 'Ask AI' }).click();
    await expect(app.window.getByTestId('chat-context-summary')).toBeVisible();

    // What the reader is told, what was persisted, and what answers the turn
    // are one provider.
    await expect(providerTrigger).toContainText('OpenRouter');
    await expect.poll(async () => app.window.evaluate(async (documentId) => {
      const sessions = await window.interleafAPI.chat.listSessions(documentId);
      return sessions.map((session) => ({ providerId: session.providerId, modelId: session.modelId }));
    }, pdfDoc!.id)).toEqual([{ providerId: 'openrouter', modelId: 'openrouter/auto' }]);

    await app.window.locator('#chat-composer').fill('Explain this multi-page passage');
    await app.window.getByRole('button', { name: 'Send' }).click();
    const assistantMessage = app.window.locator('[data-testid^="chat-message-"]').nth(1);
    await expect(assistantMessage).toBeVisible({ timeout: 15_000 });
    // The seam's wording, so the answer is known to have come from the chosen
    // route rather than from anywhere else.
    await expect(assistantMessage).toContainText('leader election');

    // And the CLI was asked to identify itself, never to answer.
    expect(cli.chatInvocations()).toEqual([]);
  });
});

/**
 * Holds an IPC channel's handler open for `ms` before it runs.
 *
 * Test-side instrumentation of Electron's own invoke table, in the same spirit
 * as the `fetch` seam above: the application ships no delay control, and a race
 * that only reproduces on a slow machine is not evidence of anything on a fast
 * one.
 */
async function delayInvokeHandler(app: AppHandle, channel: string, ms: number): Promise<void> {
  await app.electronApp.evaluate(({ ipcMain }, options) => {
    type Handler = (event: IpcMainInvokeEvent, ...args: readonly CloneableValue[]) => Promise<CloneableValue> | CloneableValue;
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const original = handlers.get(options.channel);
    if (original === undefined) throw new Error(`No invoke handler is registered for ${options.channel}.`);
    handlers.set(options.channel, async (event, ...args) => {
      await new Promise((resolve) => setTimeout(resolve, options.ms));
      return await original(event, ...args);
    });
  }, { channel, ms });
}
