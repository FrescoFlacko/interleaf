import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureOpenRouterTestSeam, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';

test.describe('Defect 23: TOC section context menu', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-defect-23-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function openFixture(): Promise<string> {
    const pdfPath = join(fixtureDir, 'TOC_Context_Menu.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'TOC Context Menu Fixture',
      pages: Array.from({ length: 6 }, (_, index) => `Section page ${String(index + 1)}. Context text for section range verification.`),
      outline: [
        { title: 'Chapter 1: Foundations', targetPage: 1 },
        { title: 'Chapter 2: Data Models', targetPage: 4 },
        { title: 'Chapter 3: Storage', targetPage: 6 },
      ],
    }));
    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(document).toBeDefined();
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await configureOpenRouterTestSeam(app);
    const [reloaded] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(reloaded).toBeDefined();
    await app.window.getByTestId(`read-doc-${reloaded!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await app.window.getByTestId('toggle-toc-button').click();
    await expect(app.window.getByTestId('reader-outline-sidebar')).toBeVisible();
    return reloaded!.id;
  }

  test('right-click adds the derived inclusive range to Chat and keeps the menu contained', async () => {
    const documentId = await openFixture();
    const sidebar = app.window.getByTestId('reader-outline-sidebar');
    const row = sidebar.getByRole('button', { name: 'Go to Chapter 1: Foundations' });
    await row.click({ button: 'right', position: { x: 6, y: 6 } });
    const menu = app.window.getByRole('menu', { name: 'Actions for Chapter 1: Foundations' });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    const viewport = await app.window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    await menu.getByRole('menuitem', { name: 'Add section to Chat' }).click();

    const chat = app.window.getByRole('region', { name: 'AI research chat' });
    await expect(chat).toBeVisible();
    await expect(chat.getByTestId('chat-context-summary')).toContainText('Pages 1–3');
    const [session] = await app.window.evaluate(async (documentId) => window.interleafAPI.chat.listSessions(documentId), documentId);
    expect(session).toBeDefined();
    const contextItems = await app.window.evaluate(async (sessionId) => window.interleafAPI.chat.listContext(sessionId), session!.id);
    expect(contextItems).toEqual([expect.objectContaining({
      kind: 'range',
      displayLabel: 'Pages 1–3',
      sourceRef: { format: 'pdf', pageStart: 1, pageEnd: 3 },
    })]);
    await expect(app.window.getByRole('menu')).toHaveCount(0);
  });

  test('keyboard Shift+F10 adds the final derived range to Agent and returns focus after Escape', async () => {
    await openFixture();
    const sidebar = app.window.getByTestId('reader-outline-sidebar');
    const row = sidebar.getByRole('button', { name: 'Go to Chapter 3: Storage' });
    await row.focus();
    await row.press('Shift+F10');
    const menu = app.window.getByRole('menu', { name: 'Actions for Chapter 3: Storage' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Add section to Agent' }).click();
    const agent = app.window.getByRole('tabpanel', { name: 'Agent' });
    await expect(agent).toBeVisible();
    await expect(agent.getByTestId('agent-context-range')).toHaveText('Page 6');
    await expect(app.window.getByRole('menu')).toHaveCount(0);

    const secondRow = sidebar.getByRole('button', { name: 'Go to Chapter 2: Data Models' });
    await secondRow.focus();
    await secondRow.press('Shift+F10');
    await expect(app.window.getByRole('menu')).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByRole('menu')).toHaveCount(0);
    await expect(secondRow).toBeFocused();
  });
});
