import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, configureOpenRouterTestSeam, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';

test.describe('Secure Native Clipboard Writing', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-clipboard-e2e-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('copies reader selection to native Electron clipboard and produces no clipboard permission denials', async () => {
    const mdPath = join(fixtureDir, 'Clipboard_Reader.md');
    const selectedPhrase = 'Secure native clipboard text copy in Interleaf reader.';
    writeFileSync(mdPath, `# Clipboard Document\n\n${selectedPhrase}`);

    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [doc] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(doc).toBeDefined();

    await app.window.getByTestId(`read-doc-${doc!.id}`).click();
    await expect(app.window.getByTestId('markdown-scroll-container')).toBeVisible();

    // Ensure native clipboard is clean before triggering UI copy
    await app.electronApp.evaluate(({ clipboard }) => { clipboard.clear(); });
    expect(await app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('');

    // Trigger DOM selection in the reader
    await app.window.evaluate(() => {
      const block = document.querySelector('[data-markdown-block="1"]');
      if (!block) return;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode();
      if (!textNode) return;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();

    const copyBtn = toolbar.getByRole('button', { name: 'Copy' });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Verify UI reflects "Copied" status
    await expect(toolbar.getByRole('status')).toHaveText('Copied');

    // Verify native Electron clipboard holds the exact selection
    await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(selectedPhrase);

    // Verify durable logs contain no Chromium clipboard permission denials
    const logDir = join(app.userDataDir, 'logs');
    if (existsSync(logDir)) {
      const files = readdirSync(logDir);
      for (const file of files) {
        const content = readFileSync(join(logDir, file), 'utf8');
        expect(content).not.toContain('clipboard-sanitized-write');
        expect(content).not.toContain('clipboard-read');
      }
    }
  });

  test('copies Markdown code block to native Electron clipboard in AI Chat without clipboard permission denials', async () => {
    await configureOpenRouterTestSeam(app);

    const mdPath = join(fixtureDir, 'Code_Snippet.md');
    writeFileSync(mdPath, '# Code Sample\n\nA document with code snippets.');

    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [doc] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(doc).toBeDefined();

    await app.window.getByTestId(`read-doc-${doc!.id}`).click();
    await expect(app.window.getByTestId('markdown-scroll-container')).toBeVisible();

    await app.window.getByRole('tab', { name: 'Chat' }).click();
    await expect(app.window.getByRole('region', { name: 'AI research chat' })).toBeVisible();
    await app.window.getByRole('button', { name: 'New chat' }).click();
    // Bind the session to the intercepted OpenRouter boundary: an installed
    // CLI provider would otherwise take the turn and fail outside the seam.
    await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
    await expect(app.window.getByTestId('chat-model-picker')).toContainText('OpenRouter');

    // Clear native clipboard
    await app.electronApp.evaluate(({ clipboard }) => { clipboard.clear(); });
    expect(await app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe('');

    // Send a prompt requesting code
    const composer = app.window.getByLabel('Message Reader AI');
    await composer.fill('Show me a TypeScript code example.');
    await composer.press('Enter');

    // Wait for the assistant message containing a code block
    await expect.poll(async () => {
      const sessions = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), doc!.id);
      const session = sessions[0];
      if (!session) return 0;
      return (await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listMessages(sessionId), session.id))
        .filter((message) => message.status === 'complete').length;
    }, { timeout: 10_000 }).toBe(2);

    const codeElement = app.window.locator('pre code').first();
    await expect(codeElement).toBeVisible();
    const expectedCodeText = (await codeElement.textContent()) ?? '';
    expect(expectedCodeText.length).toBeGreaterThan(0);

    // A successful copy renames the control ("Code copied to the clipboard"),
    // so assert the state through the name-independent test id: the press
    // flips data-copy-state to copied and shows "Copied" for its reset window.
    const copyCodeBtn = app.window.getByTestId('markdown-copy-code');
    await expect(copyCodeBtn).toBeVisible();
    await copyCodeBtn.click();
    await expect(copyCodeBtn).toHaveAttribute('data-copy-state', 'copied');
    await expect(copyCodeBtn).toHaveText('Copied');

    // Verify native Electron clipboard holds the exact derived code snippet
    await expect.poll(() => app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(expectedCodeText);
    // Verify durable logs contain no Chromium clipboard permission denials
    const logDir = join(app.userDataDir, 'logs');
    if (existsSync(logDir)) {
      const files = readdirSync(logDir);
      for (const file of files) {
        const content = readFileSync(join(logDir, file), 'utf8');
        expect(content).not.toContain('clipboard-sanitized-write');
        expect(content).not.toContain('clipboard-read');
      }
    }
  });
});
