import { makePng } from './raster-fixtures';

export const CHART_ARTICLE_URL = 'https://example.com/research/charts/';
const CHART_SOURCES = ['fig1.png', 'fig2.png', 'fig3.png', 'side_by_side1.png', 'side_by_side2.png', 'fig4.png', 'fig5.png', 'fig6.png', 'fig7.png', 'fig8.png', 'online1.png', 'online2.png'];
export const CHART_URLS = CHART_SOURCES.map((src) => new URL(src, CHART_ARTICLE_URL).href);
export const CHART_CAPTIONS = CHART_SOURCES.slice(0, 10).map((src, index) =>
  `Figure: Study ${src} ${'Measurements compare independent trials, with each trial using the same controlled procedure. '.repeat(index === 1 ? 8 : 1).trim()}`
);

export function chartArticleHtml(): string {
  const figure = (index: number): string => {
    const src = CHART_SOURCES[index];
    const caption = CHART_CAPTIONS[index];
    if (src === undefined || caption === undefined) throw new Error('Invalid chart fixture index');
    const explanation = caption.slice(`Figure: Study ${src} `.length);
    return `<p align="center"><img width="${index % 2 === 0 ? '99' : '50'}%" src="${src}" /></p><p><em>Figure: <strong>Study ${src}</strong> ${explanation}</em></p>`;
  };
  const prose = '<p>We compare independent experimental measurements, across several controlled trials, to explain which changes improve the results. These observations form the argument of this research report rather than unrelated page furniture.</p>';
  return `<!doctype html><html><head><title>Controlled chart study</title></head><body><div class="markdown-body"><h1>Controlled chart study</h1>${prose}${figure(0)}${figure(1)}${figure(2)}<details><summary>See examples</summary>${figure(3)}${figure(4)}</details>${prose}${[5, 6, 7, 8, 9].map(figure).join('')}<h2>Online measurements</h2>${prose}<p align="center"><img width="50%" src="online1.png"/><img width="50%" src="online2.png"/></p>${prose}</div></body></html>`;
}

export function chartMediaFixtures(): Record<string, { base64: string; contentType: string }> {
  return Object.fromEntries(CHART_URLS.map((url, index) => [url, {
    base64: makePng(240, 140, [index * 20, 90, 160]).toString('base64'),
    contentType: 'image/png',
  }]));
}
