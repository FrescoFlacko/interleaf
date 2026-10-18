import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makePdfFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue, listboxOptionLabels } from './listbox';
import { OPENROUTER_FIXTURE_CATALOG } from './main-network-guard';

const catalogResponse = OPENROUTER_FIXTURE_CATALOG;

test.describe('Defect 10: OpenRouter model catalog settings', () => {
  let app: AppHandle;
  let fixtureDir: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-openrouter-catalog-'));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('loads the official catalog without a key, commits key/model atomically, and stays contained at 200%', async () => {
    const pdfPath = join(fixtureDir, 'OpenRouter_Catalog_Fixture.pdf');
    writeFileSync(pdfPath, makePdfFixture({
      title: 'OpenRouter Catalog Fixture',
      author: 'Interleaf',
      pageLines: [['A deterministic passage for OpenRouter settings evidence.']],
    }));

    await stubOpenDialog(app, [pdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [openedDocument] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    expect(openedDocument).toBeDefined();
    await app.window.getByTestId(`read-doc-${openedDocument!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();

    await app.electronApp.evaluate((_, response) => {
      const globalStore = globalThis as {
        __openRouterCatalogRequests?: { readonly authorization: string | null; readonly title: string | null }[];
      };
      globalStore.__openRouterCatalogRequests = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith('/api/v1/models')) return originalFetch(input, init);
        const headers = new Headers(init?.headers);
        globalStore.__openRouterCatalogRequests?.push({
          authorization: headers.get('authorization'),
          title: headers.get('x-title'),
        });
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    }, catalogResponse);

    await app.window.getByTestId('open-settings').click();
    const modal = app.window.getByTestId('ai-providers-settings-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('openrouter-model-select')).toBeVisible();

    // The catalog is fetched over the network, so the picker offers only the
    // built-in Auto entry until the response lands. The fetched entries
    // appearing in the picker is that readiness boundary; everything below is
    // asserted against the loaded catalog rather than the fallback.
    const modelSelect = modal.getByTestId('openrouter-model-select');
    await expect.poll(() => listboxOptionLabels(modelSelect)).toEqual(
      expect.arrayContaining(['Anthropic: Claude 3.5 Sonnet', 'OpenAI: GPT-4o']),
    );

    // Auto remains the default selection — named in the picker, with its
    // identifier, window and honestly unavailable pricing on the metadata line
    // beneath the select rather than crammed into every option.
    const details = modal.getByTestId('openrouter-model-details');
    await expect(modal.getByTestId('openrouter-model-select')).toHaveAttribute('data-value', 'openrouter/auto');
    await expect(modelSelect).toHaveText('OpenRouter Auto');
    await expect(details).toContainText('openrouter/auto');
    await expect(details).toContainText('128k context');
    await expect(details).toContainText('Pricing unavailable');
    await expect(modal).not.toContainText('sk-or-v1-catalog-e2e-key');

    await modal.getByTestId('openrouter-key-input').fill('sk-or-v1-catalog-e2e-key');
    await chooseListboxValue(modal.getByTestId('openrouter-model-select'), 'anthropic/claude-3.5-sonnet');
    // The catalog's own figures for the chosen model, from the same line.
    await expect(details).toContainText('anthropic/claude-3.5-sonnet');
    await expect(details).toContainText('200k context');
    await expect(details).toContainText('input $3.00/M');
    await expect(details).toContainText('output $15.00/M');
    await modal.getByRole('button', { name: 'Done' }).click();
    await expect(modal).toBeHidden();

    await expect.poll(async () => (await app.window.evaluate(async () => window.interleafAPI.credentials.getOpenRouterStatus())).configured).toBe(true);
    await expect.poll(async () => (await app.window.evaluate(async () => (await window.interleafAPI.settings.get()).ai.openRouterModel))).toBe('anthropic/claude-3.5-sonnet');
    const requests = await app.electronApp.evaluate(() => {
      const globalStore = globalThis as {
        __openRouterCatalogRequests?: { readonly authorization: string | null; readonly title: string | null }[];
      };
      return globalStore.__openRouterCatalogRequests ?? [];
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.authorization === null)).toBe(true);
    expect(requests.every((request) => request.title === 'Interleaf')).toBe(true);

    // Removal is immediate and main-owned: one click clears the credential
    // while the modal stays open, and the selected model is retained.
    await app.window.getByTestId('open-settings').click();
    const removalModal = app.window.getByTestId('ai-providers-settings-modal');
    await expect(removalModal.getByTestId('remove-openrouter-key-button')).toBeVisible();
    await removalModal.getByTestId('remove-openrouter-key-button').click();
    await expect(removalModal.getByTestId('openrouter-key-preview')).toHaveCount(0);
    await expect(removalModal).toBeVisible();
    await expect.poll(async () => (await app.window.evaluate(async () => window.interleafAPI.credentials.getOpenRouterStatus())).configured).toBe(false);
    await removalModal.getByRole('button', { name: 'Close settings' }).click();
    await expect(removalModal).toBeHidden();
    await expect.poll(async () => (await app.window.evaluate(async () => (await window.interleafAPI.settings.get()).ai.openRouterModel))).toBe('anthropic/claude-3.5-sonnet');

    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const browserWindow = BrowserWindow.getAllWindows()[0];
      if (!browserWindow) throw new Error('Main BrowserWindow was not found.');
      browserWindow.setSize(960, 640);
      browserWindow.webContents.setZoomFactor(2.0);
    });
    await expect.poll(async () => app.window.evaluate(() => window.innerWidth)).toBeLessThan(920);
    expect(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(2);
    await app.window.getByTestId('open-settings').click();
    const zoomModal = app.window.getByTestId('ai-providers-settings-modal');
    await expect(zoomModal).toBeVisible();
    await expect(zoomModal.getByTestId('openrouter-model-select')).toBeVisible();
    await expect(zoomModal.getByText('Not Configured')).toBeVisible();
    const settingsNav = zoomModal.getByRole('navigation', { name: 'Settings sections' });
    await settingsNav.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await zoomModal.getByRole('button', { name: 'AI Providers' }).click();
    await zoomModal.getByTestId('openrouter-model-select').evaluate((element) => {
      const content = element.closest<HTMLElement>('[data-testid="settings-content"]');
      if (content) {
        const contentRect = content.getBoundingClientRect();
        const modelRect = element.getBoundingClientRect();
        // Keep both the select and its pricing/details line inside the compact
        // content viewport; the footer remains reachable via normal scroll.
        content.scrollTop += modelRect.top - contentRect.top - 8;
      }
    });
    await expect(zoomModal.getByTestId('openrouter-model-details')).toBeVisible();
    await expect(zoomModal.getByRole('button', { name: 'Done' })).toBeVisible();
    const containment = await app.window.evaluate(() => {
      const appShell = document.querySelector<HTMLElement>('[data-testid="app-shell"]');
      const dialog = document.querySelector<HTMLElement>('[data-testid="ai-providers-settings-modal"]');
      const content = document.querySelector<HTMLElement>('[data-testid="settings-content"]');
      const dialogRect = dialog?.getBoundingClientRect();
      const contentRect = content?.getBoundingClientRect();
      const model = document.querySelector<HTMLElement>('[data-testid="openrouter-model-select"]');
      const modelRect = model?.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight,
        appOverflowX: appShell ? appShell.scrollWidth - appShell.clientWidth : null,
        dialogOverflowX: dialog ? dialog.scrollWidth - dialog.clientWidth : null,
        contentOverflowX: content ? content.scrollWidth - content.clientWidth : null,
        dialogLeft: dialogRect?.left ?? null,
        dialogRight: dialogRect?.right ?? null,
        dialogBottom: dialogRect?.bottom ?? null,
        contentRight: contentRect?.right ?? null,
        contentTop: contentRect?.top ?? null,
        contentBottom: contentRect?.bottom ?? null,
        contentHeight: contentRect?.height ?? null,
        contentScrollTop: content?.scrollTop ?? null,
        modelTop: modelRect?.top ?? null,
        modelBottom: modelRect?.bottom ?? null,
        modelIntersectsViewport: modelRect !== undefined && contentRect !== undefined && modelRect.top >= contentRect.top - 1 && modelRect.bottom <= contentRect.bottom + 1,
        detailsIntersectsViewport: (() => {
          const details = document.querySelector<HTMLElement>('[data-testid="openrouter-model-details"]');
          const rect = details?.getBoundingClientRect();
          return rect !== undefined && contentRect !== undefined && rect.top >= contentRect.top - 1 && rect.bottom <= contentRect.bottom + 1;
        })(),
        secretPresent: document.body.textContent.includes('sk-or-v1-catalog-e2e-key'),
      };
    });
    expect(containment.bodyScrollWidth).toBeLessThanOrEqual(containment.innerWidth + 1);
    expect(containment.bodyScrollHeight).toBeLessThanOrEqual(containment.innerHeight + 1);
    expect(containment.appOverflowX).toBeLessThanOrEqual(1);
    expect(containment.dialogOverflowX).toBeLessThanOrEqual(1);
    expect(containment.contentOverflowX).toBeLessThanOrEqual(1);
    expect(containment.dialogLeft).toBeGreaterThanOrEqual(-1);
    expect(containment.dialogRight).toBeLessThanOrEqual(containment.innerWidth + 1);
    expect(containment.dialogBottom).toBeLessThanOrEqual(containment.innerHeight + 1);
    expect(containment.contentRight).toBeLessThanOrEqual(containment.dialogRight! + 1);
    expect(containment.modelIntersectsViewport).toBe(true);
    expect(containment.detailsIntersectsViewport).toBe(true);
    expect(containment.secretPresent).toBe(false);
  });
});
