import { expect, test } from '@playwright/test';
import { launchInterleaf, returnToLibrary } from './helpers';
import { CHART_ARTICLE_URL, CHART_URLS, chartArticleHtml, chartMediaFixtures } from '../fixtures/editorial-charts-fixture';

test('twelve editorial charts archive and paint on an offline reopen', async () => {
  const app = await launchInterleaf({ testSeam: true });
  try {
    await app.electronApp.evaluate(({}, payload) => {
      const scope = globalThis as {
        __interleafWebArticleFixtures?: Record<string, { html: string; finalUrl: string }>;
      };
      scope.__interleafWebArticleFixtures = { [payload.url]: { html: payload.html, finalUrl: payload.url } };
      globalThis.__interleafWebMediaFixtures = payload.media;
    }, { url: CHART_ARTICLE_URL, html: chartArticleHtml(), media: chartMediaFixtures() });
    await app.window.getByTestId('import-options-button').click();
    await app.window.getByTestId('import-from-web-item').click();
    await app.window.getByTestId('web-article-url-input').fill(CHART_ARTICLE_URL);
    await app.window.getByTestId('submit-web-article-button').click();
    await expect(app.window.getByTestId('import-web-article-modal')).toBeHidden({ timeout: 30_000 });
    const documents = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    const imported = documents.find((candidate) => candidate.source?.url === CHART_ARTICLE_URL);
    expect(imported).toBeDefined();
    const remote: string[] = [];
    app.window.on('request', (request) => {
      if (/^https?:/.test(request.url())) remote.push(request.url());
    });
    for (let pass = 0; pass < 2; pass += 1) {
      await app.window.getByTestId(`read-doc-${imported!.id}`).click();
      await expect(app.window.locator('img.markdown-image')).toHaveCount(CHART_URLS.length);
      await app.window.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('img.markdown-image')]
        .every((image) => image.complete && image.naturalWidth > 0));
      const states = await app.window.locator('img.markdown-image').evaluateAll((images) => images.map((image) => ({
        src: image.getAttribute('src'), width: (image as HTMLImageElement).naturalWidth,
      })));
      expect(states.every((image) => image.src?.startsWith('interleaf-media:') && image.width > 0)).toBe(true);
      if (pass === 0) {
        await returnToLibrary(app);
        await app.electronApp.evaluate(() => { globalThis.__interleafWebMediaFixtures = {}; });
        await app.window.context().setOffline(true);
      }
    }
    expect(remote).toEqual([]);
  } finally {
    await app.close();
  }
});
