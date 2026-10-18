import { InterleafError } from '@shared/errors/interleaf-error';
import { admitRasterBytes, MAX_MEDIA_BYTES } from './web-media-fetcher';
import type {
  FetchedWebMedia,
  WebMediaTransport,
  WebMediaTransportOptions,
} from './web-media-transport';

/**
 * Deterministic image transport for automated tests.
 *
 * End-to-end runs must never contact a real host, but they still need to prove
 * that a real image ends up in managed storage, is served through a capability
 * URL, and survives a reopen with networking off. This replaces only the
 * socket: the harness registers base64 image bytes for public-looking URLs, and
 * the *same* admission check the live fetcher applies — magic bytes, declared
 * type agreement, dimension and pixel bounds — still runs, so a fixture cannot
 * smuggle in something the production path would refuse.
 *
 * It is constructed only when `INTERLEAF_TEST_SEAM=1` in an unpackaged build,
 * the same gate the fake AI provider and the fixture page transport use, so no
 * shipped application can reach it.
 */

export type WebMediaFixture = {
  /** Base64 image bytes, so a fixture can travel through the harness as text. */
  readonly base64: string;
  readonly contentType: string;
  /** Simulated post-redirect URL; defaults to the requested URL. */
  readonly finalUrl?: string;
};

type FixtureRegistry = Record<string, WebMediaFixture>;


declare global {
  /**
   * The registry lives on the global object so the harness driving the run and
   * this transport share one instance across module graphs. Declaring it here
   * gives that global a name and a type instead of reaching through an
   * assertion.
   */
  var __interleafWebMediaFixtures: FixtureRegistry | undefined;
}

function fixtures(): FixtureRegistry {
  globalThis.__interleafWebMediaFixtures ??= {};
  return globalThis.__interleafWebMediaFixtures;
}

/** Registers fixture image bytes for a URL. Called from the test harness in main. */
export function registerWebMediaFixture(url: string, fixture: WebMediaFixture): void {
  fixtures()[url] = fixture;
}

export class TestWebMediaTransport implements WebMediaTransport {
  async fetchImage(url: string, options?: WebMediaTransportOptions): Promise<FetchedWebMedia> {
    if (options?.signal?.aborted) {
      throw new InterleafError(
        'validation',
        'That page took too long to respond, so Interleaf stopped waiting.'
      );
    }
    const fixture = fixtures()[url];
    if (fixture === undefined) {
      throw new InterleafError('validation', 'Interleaf could not reach that website.');
    }
    const bytes = Buffer.from(fixture.base64, 'base64');
    try {
      const maxBytes = Math.min(options?.maxTransferBytes ?? MAX_MEDIA_BYTES, MAX_MEDIA_BYTES);
      return {
        ...(await admitRasterBytes(bytes, fixture.contentType, maxBytes)),
        finalUrl: fixture.finalUrl ?? url,
      };
    } finally {
      // A fixture "arrives" whole, so it costs its full size whether or not it
      // is admitted — the same accounting the live transport reports.
      options?.onWireBytes?.(bytes.byteLength);
    }
  }
}
