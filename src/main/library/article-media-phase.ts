import type { Logger } from '../logging/logger';
import type { WebMediaTransport } from '../net/web-media-transport';
import type { ExtractedArticle } from './article-content';
import { collectArticleMedia, MEDIA_PHASE_TIMEOUT_MS, type CollectedArticleMedia } from './article-media';
import { articleImageSources } from './article-markdown';

/**
 * The image half of a web import, kept apart from the page half.
 *
 * An import is two phases with different failure meanings: the page either
 * arrives or the import fails, whereas images are optional decoration whose
 * absence degrades an article to alt text rather than losing it. Holding that
 * asymmetry here means the extra time images are allowed is a property of this
 * phase rather than a term in the import's deadline arithmetic.
 */

export type ArticleMediaPhaseDeps = {
  readonly transport: WebMediaTransport;
  readonly log: Logger;
  readonly timeoutMs?: number;
};

export class ArticleMediaPhase {
  private readonly transport: WebMediaTransport;
  private readonly log: Logger;
  /**
   * Time this phase may take beyond the page deadline, zero when disabled.
   *
   * Images get their own allowance rather than sharing the page budget, so a
   * slow page costs the reader waiting time and not the article's
   * illustrations.
   */
  readonly extraTimeMs: number;

  constructor(deps: ArticleMediaPhaseDeps) {
    this.transport = deps.transport;
    this.log = deps.log;
    this.extraTimeMs = deps.timeoutMs ?? MEDIA_PHASE_TIMEOUT_MS;
  }

  /**
   * Archives the images the rendered snapshot will refer to.
   *
   * The source list comes from the same block walk that renders, so an image
   * cannot be fetched that the article would not display, and no reference can
   * appear in the snapshot that was never offered by the page.
   *
   * This is also the one place the two kinds of loss are added together: the
   * pictures extraction never admitted, counted by the worker, and the ones this
   * phase could not archive. Downstream sees a single honest total.
   */
  async collect(
    article: ExtractedArticle,
    deadline: number,
    signal: AbortSignal
  ): Promise<CollectedArticleMedia> {
    const beforeCollection = article.imagesOmitted ?? 0;
    const sources = articleImageSources(article);
    // An article with no images at all takes the same path; collection returns
    // an empty result without asking the transport for anything.
    const collected = await collectArticleMedia(
      sources,
      { transport: this.transport, log: this.log },
      { signal, deadline }
    );
    return { ...collected, omitted: collected.omitted + beforeCollection };
  }
}
