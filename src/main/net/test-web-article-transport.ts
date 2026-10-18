import { InterleafError } from '@shared/errors/interleaf-error';
import type { FetchedWebPage, WebArticleTransport, WebArticleTransportOptions } from './web-article-transport';

/**
 * Deterministic transport for automated tests.
 *
 * End-to-end runs must never contact a real website, but they still need to
 * exercise the real URL policy, the real extraction worker, and the real
 * storage and database path. This transport replaces only the socket: the
 * harness registers fixture HTML for public-looking URLs, and everything before
 * and after the fetch — address validation, redirect rules, extraction bounds,
 * ingestion, dedupe — runs exactly as it does in production.
 *
 * It is constructed only when `INTERLEAF_TEST_SEAM=1` in an unpackaged build,
 * the same gate the fake AI provider uses, so no shipped application can reach
 * it.
 */

type WebArticleFixture = {
  readonly html: string;
  /** Simulated post-redirect URL; defaults to the requested URL. */
  readonly finalUrl?: string;
};

type FixtureRegistry = Record<string, WebArticleFixture>;


declare global {
  /**
   * The registry lives on the global object so the harness driving the run and
   * this transport share one instance across module graphs. Declaring it here
   * gives that global a name and a type instead of reaching through an
   * assertion.
   */
  var __interleafWebArticleFixtures: FixtureRegistry | undefined;
}

function fixtures(): FixtureRegistry {
  globalThis.__interleafWebArticleFixtures ??= {};
  return globalThis.__interleafWebArticleFixtures;
}

export class TestWebArticleTransport implements WebArticleTransport {
  fetchArticleHtml(url: string, options?: WebArticleTransportOptions): Promise<FetchedWebPage> {
    if (options?.signal?.aborted) {
      return Promise.reject(
        new InterleafError('validation', 'That page took too long to respond, so Interleaf stopped waiting.')
      );
    }
    const fixture = fixtures()[url];
    if (fixture === undefined) {
      return Promise.reject(
        new InterleafError('validation', 'Interleaf could not reach that website.')
      );
    }
    return Promise.resolve({
      html: fixture.html,
      finalUrl: fixture.finalUrl ?? url,
      transferredBytes: Buffer.byteLength(fixture.html, 'utf8'),
    });
  }
}
