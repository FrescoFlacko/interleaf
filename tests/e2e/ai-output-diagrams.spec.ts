import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseChatModel, configureOpenRouterTestSeam, launchInterleaf, selectFakeAgentForTest, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

/** A reply with two drawable fences, one broken fence, and an ordinary code block. */
const ANSWER = [
  '### Import pipeline',
  '',
  'The excerpt describes this flow [src-1]:',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[Import document] --> B{Parse ok?}',
  '  B -->|Yes| C[Index passages]',
  '  B -->|No| D[Show error]',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  participant U as User',
  '  participant AI as Reader AI',
  '  U->>AI: Question',
  '  AI-->>U: Grounded answer',
  '```',
  '',
  '```mermaid',
  'flowchart TD',
  '  A -->',
  '```',
  '',
  '```ts',
  'const answer = 42;',
  '```',
].join('\n');

async function openFixtureDocument(app: AppHandle, dir: string): Promise<void> {
  const pdfPath = join(dir, 'Diagram_Fixture.pdf');
  writeFileSync(pdfPath, makePdfFixture({ title: 'Diagram Fixture', author: 'Interleaf', pageLines: [['A deterministic passage about an import pipeline.']] }));
  await stubOpenDialog(app, [pdfPath]);
  await app.window.getByTestId('import-files-button').click();
  await expect(app.window.getByTestId('success-banner')).toBeVisible();
  const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
  expect(document).toBeDefined();
  await app.window.getByTestId(`read-doc-${document!.id}`).click();
  await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
}

/**
 * Opens the fixture document and sends `prompt` in a new chat. That prompt is
 * answered with `answer`; anything else still reaches the deterministic seam
 * and, behind it, the network guard. Returns the assistant reply.
 */
async function askForChatReply(app: AppHandle, dir: string, prompt: string, answer: string): Promise<Locator> {
  await configureOpenRouterTestSeam(app);
  await app.electronApp.evaluate((_electron, reply) => {
    const seam = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? init.body : '';
      if (!url.includes('/api/v1/chat/completions') || !body.includes(reply.prompt)) return seam(input, init);
      const stream = `data: {"choices":[{"delta":{"content":${JSON.stringify(reply.answer)}}}]}\n\ndata: [DONE]\n\n`;
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  }, { prompt, answer });
  await openFixtureDocument(app, dir);

  await app.window.getByRole('tab', { name: 'Chat' }).click();
  await app.window.getByRole('button', { name: 'New chat' }).click();
  await chooseChatModel(app.window, 'openrouter', 'openrouter/auto');
  const composer = app.window.getByLabel('Message Reader AI');
  await composer.fill(prompt);
  await composer.press('Enter');
  return app.window.getByRole('article').filter({ hasText: 'Reader AI' });
}

/** How each node label sits in its box, measured by Chromium in the image's own SVG document. */
type LabelFit = {
  readonly fontSize: string;
  readonly labels: readonly { readonly text: { left: number; right: number }; readonly box: { left: number; right: number } }[];
  readonly drawing: { readonly left: number; readonly right: number };
};

/** Loads a drawing's `data:` URL as its own document in a hidden, sandboxed window and measures its labels. */
async function measureLabelFit(app: AppHandle, src: string): Promise<LabelFit> {
  return app.electronApp.evaluate(async ({ BrowserWindow }, url) => {
    const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } });
    try {
      await probe.loadURL(url);
      return (await probe.webContents.executeJavaScript(`(() => {
        const span = (rect) => ({ left: rect.left, right: rect.right });
        const labels = [...document.querySelectorAll('.pele-node')].map((node) => ({
          text: span(node.querySelector('text').getBoundingClientRect()),
          box: span(node.querySelector('rect').getBoundingClientRect()),
        }));
        return {
          fontSize: getComputedStyle(document.querySelector('.pele-node text')).fontSize,
          labels,
          drawing: span(document.documentElement.getBoundingClientRect()),
        };
      })()`)) as LabelFit;
    } finally {
      probe.destroy();
    }
  }, src);
}

/** Records every request the renderer makes to the network; app protocols and data URLs stay local. */
function recordRemoteRequests(page: Page): string[] {
  const remote: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/^(?:https?|wss?|ftp):/u.test(url)) remote.push(url);
  });
  return remote;
}

