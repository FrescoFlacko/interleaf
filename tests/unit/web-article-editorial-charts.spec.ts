import { describe, expect, it } from 'vitest';
import { extractArticleInWorker } from '@main/workers/article-extract-worker';
import { articleImageSources } from '@main/library/article-markdown';
import { CHART_ARTICLE_URL, CHART_CAPTIONS, CHART_URLS, chartArticleHtml } from '../fixtures/editorial-charts-fixture';

describe('editorial image-only paragraphs', () => {
  it('retains twelve undescribed figures, including details and paired charts, in source order', async () => {
    const article = await extractArticleInWorker(chartArticleHtml(), CHART_ARTICLE_URL);
    expect(articleImageSources(article)).toEqual(CHART_URLS);
    const prose = article.blocks.flatMap((block) =>
      block.type === 'paragraph' || block.type === 'caption' ? [block.inline.map((run) => run.text).join('')] : []
    );
    for (const caption of CHART_CAPTIONS) expect(prose.filter((text) => text === caption)).toHaveLength(1);
  });

  it('does not promote decorative, hidden, small, unsafe, active or unrelated images', async () => {
    const rejected = [
      '<p align="center"><img src="empty.png" alt=""/></p>',
      '<p align="center"><img src="present.png" role="presentation"/></p>',
      '<p align="center"><img src="hidden.png" aria-hidden="true"/></p>',
      '<p align="center"><img src="pixel.png" width="1"/></p>',
      '<p align="center"><img src="small.png" width="20" height="20"/></p>',
      '<p align="center"><img src="icon.png"/></p>',
      '<p align="center"><img src="vector.svg"/></p>',
      '<p align="center"><img src="javascript:alert(1)"/></p>',
      '<p align="center"><img src="data:image/png;base64,AAAA"/></p>',
      '<p align="center"><img src="copy.png"/>Ordinary adjacent body copy.</p>',
      '<p><img src="uncentered.png"/></p>',
      '<div class="related-posts"><p align="center"><img src="related.png"/></p></div>',
      '<aside><p align="center"><img src="sidebar.png"/></p></aside>',
      '<iframe><p align="center"><img src="frame.png"/></p></iframe>',
      '<video src="movie.mp4"></video><canvas></canvas><svg><image href="active.png"/></svg>',
    ].join('');
    const html = chartArticleHtml().replace('</body>', `${rejected}</body>`);
    const article = await extractArticleInWorker(html, CHART_ARTICLE_URL);
    expect(articleImageSources(article)).toEqual(CHART_URLS);
  });

  it('does not mistake percentage dimensions for tracker pixel dimensions', async () => {
    const html = chartArticleHtml().replace('width="99%"', 'width="1%" height="1%"');
    const article = await extractArticleInWorker(html, CHART_ARTICLE_URL);
    expect(articleImageSources(article)).toEqual(CHART_URLS);
  });
});