/** The drawing decoded in the real renderer, and holds no active markup. */
async function expectInertDrawing(diagram: Locator, label: string): Promise<void> {
  const image = diagram.getByRole('img', { name: label });
  await expect(image).toBeVisible();
  const drawing = await image.evaluate((node: HTMLImageElement) => {
    const svg = new TextDecoder().decode(Uint8Array.from(atob(node.src.split(',')[1] ?? ''), (char) => char.charCodeAt(0)));
    return { decoded: node.complete && node.naturalWidth > 0, prefix: node.src.slice(0, 26), svg };
  });
  expect(drawing.decoded).toBe(true);
  expect(drawing.prefix).toBe('data:image/svg+xml;base64,');
  expect(drawing.svg.replaceAll('http://www.w3.org/2000/svg', '')).not.toMatch(/<script|<foreignObject|<image|href=|\son[a-z]+=|https?:/iu);
}

test.describe('AI output diagrams', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('draws Mermaid fences in a chat reply locally and keeps their source', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-diagrams-'));
    app = await launchInterleaf();
    const remote = recordRemoteRequests(app.window);
    const reply = await askForChatReply(app, fixtureDir, 'Draw the pipeline.', ANSWER);
    await expect(reply.getByTestId('markdown-diagram')).toHaveCount(2, { timeout: 20_000 });
    await expectInertDrawing(reply.getByTestId('markdown-diagram').nth(0), 'Flowchart diagram');
    await expectInertDrawing(reply.getByTestId('markdown-diagram').nth(1), 'Sequence diagram');

    const fallback = reply.getByTestId('markdown-diagram-fallback');
    await expect(fallback).toHaveAttribute('data-diagram-failure', 'invalid');
    await expect(fallback.getByRole('note')).toHaveText("This diagram couldn't be read; showing its source.");
    await expect(fallback.locator('code')).toHaveText('flowchart TD\n  A -->');
    await expect(reply.getByTestId('markdown-code-language').filter({ hasText: 'ts' })).toBeVisible();

    const toggle = reply.getByTestId('markdown-diagram-source-toggle').first();
    await toggle.focus();
    await app.window.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(reply.getByTestId('markdown-diagram').first().locator('code')).toContainText('A[Import document] --> B{Parse ok?}');

    const sessions = await app.window.evaluate(async () => {
      const [document] = await window.interleafAPI.library.listDocuments();
      return window.interleafAPI.chat.listSessions(document!.id);
    });
    const messages = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listMessages(sessionId), sessions[0]!.id);
    expect(messages.some((message) => message.content.includes('```mermaid\nsequenceDiagram'))).toBe(true);
    expect(remote).toEqual([]);
  });

  test('paints a long label in the size it was measured in, inside its box', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-chat-diagram-fit-'));
    app = await launchInterleaf();
    const reply = await askForChatReply(app, fixtureDir, 'Draw the wide label.', `\`\`\`mermaid\nflowchart LR\n A[${'W'.repeat(40)}] --> B\n\`\`\``);
    const image = reply.getByTestId('markdown-diagram').getByRole('img', { name: 'Flowchart diagram' });
    await expect(image).toBeVisible({ timeout: 20_000 });

    const fit = await measureLabelFit(app, (await image.getAttribute('src')) ?? '');
    expect(fit.fontSize).toBe('14px');
    expect(fit.labels).toHaveLength(2);
    for (const { text, box } of fit.labels) {
      expect(text.left).toBeGreaterThanOrEqual(box.left);
      expect(text.right).toBeLessThanOrEqual(box.right);
      expect(text.left).toBeGreaterThanOrEqual(fit.drawing.left);
      expect(text.right).toBeLessThanOrEqual(fit.drawing.right);
    }
  });

  test('draws Mermaid fences in an agent report and in its activity', async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-agent-diagrams-'));
    app = await launchInterleaf({ testSeam: true });
    const remote = recordRemoteRequests(app.window);
    await openFixtureDocument(app, fixtureDir);

    await app.window.getByRole('tab', { name: 'Agent', exact: true }).click();
    await expect(app.window.getByLabel('Task description')).toBeVisible();
    await selectFakeAgentForTest(app);
    await stubOpenDialog(app, [fixtureDir]);
    await app.window.getByRole('button', { name: 'Choose…' }).click();
    await app.window.getByLabel('Task description').fill('Summarise the excerpt. e2e-pele-diagrams');
    await app.window.getByTestId('agent-start-button').click();
    await expect(app.window.getByTestId('agent-session-status')).toHaveText('Session completed.', { timeout: 30_000 });

    const report = app.window.getByTestId('agent-final-report');
    await expectInertDrawing(report.getByTestId('markdown-diagram'), 'Sequence diagram');
    await expect(report.getByTestId('markdown-code-language')).toHaveText('text');

    const activity = app.window.locator('[data-testid^="activity-message-"]').first();
    await expectInertDrawing(activity.getByTestId('markdown-diagram'), 'Flowchart diagram');
    expect(remote).toEqual([]);
  });
});
